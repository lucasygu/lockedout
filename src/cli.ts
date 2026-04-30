#!/usr/bin/env node

/**
 * lockedout — LinkedIn from the command line.
 *
 * Usage:
 *   lockedout login                     # Headed Chromium, 5-min window for 2FA/captcha
 *   lockedout status [--json]           # Verify the persistent session is alive
 *   lockedout logout                    # Clear ~/.lockedout/
 *   lockedout profile <user> [opts]     # Scrape a profile via innerText
 */

import { Command } from "commander";
import kleur from "kleur";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BrowserManager, withBrowser } from "./lib/browser.js";
import { isLoggedIn, waitForManualLogin } from "./lib/auth.js";
import { ensureChromium } from "./lib/install.js";
import { renderDoctorReport, runDoctor } from "./lib/doctor.js";
import { LinkedInExtractor } from "./lib/extractor.js";
import { parsePersonSections, PERSON_SECTIONS } from "./lib/fields.js";
import { LOCKEDOUT_HOME, PROFILE_DIR } from "./lib/paths.js";
import { AuthenticationError, RateLimitError } from "./lib/utils.js";
import {
  checkDailyQuota,
  clearCooldown,
  getCooldownRemainingMs,
  recordAction,
  setCooldown,
  summarizeUsage,
} from "./lib/usage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const program = new Command();
program
  .name("lockedout")
  .description("LinkedIn from the command line — via a persistent stealth browser session.")
  .version(pkg.version);

function output(data: unknown, json: boolean): void {
  if (json) console.log(JSON.stringify(data, null, 2));
  else console.log(data);
}

function handleError(err: unknown): never {
  if (err instanceof AuthenticationError || err instanceof RateLimitError) {
    setCooldown(30);
    const label = err instanceof AuthenticationError ? "Auth" : "Rate limit";
    const color = err instanceof AuthenticationError ? kleur.red : kleur.yellow;
    console.error(color(`${label}: ${err.message}`));
    console.error(
      kleur.dim("Cooldown enabled (30 min). Override with: lockedout cooldown clear"),
    );
  } else if (err instanceof Error) {
    console.error(kleur.red(`Error: ${err.message}`));
  } else {
    console.error(kleur.red("Unknown error"));
  }
  process.exit(1);
}

/** Refuse to run scrape commands while a cooldown is active. */
function preflight(): void {
  const remaining = getCooldownRemainingMs();
  if (remaining <= 0) return;
  const mins = Math.ceil(remaining / 60_000);
  console.error(
    kleur.yellow(`Cooldown active: ${mins} min remaining.`),
    kleur.dim("Run: lockedout cooldown clear"),
  );
  process.exit(1);
}

function normalizeUsername(input: string): string {
  const trimmed = input.trim();
  const m = trimmed.match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (m) return decodeURIComponent(m[1]!);
  return trimmed.replace(/^\/+|\/+$/g, "");
}

// ─── login ──────────────────────────────────────────────────────────────────

program
  .command("login")
  .description("Open a Chromium window and sign in to LinkedIn manually (cookies persist).")
  .action(async () => {
    try {
      await ensureChromium();
      console.log(kleur.cyan("Opening Chromium for LinkedIn login..."));
      console.log(kleur.dim("You have 5 minutes to sign in (2FA / captcha OK)."));
      console.log(kleur.dim("The window closes automatically once you reach the feed.\n"));
      await withBrowser(
        async (page) => {
          await page.goto("https://www.linkedin.com/login", {
            waitUntil: "domcontentloaded",
          });
          await waitForManualLogin(page);
          console.log(kleur.green("✓ Logged in. Session saved to ~/.lockedout/profile/"));
        },
        { headless: false },
      );
    } catch (err) {
      handleError(err);
    }
  });

// ─── status ─────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Check whether the local session is still logged in.")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    if (!existsSync(PROFILE_DIR)) {
      const out = { logged_in: false, message: "No profile yet. Run: lockedout login" };
      if (opts.json) output(out, true);
      else console.log(kleur.yellow(out.message));
      process.exit(1);
    }
    try {
      await ensureChromium();
      const result = await withBrowser(
        async (page) => {
          await page.goto("https://www.linkedin.com/feed/", {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          const ok = await isLoggedIn(page);
          return { logged_in: ok, url: page.url() };
        },
        { headless: true },
      );
      if (opts.json) {
        output(result, true);
      } else if (result.logged_in) {
        console.log(kleur.green("✓ Logged in"));
      } else {
        console.log(
          kleur.yellow("✗ Not logged in"),
          kleur.dim(`(redirected to ${result.url})`),
        );
        process.exit(1);
      }
    } catch (err) {
      handleError(err);
    }
  });

// ─── logout ─────────────────────────────────────────────────────────────────

program
  .command("logout")
  .description("Delete the local session (clears ~/.lockedout/).")
  .action(async () => {
    if (!existsSync(LOCKEDOUT_HOME)) {
      console.log(kleur.dim("Already logged out."));
      return;
    }
    rmSync(LOCKEDOUT_HOME, { recursive: true, force: true });
    console.log(kleur.green("✓ Cleared ~/.lockedout/"));
  });

// ─── profile ────────────────────────────────────────────────────────────────

const profileCmd = program
  .command("profile <username>")
  .description("Scrape a LinkedIn profile (slug or full /in/<slug>/ URL).")
  .option(
    "--sections <list>",
    `Comma-separated sections to fetch (default: main_profile only). Available: ${Object.keys(
      PERSON_SECTIONS,
    )
      .filter((n) => !PERSON_SECTIONS[n]![1])
      .join(", ")}`,
  )
  .option("--max-scrolls <n>", "Max scroll attempts per page (default 5)", (v) => parseInt(v, 10))
  .option("--pretty", "Render readable text (default)")
  .option("--json", "Output as JSON")
  .option("--force", "Bypass the daily quota cap");

profileCmd.action(async (username: string, opts) => {
  try {
    preflight();
    await ensureChromium();
    const slug = normalizeUsername(username);
    if (!slug) {
      console.error(kleur.red("Username is required (slug or /in/ URL)."));
      process.exit(1);
    }

    const quota = checkDailyQuota({ force: Boolean(opts.force) });
    if (quota.blocked) {
      console.error(kleur.yellow(quota.reason!));
      process.exit(1);
    }

    const { requested, unknown } = parsePersonSections(opts.sections);
    if (unknown.length > 0) {
      console.error(
        kleur.yellow(`Ignoring unknown sections: ${unknown.join(", ")}`),
      );
    }

    recordAction("profile", slug);

    const result = await withBrowser(
      async (page) => {
        const extractor = new LinkedInExtractor(page);
        return extractor.scrapePerson(
          slug,
          requested,
          typeof opts.maxScrolls === "number" ? opts.maxScrolls : null,
        );
      },
      { headless: true },
    );

    if (opts.json) {
      output(result, true);
      return;
    }

    console.log(kleur.bold(result.url));
    for (const [name, text] of Object.entries(result.sections)) {
      console.log("");
      console.log(kleur.cyan(`── ${name} ──`));
      console.log(text);
    }
    if (result.section_errors) {
      console.log("");
      console.log(kleur.yellow("Errors:"));
      for (const [name, err] of Object.entries(result.section_errors)) {
        console.log(kleur.dim(`  ${name}: ${err.message}`));
      }
    }
  } catch (err) {
    handleError(err);
  }
});

// ─── doctor ─────────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description(
    "Run end-to-end self-checks: Node, Patchright, Chromium, profile, session, quota, cooldown, skill symlink.",
  )
  .option("--json", "Output as JSON")
  .option("--quick", "Skip the headless session probe (faster, no browser launch)")
  .action(async (opts) => {
    const report = await runDoctor({ quick: Boolean(opts.quick) });
    if (opts.json) {
      output(report, true);
    } else {
      console.log(renderDoctorReport(report));
      console.log("");
      if (report.ok) {
        console.log(kleur.green("✓ All checks passed."));
      } else {
        const failed = report.checks.filter((c) => c.status !== "ok").length;
        console.log(kleur.yellow(`⚠ ${failed} check(s) need attention.`));
      }
    }
    process.exit(report.ok ? 0 : 1);
  });

// ─── usage ──────────────────────────────────────────────────────────────────

program
  .command("usage")
  .description("Show today's scrape count, daily cap, and cooldown status.")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const summary = summarizeUsage();
    if (opts.json) {
      output(summary, true);
      return;
    }
    const remaining = summary.cap - summary.today_count;
    console.log(
      `${kleur.bold(`${summary.today_count}/${summary.cap}`)} actions today` +
        (summary.is_warmup ? kleur.dim(" (first-14-days warm-up cap)") : ""),
    );
    console.log(kleur.dim(`Remaining: ${Math.max(0, remaining)}`));
    if (summary.cooldown_remaining_minutes > 0) {
      console.log(
        kleur.yellow(`Cooldown: ${summary.cooldown_remaining_minutes} min remaining`),
      );
    }
  });

// ─── cooldown ───────────────────────────────────────────────────────────────

const cooldownCmd = program.command("cooldown").description("Manage the rate-limit cooldown.");

cooldownCmd
  .command("status")
  .description("Show remaining cooldown time.")
  .action(() => {
    const ms = getCooldownRemainingMs();
    if (ms <= 0) {
      console.log(kleur.green("✓ No active cooldown."));
      return;
    }
    console.log(kleur.yellow(`Cooldown: ${Math.ceil(ms / 60_000)} min remaining`));
  });

cooldownCmd
  .command("clear")
  .description("Clear an active cooldown (use only if you know it was overcautious).")
  .action(() => {
    clearCooldown();
    console.log(kleur.green("✓ Cooldown cleared."));
  });

program.parseAsync().catch((err) => {
  handleError(err);
});

// Ensure no orphan browser processes if commander is invoked without a command.
void BrowserManager;
