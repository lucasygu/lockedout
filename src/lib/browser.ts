import { mkdirSync, chmodSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, type BrowserContext, type Page } from "patchright";
import { LOCKEDOUT_HOME, PROFILE_DIR, COOKIES_FILE } from "./paths.js";
import { warmUpNavigation } from "./utils.js";

export interface BrowserOptions {
  headless?: boolean;
  slowMo?: number;
  viewport?: { width: number; height: number };
  userAgent?: string;
  /**
   * If true, navigate to a random non-LinkedIn warm-up domain before the
   * caller's first goto. Mimics arriving from a search result rather than
   * cold-starting straight into linkedin.com. Best-effort; never throws.
   */
  warmUp?: boolean;
}

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function secureMkdir(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (process.platform !== "win32") {
    try {
      chmodSync(path, PRIVATE_DIR_MODE);
    } catch {
      // ignore
    }
  }
}

/**
 * Async-disposable wrapper around a Patchright persistent context.
 * Mirrors core/browser.py:BrowserManager.
 *
 * Session persistence is automatic — cookies, localStorage, and IndexedDB
 * live in `user_data_dir`. Cookie export/import is provided as a recovery
 * tool for cross-machine bridging, NOT as primary auth.
 */
export class BrowserManager {
  private readonly userDataDir: string;
  private readonly headless: boolean;
  private readonly slowMo: number;
  private readonly viewport: { width: number; height: number };
  private readonly userAgent: string | undefined;

  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly warmUp: boolean;

  constructor(opts: BrowserOptions = {}) {
    this.userDataDir = PROFILE_DIR;
    this.headless = opts.headless ?? true;
    this.slowMo = opts.slowMo ?? 0;
    this.viewport = opts.viewport ?? { width: 1280, height: 720 };
    this.userAgent = opts.userAgent;
    this.warmUp = opts.warmUp ?? false;
  }

  async start(): Promise<void> {
    if (this.context) throw new Error("Browser already started. Call close() first.");
    secureMkdir(LOCKEDOUT_HOME);
    secureMkdir(this.userDataDir);

    this.context = await chromium.launchPersistentContext(this.userDataDir, {
      headless: this.headless,
      slowMo: this.slowMo,
      viewport: this.viewport,
      locale: "en-US",
      ...(this.userAgent ? { userAgent: this.userAgent } : {}),
    });

    const pages = this.context.pages();
    this.page = pages[0] ?? (await this.context.newPage());

    if (this.warmUp) {
      await warmUpNavigation(this.page);
    }
  }

  async close(): Promise<void> {
    const ctx = this.context;
    this.context = null;
    this.page = null;
    if (ctx) {
      try {
        await ctx.close();
      } catch {
        // ignore
      }
    }
  }

  getPage(): Page {
    if (!this.page) throw new Error("Browser not started. Call start() first.");
    return this.page;
  }

  getContext(): BrowserContext {
    if (!this.context) throw new Error("Browser context not initialized.");
    return this.context;
  }

  async exportCookies(path = COOKIES_FILE): Promise<boolean> {
    if (!this.context) return false;
    try {
      const all = await this.context.cookies();
      const linkedinCookies = all
        .filter((c) => (c.domain ?? "").includes("linkedin.com"))
        .map(normalizeCookieDomain);
      secureMkdir(dirname(path));
      writeFileSync(path, JSON.stringify(linkedinCookies, null, 2), { mode: PRIVATE_FILE_MODE });
      if (process.platform !== "win32") {
        try {
          chmodSync(path, PRIVATE_FILE_MODE);
        } catch {
          // ignore
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  async importCookies(path = COOKIES_FILE): Promise<boolean> {
    if (!this.context) return false;
    if (!existsSync(path)) return false;
    try {
      const all = JSON.parse(readFileSync(path, "utf-8")) as Array<Record<string, unknown>>;
      if (!Array.isArray(all) || all.length === 0) return false;
      const filtered = all
        .filter((c) => typeof c.domain === "string" && c.domain.includes("linkedin.com"))
        .filter((c) => BRIDGE_COOKIE_NAMES.has(String(c.name)))
        .map(normalizeCookieDomain);
      const hasLiAt = filtered.some((c) => c.name === "li_at");
      if (!hasLiAt) return false;
      // patchright/playwright accepts an array of plain cookie objects
      await this.context.addCookies(filtered as never);
      return true;
    } catch {
      return false;
    }
  }
}

const BRIDGE_COOKIE_NAMES = new Set([
  "li_at",
  "JSESSIONID",
  "bcookie",
  "bscookie",
  "lidc",
]);

function normalizeCookieDomain<T extends { domain?: string }>(cookie: T): T {
  const domain = cookie.domain ?? "";
  if (domain === ".www.linkedin.com" || domain === "www.linkedin.com") {
    return { ...cookie, domain: ".linkedin.com" };
  }
  return cookie;
}

/** Convenience: run a function with a started BrowserManager and always clean up. */
export async function withBrowser<T>(
  fn: (page: Page, mgr: BrowserManager) => Promise<T>,
  opts: BrowserOptions = {},
): Promise<T> {
  const mgr = new BrowserManager(opts);
  await mgr.start();
  try {
    return await fn(mgr.getPage(), mgr);
  } finally {
    await mgr.close();
  }
}
