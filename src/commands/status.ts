import kleur from "kleur";
import { existsSync } from "node:fs";
import { withPage } from "../lib/browser.js";
import { PROFILE_DIR } from "../lib/paths.js";

const FEED_URL = "https://www.linkedin.com/feed/";

export async function statusCommand(opts: { json?: boolean } = {}): Promise<void> {
  if (!existsSync(PROFILE_DIR)) {
    const out = { logged_in: false, message: "No profile yet. Run: lockedout login" };
    console.log(opts.json ? JSON.stringify(out) : kleur.yellow(out.message));
    process.exitCode = 1;
    return;
  }

  const result = await withPage(async (page) => {
    await page.goto(FEED_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const url = page.url();
    if (/\/feed\//.test(url)) {
      const name = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>(
          'a[data-test-app-aware-link][href*="/in/"] .t-bold, .feed-identity-module__actor-meta .t-bold',
        );
        return el?.innerText?.trim() ?? null;
      });
      return { logged_in: true, profile: name, url };
    }
    return { logged_in: false, url, message: "Redirected away from /feed/. Re-login needed." };
  }, { headless: true });

  if (opts.json) {
    console.log(JSON.stringify(result));
  } else if (result.logged_in) {
    console.log(kleur.green("✓ Logged in"), result.profile ? kleur.dim(`(${result.profile})`) : "");
  } else {
    console.log(kleur.yellow("✗ Not logged in"), kleur.dim(result.message ?? ""));
    process.exitCode = 1;
  }
}
