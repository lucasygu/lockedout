import type { Page } from "patchright";

export class RateLimitError extends Error {
  suggestedWaitSeconds: number;
  constructor(message: string, suggestedWaitSeconds = 30) {
    super(message);
    this.name = "RateLimitError";
    this.suggestedWaitSeconds = suggestedWaitSeconds;
  }
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class LinkedInScraperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkedInScraperError";
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Random integer in [minMs, maxMs). */
export function jitterMs(minMs: number, maxMs: number): number {
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}

/** Sleep for a random duration in [minMs, maxMs). Defeats LinkedIn's "heartbeat" detection. */
export const sleepJitter = (minMs: number, maxMs: number) => sleep(jitterMs(minMs, maxMs));

/**
 * Detect rate-limit / security challenge. Mirrors core/utils.py:detect_rate_limit.
 * Throws RateLimitError on /checkpoint or /authwall, or on error-shaped pages
 * (no <main>, body text < 2000 chars) containing throttle phrases.
 */
export async function detectRateLimit(page: Page): Promise<void> {
  const url = page.url();
  if (url.includes("linkedin.com/checkpoint") || url.includes("authwall")) {
    throw new RateLimitError(
      "LinkedIn security checkpoint detected. You may need to verify your identity or wait before continuing.",
    );
  }

  try {
    const hasMain = (await page.locator("main").count()) > 0;
    if (hasMain) return;
    const bodyText = await page.locator("body").innerText({ timeout: 1000 });
    if (bodyText && bodyText.length < 2000) {
      const lower = bodyText.toLowerCase();
      const phrases = ["too many requests", "rate limit", "slow down", "try again later"];
      if (phrases.some((p) => lower.includes(p))) {
        throw new RateLimitError("Rate limit message detected on page.");
      }
    }
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    // Timeout / other transient: ignore — not rate limited.
  }
}

/**
 * Scroll the document to the bottom repeatedly to trigger lazy load.
 * `pauseRangeMs` is a [min, max] tuple — each iteration sleeps a random duration
 * within the range, breaking the uniform-cadence detection signal.
 */
export async function scrollToBottom(
  page: Page,
  pauseRangeMs: readonly [number, number] = [300, 800],
  maxScrolls = 10,
): Promise<void> {
  for (let i = 0; i < maxScrolls; i++) {
    const prev = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleepJitter(pauseRangeMs[0], pauseRangeMs[1]);
    const next = await page.evaluate(() => document.body.scrollHeight);
    if (next === prev) return;
  }
}

/** Best-effort dismissal of artdeco modals. Returns true if a modal was closed. */
export async function handleModalClose(page: Page): Promise<boolean> {
  try {
    const close = page
      .locator(
        'button[aria-label="Dismiss"], button[aria-label="Close"], button.artdeco-modal__dismiss',
      )
      .first();
    if (await close.isVisible({ timeout: 1000 })) {
      await close.click();
      await sleep(500);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

// ─── LinkedIn page-chrome noise stripping ──────────────────────────────────

const NOISE_MARKERS: RegExp[] = [
  /^About\n+(?:Accessibility|Talent Solutions)/m,
  /^More profiles for you$/m,
  /^Explore premium profiles$/m,
  /^Get up to .+ replies when you message with InMail$/m,
  /^(?:Careers|Privacy & Terms|Questions\?|Select language)\n+(?:Privacy & Terms|Questions\?|Select language|Advertising|Ad Choices|[A-Za-z]+ \([A-Za-z]+\))/m,
];

const NOISE_LINES: RegExp[] = [
  /^(?:Play|Pause|Playback speed|Turn fullscreen on|Fullscreen)$/,
  /^(?:Show captions|Close modal window|Media player modal window)$/,
  /^(?:Loaded:.*|Remaining time.*|Stream Type.*)$/,
];

export function truncateLinkedInNoise(text: string): string {
  let earliest = text.length;
  for (const pat of NOISE_MARKERS) {
    const m = pat.exec(text);
    if (m && m.index < earliest) earliest = m.index;
  }
  return text.slice(0, earliest).trim();
}

export function filterLinkedInNoiseLines(text: string): string {
  const filtered = text
    .split("\n")
    .filter((line) => !NOISE_LINES.some((p) => p.test(line.trim())));
  return filtered.join("\n").trim();
}

export function stripLinkedInNoise(text: string): string {
  return filterLinkedInNoiseLines(truncateLinkedInNoise(text));
}
