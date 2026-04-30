import type { Page } from "patchright";
import {
  detectAuthBarrier,
  detectAuthBarrierQuick,
  resolveRememberMePrompt,
} from "./auth.js";
import { PERSON_SECTIONS } from "./fields.js";
import {
  AuthenticationError,
  LinkedInScraperError,
  RateLimitError,
  detectRateLimit,
  filterLinkedInNoiseLines,
  handleModalClose,
  scrollToBottom,
  sleepJitter,
  truncateLinkedInNoise,
} from "./utils.js";

// Jittered ranges, not fixed values — uniform delays are LinkedIn's #1 bot signal.
// See docs/rate-limiting.md.
const NAV_DELAY_RANGE_MS: readonly [number, number] = [1500, 3500];
const RATE_LIMIT_RETRY_RANGE_MS: readonly [number, number] = [4000, 7000];
const SHOW_MORE_PAUSE_MS: readonly [number, number] = [700, 1500];
const STATIC_SCROLL_PAUSE_MS: readonly [number, number] = [300, 800];
const ACTIVITY_SCROLL_PAUSE_MS: readonly [number, number] = [700, 1400];
const RATE_LIMITED_MSG =
  "[Rate limited] LinkedIn blocked this section. Try again later or request fewer sections.";

export interface Reference {
  href: string;
  text: string;
  aria_label?: string;
  title?: string;
  heading?: string;
}

export interface ExtractedSection {
  text: string;
  references: Reference[];
  error?: { message: string };
}

export interface PersonProfile {
  url: string;
  sections: Record<string, string>;
  references?: Record<string, Reference[]>;
  section_errors?: Record<string, { message: string }>;
}

interface RootExtractResult {
  text: string;
  references: Array<{
    href: string;
    text: string;
    aria_label: string;
    title: string;
    heading: string;
  }>;
}

/**
 * LinkedIn extractor — innerText-based, not selector-based.
 * Ported from stickerdaniel/linkedin-mcp-server scraping/extractor.py.
 *
 * v0 scope: person profile only (skips overlay sections, URN, debug-trace).
 */
export class LinkedInExtractor {
  constructor(private readonly page: Page) {}

  /** Navigate with auth-barrier checks and one remember-me retry. */
  private async navigate(url: string, allowRememberMe = true): Promise<void> {
    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (err) {
      if (allowRememberMe && (await resolveRememberMePrompt(this.page))) {
        await this.navigate(url, false);
        return;
      }
      const barrier = await detectAuthBarrier(this.page);
      if (barrier) {
        throw new AuthenticationError(
          "LinkedIn requires interactive re-authentication. Run: lockedout login",
        );
      }
      throw err;
    }

    const barrier = await detectAuthBarrierQuick(this.page);
    if (!barrier) return;

    if (allowRememberMe && (await resolveRememberMePrompt(this.page))) {
      await this.navigate(url, false);
      return;
    }

    throw new AuthenticationError(
      "LinkedIn requires interactive re-authentication. Run: lockedout login",
    );
  }

  /**
   * Single attempt: navigate, dismiss modals, scroll/click "Show more", extract.
   * Returns RATE_LIMITED_MSG when the page returns only chrome.
   */
  private async extractPageOnce(
    url: string,
    maxScrolls: number | null,
  ): Promise<ExtractedSection> {
    await this.navigate(url);
    await detectRateLimit(this.page);

    try {
      await this.page.waitForSelector("main", { timeout: 5000 });
    } catch {
      // ignore
    }

    await handleModalClose(this.page);

    const isActivity = url.includes("/recent-activity/");
    if (isActivity) {
      try {
        await this.page.waitForFunction(
          () => {
            const main = document.querySelector("main");
            if (!main) return false;
            return ((main as HTMLElement).innerText || "").length > 200;
          },
          undefined,
          { timeout: 10000 },
        );
      } catch {
        // ignore
      }
    }

    const isSearch = url.includes("/search/results/");
    if (isSearch) {
      try {
        await this.page.waitForFunction(
          () => {
            const main = document.querySelector("main");
            if (!main) return false;
            return ((main as HTMLElement).innerText || "").length > 100;
          },
          undefined,
          { timeout: 10000 },
        );
      } catch {
        // ignore
      }
    }

    const isDetails = url.includes("/details/");
    if (isDetails) {
      try {
        await this.page.waitForFunction(
          () => {
            const main = document.querySelector("main");
            if (!main) return false;
            const text = ((main as HTMLElement).innerText || "").replace(/^\s+/, "");
            return (
              !text.startsWith("Load more") &&
              !text.startsWith("More profiles for you") &&
              !text.startsWith("Explore premium profiles")
            );
          },
          undefined,
          { timeout: 10000 },
        );
      } catch {
        // ignore
      }

      const maxClicks = maxScrolls ?? 5;
      for (let i = 0; i < maxClicks; i++) {
        const button = this.page
          .locator("main button")
          .filter({ hasText: /^Show (more|all)\b/i });
        try {
          if ((await button.count()) === 0) break;
          const target = button.first();
          if (!(await target.isVisible())) break;
          await target.scrollIntoViewIfNeeded({ timeout: 2000 });
          await target.click({ timeout: 2000 });
          await sleepJitter(SHOW_MORE_PAUSE_MS[0], SHOW_MORE_PAUSE_MS[1]);
        } catch {
          break;
        }
      }
    }

    if (isActivity) {
      await scrollToBottom(this.page, ACTIVITY_SCROLL_PAUSE_MS, maxScrolls ?? 10);
    } else {
      await scrollToBottom(this.page, STATIC_SCROLL_PAUSE_MS, maxScrolls ?? 5);
    }

    const raw = await this.extractRootContent(["main"]);
    if (!raw.text) return { text: "", references: [] };
    const truncated = truncateLinkedInNoise(raw.text);
    if (!truncated && raw.text.trim()) {
      return { text: RATE_LIMITED_MSG, references: [] };
    }
    return {
      text: filterLinkedInNoiseLines(truncated),
      references: raw.references.map((r) => ({
        href: r.href,
        text: r.text,
        ...(r.aria_label ? { aria_label: r.aria_label } : {}),
        ...(r.title ? { title: r.title } : {}),
        ...(r.heading ? { heading: r.heading } : {}),
      })),
    };
  }

  /** Extract a page with one rate-limit retry. */
  async extractPage(url: string, maxScrolls: number | null): Promise<ExtractedSection> {
    try {
      const first = await this.extractPageOnce(url, maxScrolls);
      if (first.text !== RATE_LIMITED_MSG) return first;
      await sleepJitter(RATE_LIMIT_RETRY_RANGE_MS[0], RATE_LIMIT_RETRY_RANGE_MS[1]);
      return await this.extractPageOnce(url, maxScrolls);
    } catch (e) {
      if (
        e instanceof AuthenticationError ||
        e instanceof RateLimitError ||
        e instanceof LinkedInScraperError
      ) {
        throw e;
      }
      const message = e instanceof Error ? e.message : String(e);
      return { text: "", references: [], error: { message } };
    }
  }

  /**
   * Run the JS extractor inside the page. Returns innerText + a flat list of
   * anchor metadata enriched with the nearest heading. Mirrors
   * extractor.py:_extract_root_content.
   */
  private async extractRootContent(selectors: string[]): Promise<RootExtractResult> {
    return this.page.evaluate(({ selectors: sel }: { selectors: string[] }) => {
      const normalize = (value: string | null | undefined) =>
        (value || "").replace(/\s+/g, " ").trim();
      const containerSelector = "section, article, li, div";
      const headingSelector = "h1, h2, h3";
      const directHeadingSelector = ":scope > h1, :scope > h2, :scope > h3";
      const MAX_HEADING_CONTAINERS = 300;
      const MAX_REFERENCE_ANCHORS = 500;

      const getHeadingText = (element: Element | null): string => {
        if (!element) return "";
        const heading = element.matches?.(headingSelector)
          ? (element as HTMLElement)
          : (element.querySelector?.(directHeadingSelector) as HTMLElement | null);
        return normalize(heading?.innerText || heading?.textContent);
      };

      const getPreviousHeading = (node: Element | null): string => {
        let sibling = node?.previousElementSibling || null;
        for (let i = 0; sibling && i < 3; i += 1) {
          const heading = getHeadingText(sibling);
          if (heading) return heading;
          sibling = sibling.previousElementSibling;
        }
        return "";
      };

      const root = sel.map((s) => document.querySelector(s)).find(Boolean) as Element | null;
      const container = (root || document.body) as HTMLElement | null;
      const text = container ? (container.innerText || "").trim() : "";
      const headingMap = new WeakMap<Element, string>();

      const candidates: Element[] = container
        ? [container, ...Array.from(container.querySelectorAll(containerSelector)).slice(0, MAX_HEADING_CONTAINERS)]
        : [];
      candidates.forEach((node) => {
        const ownHeading = getHeadingText(node);
        const previousHeading = getPreviousHeading(node);
        const heading = ownHeading || previousHeading;
        if (heading) headingMap.set(node, heading);
      });

      const findHeading = (element: Element): string => {
        let current: Element | null = element.closest(containerSelector) || container;
        for (let depth = 0; current && depth < 4; depth += 1) {
          const heading = headingMap.get(current);
          if (heading) return heading;
          if (current === container) break;
          current = current.parentElement?.closest(containerSelector) || null;
        }
        return "";
      };

      if (!container) return { text: "", references: [] };

      const references = Array.from(container.querySelectorAll("a[href]"))
        .slice(0, MAX_REFERENCE_ANCHORS)
        .map((anchor) => {
          const a = anchor as HTMLAnchorElement;
          const rawHref = (a.getAttribute("href") || "").trim();
          if (!rawHref || rawHref === "#") return null;
          const href = rawHref.startsWith("#") ? rawHref : a.href || rawHref;
          return {
            href,
            text: normalize(a.innerText || a.textContent),
            aria_label: normalize(a.getAttribute("aria-label")),
            title: normalize(a.getAttribute("title")),
            heading: findHeading(a),
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      return { text, references };
    }, { selectors });
  }

  /**
   * Scrape a person profile across the requested sections. Skips overlay
   * sections (e.g. contact_info) in v0.
   */
  async scrapePerson(
    username: string,
    requested: Set<string>,
    maxScrolls: number | null = null,
  ): Promise<PersonProfile> {
    const reqAll = new Set(requested);
    reqAll.add("main_profile");
    const baseUrl = `https://www.linkedin.com/in/${username}`;
    const sections: Record<string, string> = {};
    const references: Record<string, Reference[]> = {};
    const sectionErrors: Record<string, { message: string }> = {};

    const ordered = Object.entries(PERSON_SECTIONS).filter(([name]) => reqAll.has(name));

    for (let i = 0; i < ordered.length; i++) {
      const [name, [suffix, isOverlay]] = ordered[i] as [string, [string, boolean]];
      if (isOverlay) continue; // v0: skip overlay sections
      if (i > 0) await sleepJitter(NAV_DELAY_RANGE_MS[0], NAV_DELAY_RANGE_MS[1]);

      const url = baseUrl + suffix;
      try {
        const extracted = await this.extractPage(url, maxScrolls);
        if (extracted.text && extracted.text !== RATE_LIMITED_MSG) {
          sections[name] = extracted.text;
          if (extracted.references.length > 0) references[name] = extracted.references;
        } else if (extracted.error) {
          sectionErrors[name] = extracted.error;
        }
      } catch (e) {
        if (e instanceof AuthenticationError || e instanceof RateLimitError) throw e;
        const message = e instanceof Error ? e.message : String(e);
        sectionErrors[name] = { message };
      }
    }

    const result: PersonProfile = {
      url: `${baseUrl}/`,
      sections,
    };
    if (Object.keys(references).length > 0) result.references = references;
    if (Object.keys(sectionErrors).length > 0) result.section_errors = sectionErrors;
    return result;
  }
}
