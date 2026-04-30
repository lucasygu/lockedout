import type { Page } from "patchright";
import { AuthenticationError, sleep } from "./utils.js";

const AUTH_BLOCKER_PATHS = [
  "/login",
  "/authwall",
  "/checkpoint",
  "/challenge",
  "/uas/login",
  "/uas/consumer-email-challenge",
];

const LOGIN_TITLE_PATTERNS = ["linkedin login", "sign in | linkedin"];

const AUTH_BARRIER_TEXT_MARKERS: string[][] = [
  ["welcome back", "sign in using another account"],
  ["welcome back", "join now"],
  ["choose an account", "sign in using another account"],
  ["continue as", "sign in using another account"],
];

const REMEMBER_ME_CONTAINER = "#rememberme-div";
const REMEMBER_ME_BUTTON = "#rememberme-div button";

function isAuthBlockerUrl(url: string): boolean {
  let path = "/";
  try {
    path = new URL(url).pathname || "/";
  } catch {
    return false;
  }
  if (AUTH_BLOCKER_PATHS.includes(path)) return true;
  return AUTH_BLOCKER_PATHS.some((p) => path === `${p}/` || path.startsWith(`${p}/`));
}

/**
 * Three-tier login probe. Mirrors core/auth.py:is_logged_in.
 * 1. Fail fast on auth-blocker URLs.
 * 2. Look for nav anchors that only render to authenticated users.
 * 3. URL fallback for /feed-style pages.
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    if (isAuthBlockerUrl(url)) return false;

    const oldSelectors = '.global-nav__primary-link, [data-control-name="nav.settings"]';
    const newSelectors =
      'nav a[href*="/feed"], nav button:has-text("Home"), nav a[href*="/mynetwork"]';
    const oldCount = await page.locator(oldSelectors).count();
    const newCount = await page.locator(newSelectors).count();
    const hasNav = oldCount > 0 || newCount > 0;

    const authedPaths = ["/feed", "/mynetwork", "/messaging", "/notifications"];
    const isAuthedPage = authedPaths.some((p) => url.includes(p));
    if (!isAuthedPage) return hasNav;
    if (hasNav) return true;

    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    return typeof bodyText === "string" && bodyText.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Detect login/account-picker barriers. Returns a marker string when blocked,
 * or null when the page looks fine.
 */
export async function detectAuthBarrier(
  page: Page,
  { includeBodyText = true }: { includeBodyText?: boolean } = {},
): Promise<string | null> {
  try {
    const url = page.url();
    if (isAuthBlockerUrl(url)) return `auth blocker URL: ${url}`;

    let title = "";
    try {
      title = ((await page.title()) || "").trim().toLowerCase();
    } catch {
      // ignore
    }
    if (LOGIN_TITLE_PATTERNS.some((p) => title.includes(p))) {
      return `login title: ${title}`;
    }

    if (!includeBodyText) return null;

    let bodyText = "";
    try {
      bodyText = await page.evaluate(() => document.body?.innerText || "");
    } catch {
      bodyText = "";
    }
    const normalized = bodyText.replace(/\s+/g, " ").trim().toLowerCase();
    for (const markers of AUTH_BARRIER_TEXT_MARKERS) {
      if (markers.every((m) => normalized.includes(m))) {
        return `auth barrier text: ${markers.join(" + ")}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function detectAuthBarrierQuick(page: Page): Promise<string | null> {
  return detectAuthBarrier(page, { includeBodyText: false });
}

/** Click LinkedIn's saved-account "remember me" chooser if it's blocking the page. */
export async function resolveRememberMePrompt(page: Page): Promise<boolean> {
  try {
    try {
      await page.waitForSelector(REMEMBER_ME_CONTAINER, { timeout: 3000 });
    } catch {
      return false;
    }

    const target = page.locator(REMEMBER_ME_BUTTON).first();
    if ((await page.locator(REMEMBER_ME_BUTTON).count()) === 0) return false;

    try {
      await target.waitFor({ state: "visible", timeout: 3000 });
    } catch {
      return false;
    }

    try {
      await target.scrollIntoViewIfNeeded({ timeout: 3000 });
    } catch {
      // ignore
    }

    try {
      await target.click({ timeout: 5000 });
    } catch {
      try {
        await target.click({ timeout: 5000, force: true });
      } catch {
        return false;
      }
    }

    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 10000 });
    } catch {
      // ignore
    }
    await sleep(1000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Block until manual login completes or timeout. Polls every second; resolves
 * the saved-account chooser opportunistically.
 */
export async function waitForManualLogin(
  page: Page,
  timeoutMs = 5 * 60 * 1000,
): Promise<void> {
  const start = Date.now();
  while (true) {
    if (await resolveRememberMePrompt(page)) {
      if (Date.now() - start > timeoutMs) {
        throw new AuthenticationError("Manual login timeout.");
      }
      continue;
    }
    if (await isLoggedIn(page)) return;
    if (Date.now() - start > timeoutMs) {
      throw new AuthenticationError("Manual login timeout.");
    }
    await sleep(1000);
  }
}
