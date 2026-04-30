# Rate limiting & bot-detection guards

Engineering-level guide for `lockedout`. For background, threat model, and source citations see the research doc at `~/workspace/writing/research/2026-04-29_linkedin-cli-skill-research.md` §11.

## TL;DR

LinkedIn doesn't have a clean "N requests per minute" limit. It has **behavioral fingerprinting**. The single biggest detection vector is **uniform delays between actions** ("heartbeats"). Everything in this doc is in service of one rule:

> Never look like a script that runs on a fixed cadence.

## What v0.1.0 already has (ported from stickerdaniel)

| Guard | Where | Behavior |
|---|---|---|
| `NAV_DELAY_MS = 2000` | `src/lib/extractor.ts` | Fixed 2 s sleep between sections of a multi-section scrape |
| `RATE_LIMIT_RETRY_DELAY_MS = 5000` | `src/lib/extractor.ts` | Fixed 5 s backoff before a single retry on soft rate limit |
| `detectRateLimit()` | `src/lib/utils.ts` | Throws `RateLimitError` on `/checkpoint`/`/authwall`, or on error pages with throttle phrases |
| `RATE_LIMITED_MSG` sentinel | `src/lib/extractor.ts` | When a page returns only chrome (sidebar/footer noise, no real content), the section is marked rate-limited and retried once |
| Auth-barrier detection | `src/lib/auth.ts` | `detectAuthBarrier{,Quick}` throws `AuthenticationError` when `/login`, `/authwall`, etc. is reached |

These are **necessary but insufficient.** They handle hard signals (LinkedIn says "you're blocked"). They do nothing for the dominant threat: behavioral patterns.

## Roadmap (v0.2.0+)

Ordered by ROI. Ship 1+2+4 first — kills the heartbeat pattern, hard-caps daily exposure, stops cascading mistakes after a warning. ~4 hours of work.

### 1. Jittered delays (CRITICAL — must ship before any wider use)

**Problem:** `NAV_DELAY_MS = 2000` and `scrollToBottom`'s `pauseSeconds = 0.5` are fixed constants. Every nav is exactly 2.0 s apart, every scroll exactly 0.5 s apart. That's the textbook heartbeat pattern.

**Fix:** introduce a `jitter(min, max)` helper in `src/lib/utils.ts` and replace every hard-coded sleep with a randomized one.

```ts
// src/lib/utils.ts
export function jitterMs(minMs: number, maxMs: number): number {
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}
export const sleepJitter = (minMs: number, maxMs: number) =>
  sleep(jitterMs(minMs, maxMs));
```

**Replacements:**

| Constant | Before | After |
|---|---|---|
| `NAV_DELAY_MS` | `await sleep(2000)` | `await sleepJitter(1500, 3500)` |
| `RATE_LIMIT_RETRY_DELAY_MS` | `await sleep(5000)` | `await sleepJitter(4000, 7000)` |
| `scrollToBottom` pause | `pauseSeconds = 0.5` (fixed) | jitter 0.3–0.8 s per scroll iteration |
| "Show more" click pause | `await sleep(1000)` | `await sleepJitter(700, 1500)` |
| Activity-feed scroll pause | `pauseSeconds = 1.0` | jitter 0.7–1.4 s |

**Estimated effort:** 30 min. **Estimated detection-risk reduction:** very large; this is the dominant signal.

### 2. Daily quota tracker

**Goal:** soft-cap actions per UTC day. Default 40/day (well under the 50–100 free-account threshold). First 14 days after install: 50/day combined actions (the "warm-up period").

**Storage:** `~/.lockedout/usage.json`

```json
{
  "first_run_utc": "2026-04-29T14:32:11Z",
  "actions": [
    { "ts": "2026-04-29T14:32:55Z", "kind": "profile", "target": "satyanadella" },
    { "ts": "2026-04-29T14:34:02Z", "kind": "profile", "target": "lucasygu" }
  ],
  "cooldown_until": null
}
```

**Action kinds:** `profile`, `status`, `login`. `status` and `login` are exempt from the daily cap (they're maintenance, not scraping). Future: `company`, `job`, `search-people`.

**API in `src/lib/usage.ts` (new file):**

```ts
export interface UsageRecord { ts: string; kind: string; target?: string }
export interface UsageState {
  first_run_utc: string;
  actions: UsageRecord[];
  cooldown_until: string | null;
}

export function loadUsage(): UsageState
export function saveUsage(state: UsageState): void
export function recordAction(kind: string, target?: string): void

/** Returns null if allowed, or a string explaining why blocked. */
export function checkDailyQuota(opts: { force?: boolean }): string | null
```

**Cap logic:**
- Today's UTC date → count actions in `actions[]` matching that day
- If first run was < 14 days ago: cap = 50
- Else: cap = 40 (configurable via env `LOCKEDOUT_DAILY_CAP`)
- If exceeded and `--force` not passed → block with clear message + UTC reset time

**CLI integration:**
- Add `--force` flag to `profile` (and any future scrape commands)
- Add `lockedout usage` command to print today's count + cap + cooldown status

**Estimated effort:** 2 h.

### 3. Per-session burst cap

**Goal:** prevent a single CLI invocation from doing more than N profiles. Mostly relevant when we add bulk commands later (e.g. `lockedout search-people --keywords ... --limit 50`).

**v0.2.0:** not strictly needed — `profile` is one profile per invocation. Add when first bulk command lands.

### 4. Cooldown circuit-breaker

**Goal:** on the *first* hard signal (`RateLimitError` or `AuthenticationError`), write a 30-min cooldown timestamp. Refuse to run scrape commands until that passes. Forces the user to slow down before LinkedIn escalates from soft signal → 24-72h restriction.

**Storage:** same `~/.lockedout/usage.json`, the `cooldown_until` field.

**API:**

```ts
export function setCooldown(minutes = 30): void
export function getCooldownRemainingMs(): number  // 0 if not in cooldown
```

**Wire-up in `src/cli.ts`:**

```ts
function preflight(): void {
  const remaining = getCooldownRemainingMs();
  if (remaining > 0) {
    const mins = Math.ceil(remaining / 60000);
    console.error(kleur.yellow(`Cooldown active: ${mins} min remaining. Wait or run: lockedout cooldown clear`));
    process.exit(1);
  }
}
```

Call `preflight()` at the top of every scrape command (not `login`/`status`/`logout`).

In `handleError()`, if the error is `RateLimitError` or `AuthenticationError`: call `setCooldown(30)` before exiting.

Add a `lockedout cooldown clear` escape hatch (for when the user knows the cooldown is overcautious).

**Estimated effort:** 1 h.

### 5. First-14-days ramp

Bundled into (2) — quota cap is tighter for the first 14 days post-install based on `first_run_utc`.

### 6. Warm-up navigation

Port stickerdaniel's `warm_up_browser`: before the first LinkedIn nav of a `BrowserManager` lifecycle, visit one of `{https://www.google.com, https://www.wikipedia.org, https://www.github.com}` (random pick) and pause 0.5–1.5 s. Marginal value but cheap.

**Where:** `src/lib/browser.ts`, in `BrowserManager.start()` after the first page is created.

**Effort:** 30 min.

### 7. Activity-hours guard

If `new Date().getHours()` is in `[0, 6)` local time, log a yellow warning ("Running scrapes during local sleep hours can flag the account as bot-like"). Don't block — user may have legitimate reasons.

**Effort:** 15 min.

### 8. Mouse jitter on scroll (deferred)

Add small random mouse movements during `scrollToBottom`. Patchright has a `humanization-playwright` companion library that does Bezier-curve mouse paths. Worth investigating if we ever go beyond a few hundred profiles/week.

**Effort:** 2–3 h. Defer.

## Implementation order for v0.2.0

```
v0.2.0 (~4 h total):
  1. Add jitterMs / sleepJitter to utils.ts                          [30 min]
  2. Replace fixed sleeps in extractor.ts with jittered versions      [30 min]
  3. Add src/lib/usage.ts (load/save/record/checkDailyQuota)         [1 h]
  4. Wire preflight into cli.ts; add --force; add `lockedout usage`   [45 min]
  5. Add cooldown setter + getter to usage.ts                         [30 min]
  6. Wire cooldown into handleError + add `lockedout cooldown clear`  [30 min]
  7. Update README with the new behavior                              [15 min]
```

Defer 6/7/8 from the priority list to v0.3.0 unless they become signal-driven.

## Operational notes

- **Why UTC-day boundaries instead of local-day?** Local-day boundaries reset the quota when the user travels. UTC is consistent.
- **Why expose `--force`?** Because the user may know better than we do (e.g. they explicitly want to read 5 colleagues' profiles in a meeting prep). Hard-blocking would be infantilizing. Soft-block + override is the right shape.
- **Why 30-min cooldown specifically?** Long enough that a transient signal (e.g. one bad page) clears; short enough that a determined user isn't locked out for the day.
- **Why no hourly cap?** Daily cap + jittered delays + sequential CLI = the natural per-hour rate is already low. Adding an hourly cap is friction without proportional benefit.

## What we are NOT going to do

- **Proxies / IP rotation.** That's bot infrastructure for commercial scrapers. We're a single-user tool — using your home IP that LinkedIn already associates with you is the *correct* behavior.
- **CAPTCHA solving.** If LinkedIn shows a captcha, we surface it; we don't try to defeat it.
- **Account multi-tenancy.** One `~/.lockedout/profile/` per machine. Multi-account is out of scope.
- **Replacing Patchright stealth with our own.** Patchright maintainer has 6+ years on this; we ride upstream.
