import kleur from "kleur";
import { withPage } from "../lib/browser.js";

const LOGIN_URL = "https://www.linkedin.com/login";
const FEED_URL = "https://www.linkedin.com/feed/";
const TIMEOUT_MS = 5 * 60 * 1000;

export async function loginCommand(): Promise<void> {
  console.log(kleur.cyan("Opening Chromium for LinkedIn login..."));
  console.log(kleur.dim("You have 5 minutes to sign in (2FA / captcha OK)."));
  console.log(kleur.dim("The window will close automatically once you reach the feed.\n"));

  await withPage(async (page) => {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForURL(/\/feed\//, { timeout: TIMEOUT_MS });
      console.log(kleur.green("✓ Logged in. Session saved to ~/.lockedout/profile/"));
    } catch {
      console.error(kleur.red("✗ Did not reach the feed within 5 minutes."));
      console.error(kleur.dim("If you completed login, run: lockedout status"));
      process.exitCode = 1;
    }
  }, { headless: false });
}
