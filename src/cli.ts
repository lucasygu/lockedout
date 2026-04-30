#!/usr/bin/env node

/**
 * lockedout — Node CLI for LinkedIn via persistent stealth browser session.
 *
 * Usage:
 *   lockedout login              # First-time browser login (5-min window for 2FA)
 *   lockedout status             # Check if session is alive
 *   lockedout logout             # Clear local session
 *   lockedout profile <user>     # Read a profile (slug or full URL)
 */

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loginCommand } from "./commands/login.js";
import { statusCommand } from "./commands/status.js";
import { logoutCommand } from "./commands/logout.js";
import { profileCommand } from "./commands/profile.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const program = new Command();

program
  .name("lockedout")
  .description("LinkedIn from the command line — via a real persistent browser session.")
  .version(pkg.version);

program
  .command("login")
  .description("Open a browser and log in to LinkedIn manually (cookies persist).")
  .action(async () => {
    await loginCommand();
  });

program
  .command("status")
  .description("Check whether the local session is still logged in.")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    await statusCommand(opts);
  });

program
  .command("logout")
  .description("Clear the local session.")
  .action(async () => {
    await logoutCommand();
  });

program
  .command("profile <username>")
  .description("Read a LinkedIn profile (slug like 'satyanadella' or a full /in/ URL).")
  .option("--pretty", "Human-readable output")
  .option("--json", "Pretty-print JSON")
  .option("--max-scrolls <n>", "How many viewport-scrolls to load lazy sections (default 5)", (v) => parseInt(v, 10))
  .action(async (username: string, opts) => {
    try {
      await profileCommand(username, opts);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
