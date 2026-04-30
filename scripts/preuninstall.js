#!/usr/bin/env node
/**
 * Pre-uninstall script for lockedout CLI.
 *
 * Removes the Claude Code skill symlink at ~/.claude/skills/lockedout
 * (only if it points to this package).
 */

import { existsSync, unlinkSync, lstatSync, readlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PACKAGE_ROOT = join(__dirname, "..");
const SKILL_LINK = join(homedir(), ".claude", "skills", "lockedout");

function main() {
  console.log("[lockedout] Running pre-uninstall...");

  if (!existsSync(SKILL_LINK)) {
    console.log("[lockedout] No skill symlink found, nothing to clean up.");
    return;
  }

  try {
    const stats = lstatSync(SKILL_LINK);
    if (!stats.isSymbolicLink()) {
      console.log("[lockedout] Skill path is not a symlink, leaving it alone.");
      return;
    }

    const target = readlinkSync(SKILL_LINK);
    if (target === PACKAGE_ROOT || target.includes("node_modules/@lucasygu/lockedout")) {
      unlinkSync(SKILL_LINK);
      console.log("[lockedout] Removed Claude Code skill symlink.");
    } else {
      console.log("[lockedout] Skill symlink points elsewhere, leaving it alone.");
    }
  } catch (error) {
    console.error(`[lockedout] Warning: Could not remove skill: ${error.message}`);
  }

  console.log("[lockedout] Uninstall cleanup complete.");
}

main();
