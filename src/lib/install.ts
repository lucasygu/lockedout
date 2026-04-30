import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import kleur from "kleur";

/**
 * Ensure Patchright's Chromium is available before launching the browser.
 *
 * On first scrape, downloads ~150 MB into the user's shared Patchright/Playwright
 * cache (`~/Library/Caches/ms-playwright/` on macOS, etc.). Subsequent calls
 * are silent and zero-overhead.
 *
 * We don't bundle Chromium in the npm package — it would push us past npm's
 * 250 MB hard cap and defeat the shared cache. We don't run the install in
 * postinstall either — `npm install -g` should be fast and quiet, and a
 * 150 MB download silently triggered by `npm install` is hostile UX.
 */
export async function ensureChromium(): Promise<void> {
  if (chromiumLikelyInstalled()) return;

  console.log(kleur.cyan("Setting up Chromium (one-time, ~150 MB)..."));
  console.log(
    kleur.dim(
      "Cached in your shared Playwright/Patchright dir; subsequent runs are instant.",
    ),
  );

  const result = spawnSync("npx", ["patchright", "install", "chromium"], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `Chromium install failed (exit ${result.status}). Run manually: npx patchright install chromium`,
    );
  }
}

export function chromiumCacheDir(): string {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (override && override !== "0") return override;
  return defaultCacheDir();
}

export function chromiumLikelyInstalled(): boolean {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH;

  // In-tree mode — Patchright stores the browser inside node_modules. We
  // can't reliably probe this from outside the package install path, so
  // assume installed and let the launch fail naturally if it isn't.
  if (override === "0") return true;

  const cacheDir = override || defaultCacheDir();
  if (!existsSync(cacheDir)) return false;

  try {
    const entries = readdirSync(cacheDir);
    // Patchright versions Chromium directories like `chromium-1217` and
    // `chromium_headless_shell-1217`. Either is sufficient for our use.
    return entries.some(
      (e) => e.startsWith("chromium-") || e.startsWith("chromium_headless"),
    );
  } catch {
    return false;
  }
}

function defaultCacheDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "ms-playwright");
  }
  if (process.platform === "win32") {
    return join(homedir(), "AppData", "Local", "ms-playwright");
  }
  return join(homedir(), ".cache", "ms-playwright");
}
