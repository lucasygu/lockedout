# Packaging & release

Engineering-level guide for publishing `@lucasygu/lockedout` to npm. For background and rationale see the research doc at `~/workspace/writing/research/2026-04-29_linkedin-cli-skill-research.md` §12.

## Architecture

Three coupled pieces, all required:

```
@lucasygu/lockedout (npm package)
├── bin: { "lockedout": "dist/cli.js" }     ← global CLI on PATH
├── scripts/postinstall.js                   ← creates skill symlink
└── SKILL.md (at package root)              ← Claude Code reads this via the symlink
```

`npm install -g @lucasygu/lockedout` triggers postinstall, which symlinks `~/.claude/skills/lockedout → <package-root>`. Claude Code scans `~/.claude/skills/`, follows the symlink, reads `SKILL.md`'s YAML frontmatter, registers `/lockedout` as a slash command. No additional registration step.

## Chromium handling — lazy download, never bundle

We ship **zero browser bytes** in the npm package (current pack: 27.6 kB / 106.8 kB unpacked). Chromium is downloaded on demand into the user's shared Patchright/Playwright cache.

**Cache locations (default):**
- macOS: `~/Library/Caches/ms-playwright/`
- Linux: `~/.cache/ms-playwright/`
- Windows: `%USERPROFILE%\AppData\Local\ms-playwright\`

**Override:** users can set `PLAYWRIGHT_BROWSERS_PATH=/custom/path` and Patchright will respect it. We pass through transparently — no code needed on our side.

**Why not bundle:** npm has a 250 MB hard cap; Chromium is ~280 MB extracted. Bundling is literally unpublishable and would defeat the shared cache.

**Why not postinstall download:** `npm install -g` should be fast and quiet. Postinstall failure (corp proxy, no network) would prevent install of a CLI that doesn't even need Chromium for `--help`/`logout`/cooldown commands.

## v0.3.0 implementation

Four steps. Build them in order.

### Step A — `src/lib/install.ts`

```ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import kleur from "kleur";

/**
 * Ensure Patchright Chromium is available. Lazy-installs on first scrape.
 *
 * Detection: cheap existsSync probe on the default cache dir (or whatever
 * PLAYWRIGHT_BROWSERS_PATH points at). Patchright's official check is
 * `registry.validateHostRequirements()` but it's an internal API; the
 * filesystem probe is sufficient for "first run" detection.
 */
export async function ensureChromium(): Promise<void> {
  if (chromiumLikelyInstalled()) return;
  console.log(
    kleur.cyan("Setting up Chromium (one-time, ~150 MB)..."),
  );
  console.log(kleur.dim("Cached in your shared Playwright/Patchright dir."));
  const result = spawnSync("npx", ["patchright", "install", "chromium"], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `Patchright install failed (exit ${result.status}). Try running manually: npx patchright install chromium`,
    );
  }
}

function chromiumLikelyInstalled(): boolean {
  const overridePath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (overridePath === "0") {
    // In-tree mode — Patchright stores the browser inside node_modules.
    // We can't reliably probe this from outside; assume installed and let
    // the launch fail naturally if it isn't.
    return true;
  }
  const cacheDir =
    overridePath ||
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Caches", "ms-playwright")
      : process.platform === "win32"
        ? join(homedir(), "AppData", "Local", "ms-playwright")
        : join(homedir(), ".cache", "ms-playwright"));
  if (!existsSync(cacheDir)) return false;
  // Look for any chromium-* directory (the version suffix changes with each Patchright release).
  try {
    const entries = require("node:fs").readdirSync(cacheDir);
    return entries.some(
      (e: string) => e.startsWith("chromium-") || e.startsWith("chromium_headless"),
    );
  } catch {
    return false;
  }
}
```

**Wire into commands** that open a browser. Top of `login`, `status` (when it does the headless feed-load probe), `profile`:

```ts
// src/cli.ts
import { ensureChromium } from "./lib/install.js";

profileCmd.action(async (username: string, opts) => {
  try {
    preflight();           // existing cooldown check
    await ensureChromium(); // NEW
    // ... rest of profile logic
```

### Step B — `SKILL.md` at package root

Frontmatter follows Claude Code's skill schema + redbook's OpenClaw extension:

```yaml
---
description: Read LinkedIn profiles, posts, and search results via a stealth browser session — with built-in jittered delays, daily quota, and cooldown safeguards.
allowed-tools: Bash, Read
name: lockedout
version: 0.3.0
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
```

Body sections (target 400–600 lines):

1. **Quick Reference** — command-to-intent table
2. **Commands** — `login`, `status`, `logout`, `profile`, `usage`, `cooldown`
3. **Output Schemas** — what `--json` shapes look like (sections map, references array, section_errors)
4. **Rate-Limit Discipline** — distill `docs/rate-limiting.md`:
   - Default 40/day cap (50 in first 14 days)
   - Cooldown auto-set on `RateLimitError` / `AuthenticationError`
   - When to use `--force` (single-session burst with intent, e.g. meeting prep) vs. when not to (loop iteration)
   - Anti-patterns: don't loop `lockedout profile` in a shell `for` — even with jitter, that's still a heartbeat at the dispatch layer
5. **Error Handling table** — auth barrier, cooldown active, Chromium missing, account warning, network down
6. **Workflow Examples** — natural-language → command translations:
   - "Pull this person's profile" → `lockedout profile <slug> --json`
   - "Get experience and education" → `lockedout profile <slug> --sections experience,education --json`
7. **What's Not Yet Implemented** — explicitly call out missing surface (search-people, company, job, messaging) so Claude doesn't hallucinate commands

### Step C — `README.md` rewrite

English-only. ~150–250 lines. Outline:

```
# lockedout — LinkedIn from the command line

> ### Easiest way to get started
> Paste this to your AI agent (Claude Code, Cursor, Codex, Windsurf):
>
> "Install the @lucasygu/lockedout LinkedIn CLI via npm and run
>  `lockedout login` then `lockedout status` to verify. Repo:
>  https://github.com/lucasygu/lockedout"

## Install

    npm install -g @lucasygu/lockedout

Requires Node.js >= 22. Supports macOS, Linux, Windows.

**First run note:** `lockedout login` will download ~150 MB Chromium
(one-time, cached at `~/Library/Caches/ms-playwright/`, shared across
any Playwright/Patchright tools you have).

## What You Can Do

- **Profile read** — pull anyone's profile sections (experience,
  education, skills, etc.) as structured JSON
- **Session-aware scraping** — uses your real LinkedIn session via a
  stealth Chromium profile; no API keys
- **Built-in safety** — jittered delays, daily quota cap, automatic
  cooldown on rate-limit signals

## Quick Start

    lockedout login                          # one-time browser sign-in
    lockedout status                         # verify session is alive
    lockedout profile satyanadella --json    # read a profile

## Commands

[table — login / status / logout / profile / usage / cooldown]

## Options

### Global Options
[--json, --pretty]

### Profile Options
[--sections, --max-scrolls, --force]

> ⚠️ **Rate limit safety:** LinkedIn detects uniform timing as bot
> behavior. lockedout jitters every delay (1.5–3.5s nav, 0.3–0.8s
> scroll) and caps actions at 40/day (50 during the first 14 days).
> On any rate-limit or auth signal, a 30-min cooldown auto-engages.
> Override with `--force` only when you accept the risk.

## Troubleshooting

[problem → solution table]

## How It Works

- **Patchright** — stealth-patched Playwright fork. Removes
  `--enable-automation`, adds `--disable-blink-features=AutomationControlled`,
  blocks `Runtime.enable` / `Console.enable` leaks
- **Persistent Chromium profile** at `~/.lockedout/profile/` — cookies,
  fingerprint, IndexedDB persist across runs
- **Lazy Chromium download** — first `lockedout login` triggers
  `npx patchright install chromium`; subsequent runs are instant
- **Anti-detection guards** — see `docs/rate-limiting.md`

## AI Agent Integration

### Claude Code

Auto-registers as a skill at install. Use `/lockedout`:

    /lockedout profile satyanadella
    /lockedout status

Or natural-language:
- "Pull Satya Nadella's career history from LinkedIn"
- "Compare these three profiles' education sections"

## Acknowledgments

- [stickerdaniel/linkedin-mcp-server](https://github.com/stickerdaniel/linkedin-mcp-server)
  (Apache-2.0) — the Python MCP we ported to Node/TS. The
  innerText-extraction strategy and the rate-limit detection logic
  are direct ports.
- [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) by
  Kaliiiiiiiiii-Vinyzu — the stealth-patched Playwright fork that
  makes any of this possible.

## Disclaimer

LinkedIn's Terms of Service prohibit automated access. Per 2025–2026
industry data, ~23% of users running automation tools hit account
restrictions within 90 days. lockedout adds jitter, daily quotas, and
cooldown safeguards to reduce that risk, but cannot eliminate it. Use
responsibly. This project is not affiliated with LinkedIn.

## License

MIT
```

### Step D — Release rehearsal (no publish)

```bash
# Bump version
# (edit package.json: 0.2.0 → 0.3.0)

npm run build
npm pack --dry-run | grep "package size\|unpacked size\|total files"
# Confirm: SKILL.md is in the file list, package < 100 kB

npm pack                          # creates lucasygu-lockedout-0.3.0.tgz
npm install -g ./lucasygu-lockedout-0.3.0.tgz

# Smoke tests:
which lockedout                   # → should resolve
ls -la ~/.claude/skills/lockedout # → symlink to the npm install path
lockedout --version               # → 0.3.0
lockedout usage                   # → today's count + cap
lockedout login                   # → if Chromium missing, lazy-download fires

npm uninstall -g @lucasygu/lockedout
ls ~/.claude/skills/lockedout 2>&1   # → "No such file" — preuninstall worked
```

If all green: actual publish via the **npm-publish-cli agent** (per global rule: never `npm publish` directly).

## Operational notes

- **Why `prepublishOnly: npm run build`?** Forces fresh `dist/` on every publish. If a developer forgets to rebuild after a TS change, the published package would still be stale otherwise.
- **Why `files` whitelist instead of `.npmignore`?** Whitelist is opt-in (safer). Forgetting to add a file = it's not shipped (loud failure). With `.npmignore` you can accidentally ship `node_modules/` or secrets.
- **Why postinstall idempotent?** Users running `npm install -g` over an existing install shouldn't see errors. The script checks if the symlink already points at the right place and exits early.
- **Why preuninstall at all?** `npm uninstall -g` doesn't clean `~/.claude/skills/lockedout` automatically — that's outside the package directory. Without preuninstall, the symlink would dangle after uninstall.

## Non-goals for v0.3.0

- **ClawHub registry submission** — defer until v0.3.0 is on npm and we have signal. Higher legal risk than redbook makes registry inclusion uncertain.
- **Chinese README mirror** — defer; LinkedIn audience is global-English.
- **Programmatic API exports** — defer; only consumer is the CLI itself. Add when there's a second consumer.
- **Multi-arch Chromium pinning** — Patchright handles macOS-arm64 / macOS-x64 / Linux / Windows transparently. We don't need to pin.
