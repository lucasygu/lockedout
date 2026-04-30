import { mkdirSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "patchright";
import { PROFILE_DIR } from "./paths.js";

export interface LaunchOptions {
  headless?: boolean;
}

export async function launchPersistentContext(
  opts: LaunchOptions = {},
): Promise<BrowserContext> {
  mkdirSync(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chromium",
    headless: opts.headless ?? false,
    viewport: { width: 1280, height: 900 },
  });
}

export async function withPage<T>(
  fn: (page: Page, ctx: BrowserContext) => Promise<T>,
  opts: LaunchOptions = {},
): Promise<T> {
  const ctx = await launchPersistentContext(opts);
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    return await fn(page, ctx);
  } finally {
    await ctx.close();
  }
}
