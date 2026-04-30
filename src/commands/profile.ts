import kleur from "kleur";
import { withPage } from "../lib/browser.js";

const NAV_DELAY_MS = 2_000;

export interface ProfileOptions {
  pretty?: boolean;
  json?: boolean;
  maxScrolls?: number;
}

export async function profileCommand(username: string, opts: ProfileOptions = {}): Promise<void> {
  const target = username.startsWith("http")
    ? username
    : `https://www.linkedin.com/in/${username}/`;

  const result = await withPage(async (page) => {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });

    if (/\/login|\/checkpoint/.test(page.url())) {
      throw new Error("Session expired or challenged. Run: lockedout login");
    }

    const maxScrolls = opts.maxScrolls ?? 5;
    for (let i = 0; i < maxScrolls; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(800);
    }

    const text = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>("main");
      return main?.innerText ?? "";
    });

    await page.waitForTimeout(NAV_DELAY_MS);

    return {
      username,
      url: page.url(),
      fetched_at: new Date().toISOString(),
      raw_text: text,
    };
  }, { headless: true });

  if (opts.pretty) {
    console.log(kleur.bold(`Profile: ${result.username}`));
    console.log(kleur.dim(result.url));
    console.log("");
    console.log(result.raw_text);
  } else {
    console.log(JSON.stringify(result, null, opts.json ? 2 : 0));
  }
}
