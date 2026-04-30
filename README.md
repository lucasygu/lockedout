# lockedout

Node CLI for LinkedIn — read profiles, posts, companies, jobs, and search via a persistent stealth browser session. Built on [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright).

> **Why "lockedout"?** Because LinkedIn locks bots out — fast and aggressively. Cookie-only API tools (`@bcharleson/linkedincli`, `tomquirk/linkedin-api`) get sessions revoked within 1–2 calls thanks to LinkedIn's BrowserGate fingerprint scoring + missing companion cookies. `lockedout` runs a real, persistent Chromium session via Patchright so LinkedIn's own JS generates the auth cookies and fingerprint headers — same as your daily browser.

## Status

🚧 Pre-alpha. Active development. Not on npm yet.

## Install

```bash
# Once published:
npm install -g @lucasygu/lockedout

# For now, from source:
git clone https://github.com/lucasygu/lockedout.git
cd lockedout
npm install
npm run build
npm link
```

## Quick start

```bash
# First-time login — opens a real Chromium window, you sign in by hand (2FA OK)
lockedout login

# Verify the session is alive
lockedout status

# Read a profile
lockedout profile satyanadella --pretty
```

The browser profile lives at `~/.lockedout/profile/` and persists across runs. Re-login only when LinkedIn flags the session.

## Architecture

- **Patchright** stealth Chromium with a persistent `user_data_dir`
- LinkedIn's own JS runs in the page → all cookies (`li_at`, `lidc`, `bcookie`, etc.) and the encrypted APFC fingerprint header are real, not forged
- Scraping reads `innerText` from the rendered DOM, not CSS selectors → resilient to LinkedIn UI churn
- Output is structured JSON (`--pretty` for human-readable)

## License

MIT © 2026 Lucas Gu
