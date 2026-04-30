---
description: Read LinkedIn profiles via a stealth Chromium session — with built-in jittered delays, daily quota, and cooldown safeguards. Use for "look up X on LinkedIn", "summarize this person's career", "compare these two profiles", and similar reads.
allowed-tools: Bash, Read
name: lockedout
version: 0.3.1
metadata:
  openclaw:
    requires:
      bins:
        - lockedout
    install:
      - kind: node
        package: "@lucasygu/lockedout"
        bins: [lockedout]
    os: [macos, linux, windows]
    homepage: https://github.com/lucasygu/lockedout
tags:
  - linkedin
  - scraping
  - patchright
  - claude-code-skill
---

# Lockedout — LinkedIn CLI

Use the `lockedout` CLI to read LinkedIn profiles, posts, and recent activity from the terminal. Authenticates via a persistent stealth Chromium session — no API keys, no cookie copying, no third-party scrapers.

## Quick Reference

| Intent | Command |
|---|---|
| First-time sign-in | `lockedout login` |
| Verify session is alive | `lockedout status --json` |
| Read a profile | `lockedout profile <slug-or-url> --json` |
| Read with extra sections | `lockedout profile <slug> --sections experience,education --json` |
| See today's quota usage | `lockedout usage --json` |
| Check / clear cooldown | `lockedout cooldown status` / `lockedout cooldown clear` |
| Sign out / wipe profile | `lockedout logout` |

**Always add `--json` when parsing programmatically.** Without it, output is human-formatted text.

---

## Commands

### `login`

Opens a headed Chromium window pointed at LinkedIn's login page. The user signs in manually (2FA, captcha, account chooser all OK). Once they reach the feed, the window closes and cookies persist to `~/.lockedout/profile/`.

- **First run** triggers a one-time ~150 MB Chromium download into the shared Patchright/Playwright cache. Subsequent runs are instant.
- **Reuse** the same session across runs by simply not running `logout`. Status checks are headless and silent.
- **2FA** prompts work normally. The 5-minute window is generous; if the user takes longer, they get a clear timeout error.

### `status [--json]`

Headless probe: launches Chromium, navigates to `linkedin.com/feed/`, checks for navigation elements only authenticated users see. Returns `logged_in: true|false` plus the final URL.

Use this to decide whether to prompt the user for `lockedout login` before a scrape.

### `logout`

Removes `~/.lockedout/` (the entire persistent profile + usage log). User will need a fresh `login` to scrape again.

### `profile <username> [options]`

Scrape one LinkedIn person profile. The `<username>` argument accepts either a slug (`satyanadella`) or a full URL (`https://www.linkedin.com/in/satyanadella/`).

**Options:**

| Option | Description | Default |
|---|---|---|
| `--sections <list>` | Comma-separated sections to fetch | `main_profile` only |
| `--max-scrolls <n>` | Max scroll attempts per section page | 5 |
| `--json` | Output as JSON | false |
| `--pretty` | Render as readable text (default) | true |
| `--force` | Bypass the daily quota cap | false |

**Available sections:** `main_profile`, `experience`, `education`, `interests`, `honors`, `languages`, `certifications`, `skills`, `projects`, `posts`. (`contact_info` exists but is overlay-only and not yet supported in v0.3.0.)

### `usage [--json]`

Print today's UTC scrape count, daily cap, warm-up status, and cooldown remaining. Use to decide whether the agent has budget for another scrape this session.

### `cooldown status` / `cooldown clear`

`status` shows remaining cooldown time. `clear` removes an active cooldown — only do this when the user has paused long enough or knows the cooldown was overcautious.

---

## Output Schemas

### `profile --json`

```json
{
  "url": "https://www.linkedin.com/in/satyanadella/",
  "sections": {
    "main_profile": "Satya Nadella\n...",
    "experience": "Experience\nChairman and CEO\nMicrosoft\n..."
  },
  "references": {
    "main_profile": [
      { "href": "https://...", "text": "Contact info" },
      { "href": "https://...", "text": "Microsoft" }
    ]
  },
  "section_errors": {
    "skills": { "message": "Section returned only sidebar chrome" }
  }
}
```

- `sections` — innerText per requested section. Already noise-stripped (sidebar/footer chrome removed). Each section is a single string with `\n` separators.
- `references` — flat array of all `<a>` tags found in each section, with the nearest heading inferred. Useful for finding company/person URN links, "Show all" pagination URLs, etc.
- `section_errors` — only present if a section soft-failed. Common cause: LinkedIn rate-limited a single section but not the whole scrape.

### `status --json`

```json
{ "logged_in": true, "url": "https://www.linkedin.com/feed/" }
```

### `usage --json`

```json
{
  "first_run_utc": "2026-04-29T14:32:11.139Z",
  "today_count": 3,
  "cap": 50,
  "is_warmup": true,
  "cooldown_remaining_minutes": 0
}
```

---

## Rate-Limit Discipline

LinkedIn detects automation **behaviorally**, not by hard request counts. The single biggest detection signal is uniform timing between actions. lockedout addresses this with three layered guards:

### 1. Jittered delays (built-in, always on)

Every wait inside the scraper is randomized:

| Operation | Range |
|---|---|
| Inter-section navigation | 1.5 – 3.5 s |
| Rate-limit retry backoff | 4 – 7 s |
| "Show more" click pause | 0.7 – 1.5 s |
| Static-page scroll pause | 0.3 – 0.8 s |
| Activity-feed scroll pause | 0.7 – 1.4 s |

The user cannot disable this. It is intrinsic to the scrape.

### 2. Daily quota (enforced, override with `--force`)

| Phase | Cap |
|---|---|
| First 14 days post-install (warm-up) | 50 actions / UTC day |
| After warm-up | 40 / UTC day (overridable via `LOCKEDOUT_DAILY_CAP` env var) |

Counts only `profile` calls. `status`, `login`, `logout`, `usage`, `cooldown` are exempt — they're maintenance, not scraping.

When the cap is hit, `lockedout profile` refuses to run with a clear error and a UTC reset time. `--force` overrides for one call.

### 3. Cooldown circuit-breaker (auto, manual override)

On any `RateLimitError` (LinkedIn returned `/checkpoint`, `/authwall`, or rate-limit text) or `AuthenticationError` (session burned mid-scrape), lockedout sets a 30-minute cooldown. While the cooldown is active, all scrape commands refuse to run.

Use `lockedout cooldown status` to check remaining time, `lockedout cooldown clear` to escape.

### When to use `--force`

✅ User explicitly wants a single burst (meeting prep: "pull these 5 candidates").
✅ User just bumped the cap and you trust their judgment.
❌ Inside a `for` loop. Even with jitter inside the scrape, dispatching N invocations in quick succession is a heartbeat at the dispatch layer.
❌ Background cron jobs. LinkedIn flags off-hours bursts.

### Anti-patterns

```bash
# ❌ DON'T DO THIS — heartbeat at dispatch layer
for slug in alice bob charlie; do
  lockedout profile $slug --json
done

# ✅ DO THIS — natural pauses + checkpointing
lockedout profile alice --json > alice.json
# (do something with the result, take a breath)
sleep 30
lockedout profile bob --json > bob.json
```

When the user asks for bulk operations, surface the risk + propose batching across days.

---

## Error Handling

| Error | Likely Cause | Resolution |
|---|---|---|
| `Auth: LinkedIn requires interactive re-authentication. Run: lockedout login` | Session expired or LinkedIn issued a remember-me prompt | Run `lockedout login`; cooldown will auto-engage |
| `Rate limit: LinkedIn security checkpoint detected` | LinkedIn served `/checkpoint` or `/authwall` | Wait 30 min for cooldown; do not retry immediately |
| `Cooldown active: N min remaining` | A previous scrape hit a hard signal | Wait, or `lockedout cooldown clear` if intentional |
| `Daily cap reached: N/N. Resets in ~Xh` | Today's quota exhausted | Wait until UTC reset, or use `--force` for one more |
| `Chromium install failed (exit N)` | First-run download failed | Run manually: `npx patchright install chromium` |
| `Setting up Chromium (one-time, ~150 MB)...` | Normal first-run; not an error | Wait for download to complete |
| Section returns empty / `[Rate limited]` text | Soft rate-limit on that section only | Section retried once with backoff; if still empty, will appear in `section_errors` |

---

## Workflow Examples

### "Look up <person> on LinkedIn"

```bash
lockedout status --json   # check session
lockedout profile <slug> --json
```

### "Summarize their career"

```bash
lockedout profile <slug> --sections experience,education --json
```

Then synthesize the `sections.experience` + `sections.education` text. The references array carries deep-links to companies/schools if you want to enrich.

### "Compare these three profiles"

```bash
# Check budget first
lockedout usage --json
# If cap allows:
lockedout profile alice --sections experience,education --json > alice.json
lockedout profile bob   --sections experience,education --json > bob.json
lockedout profile carol --sections experience,education --json > carol.json
```

The CLI itself adds jitter between sections; you should also pause between invocations (manual or wrapped in a script that spaces dispatches).

### "Find their recent posts"

```bash
lockedout profile <slug> --sections posts --json
```

This hits `/recent-activity/all/`. Activity feeds need more scroll budget — pass `--max-scrolls 10` for full results.

### "Check if I'm still logged in"

```bash
lockedout status --json | jq -r '.logged_in'
```

Returns `true` or `false` as a single line.

---

## What's NOT Yet Implemented (v0.3.0)

Don't hallucinate these — they are **planned but not shipped**:

- ❌ `company <slug>` — company profiles (planned for v0.4.0)
- ❌ `job <id>` — job postings
- ❌ `search-people --keywords ...` — people search
- ❌ `search-jobs --keywords ...` — job search
- ❌ `inbox`, `messages`, `send-message` — messaging
- ❌ `connect <slug>` — connection requests
- ❌ `react`, `comment`, `post` — write actions (intentionally deferred; needs the official OAuth API path)
- ❌ `contact_info` overlay section in `profile` — overlay extraction not ported

If the user asks for any of these, say it's not in v0.3.0 yet.

---

## Programmatic API

Not exposed in v0.3.0. The CLI is the only consumer. If a TypeScript caller is needed in the future, `LinkedInExtractor` and `BrowserManager` in `src/lib/` are clean targets — they take a Patchright `Page` / `BrowserContext` directly with no MCP or CLI awareness.

---

## How It Works (one-liner)

`lockedout` runs a real stealth-patched Chromium (via [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)) against LinkedIn, lets the user log in once, then reuses the persistent profile across runs. Page text is extracted via `innerText` (resilient to DOM churn), not CSS selectors. The engine is a Node/TS port of [stickerdaniel/linkedin-mcp-server](https://github.com/stickerdaniel/linkedin-mcp-server)'s person-profile path, with jitter + daily quota + cooldown breaker added.

For deeper architecture see `docs/rate-limiting.md` and `docs/packaging.md` in the repo.

---

## Tips for Analysis

- **Don't over-trust LinkedIn dates.** "Greater Seattle Area" is often the only location. Career timelines have gaps users hide.
- **Sidebar leakage.** `experience`/`education` sometimes contain "Who your viewers also viewed" sidebar text — easily filtered post-hoc by stripping anything after the recognizable section header drops.
- **Self-view vs. other-view.** Your own profile shows Analytics, "Suggested for you", and edit links that don't appear when viewing others. The `references[]` array reveals which: look for `/edit/` URLs.
- **Skills are flaky.** The current `skills` section often returns headers + tabs but not the rows. Known issue; a "Show all" tab click is needed. Until fixed, treat empty skills as "data unavailable", not "user has no skills".
