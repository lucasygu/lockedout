import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isLoggedIn } from "./auth.js";
import { withBrowser } from "./browser.js";
import { chromiumCacheDir, chromiumLikelyInstalled } from "./install.js";
import { LOCKEDOUT_HOME, PROFILE_DIR } from "./paths.js";
import { getCooldownRemainingMs, summarizeUsage } from "./usage.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  cli_version: string;
  checks: CheckResult[];
  ok: boolean;
}

const REQUIRED_NODE_MAJOR = 22;
const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..", "..");

function ok(name: string, detail: string): CheckResult {
  return { name, status: "ok", detail };
}
function warn(name: string, detail: string): CheckResult {
  return { name, status: "warn", detail };
}
function fail(name: string, detail: string): CheckResult {
  return { name, status: "fail", detail };
}

function readPackageJson(path: string): { version?: string; name?: string } {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function ourVersion(): string {
  return readPackageJson(join(PACKAGE_ROOT, "package.json")).version ?? "unknown";
}

function patchrightVersion(): string | null {
  // Walk up from PACKAGE_ROOT looking for node_modules/patchright/package.json.
  // npm hoisting can put it at our package root or one level up.
  const candidates = [
    join(PACKAGE_ROOT, "node_modules", "patchright", "package.json"),
    join(PACKAGE_ROOT, "..", "patchright", "package.json"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      const v = readPackageJson(path).version;
      if (v) return v.replace(/^v/, "");
    }
  }
  return null;
}

function checkNode(): CheckResult {
  const v = process.version.replace(/^v/, "");
  const major = parseInt(v.split(".")[0]!, 10);
  return major >= REQUIRED_NODE_MAJOR
    ? ok("Node.js", `${v} (>= ${REQUIRED_NODE_MAJOR} required)`)
    : fail("Node.js", `${v} — required: >= ${REQUIRED_NODE_MAJOR}`);
}

function checkPatchright(): CheckResult {
  const v = patchrightVersion();
  return v
    ? ok("Patchright", `v${v} installed`)
    : fail("Patchright", "Not found in node_modules — try reinstalling the package");
}

function checkChromium(): CheckResult {
  const cacheDir = chromiumCacheDir();
  if (process.env.PLAYWRIGHT_BROWSERS_PATH === "0") {
    return ok("Chromium", "in-tree mode (PLAYWRIGHT_BROWSERS_PATH=0)");
  }
  if (!existsSync(cacheDir)) {
    return warn(
      "Chromium",
      `Cache dir not found: ${cacheDir}. Run 'lockedout login' to download.`,
    );
  }
  if (!chromiumLikelyInstalled()) {
    return warn(
      "Chromium",
      `No chromium-* dir in ${cacheDir}. Run 'lockedout login' to download.`,
    );
  }
  return ok("Chromium", `cached at ${cacheDir}`);
}

function checkProfileDir(): CheckResult {
  if (!existsSync(LOCKEDOUT_HOME)) {
    return warn("Profile dir", `${LOCKEDOUT_HOME} does not exist — run 'lockedout login'`);
  }
  if (!existsSync(PROFILE_DIR)) {
    return warn(
      "Profile dir",
      `${PROFILE_DIR} does not exist — run 'lockedout login'`,
    );
  }
  return ok("Profile dir", PROFILE_DIR);
}

async function checkSession(): Promise<CheckResult> {
  if (!existsSync(PROFILE_DIR)) {
    return warn(
      "Session",
      "No profile yet — run 'lockedout login' (skipped, headless probe needs a profile)",
    );
  }
  try {
    const result = await withBrowser(
      async (page) => {
        await page.goto("https://www.linkedin.com/feed/", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        return await isLoggedIn(page);
      },
      { headless: true },
    );
    return result
      ? ok("Session", "logged in (headless probe of /feed/ succeeded)")
      : fail("Session", "Not logged in — run 'lockedout login'");
  } catch (err) {
    return fail(
      "Session",
      `Probe failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function checkQuota(): CheckResult {
  const s = summarizeUsage();
  const tag = s.is_warmup ? " (warm-up cap)" : "";
  return s.today_count >= s.cap
    ? warn("Daily quota", `${s.today_count}/${s.cap} — cap reached${tag}`)
    : ok("Daily quota", `${s.today_count}/${s.cap}${tag}`);
}

function checkCooldown(): CheckResult {
  const ms = getCooldownRemainingMs();
  if (ms <= 0) return ok("Cooldown", "none active");
  const mins = Math.ceil(ms / 60_000);
  return warn("Cooldown", `${mins} min remaining — run 'lockedout cooldown clear' if intentional`);
}

function checkSkillSymlink(): CheckResult {
  const linkPath = join(homedir(), ".claude", "skills", "lockedout");
  let stat;
  try {
    stat = lstatSync(linkPath);
  } catch {
    return warn(
      "Skill symlink",
      `${linkPath} not present — Claude Code won't auto-detect /lockedout`,
    );
  }
  if (!stat.isSymbolicLink()) {
    return warn(
      "Skill symlink",
      `${linkPath} exists but is not a symlink — postinstall did not run`,
    );
  }
  const target = readlinkSync(linkPath);
  if (!existsSync(target)) {
    return fail(
      "Skill symlink",
      `${linkPath} → ${target} (broken — target missing). Reinstall the package.`,
    );
  }
  return ok("Skill symlink", `${linkPath} → ${target}`);
}

function checkCliVersion(): CheckResult {
  return ok("CLI version", ourVersion());
}

const STATUS_GLYPH: Record<CheckStatus, string> = {
  ok: "✓",
  warn: "⚠",
  fail: "✗",
};

export async function runDoctor(opts: { quick?: boolean } = {}): Promise<DoctorReport> {
  const checks: CheckResult[] = [
    checkNode(),
    checkPatchright(),
    checkChromium(),
    checkProfileDir(),
  ];
  if (!opts.quick) checks.push(await checkSession());
  checks.push(checkQuota(), checkCooldown(), checkSkillSymlink(), checkCliVersion());
  const okAll = checks.every((c) => c.status === "ok");
  return { cli_version: ourVersion(), checks, ok: okAll };
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const c of report.checks) {
    lines.push(`${STATUS_GLYPH[c.status]} ${c.name.padEnd(16)} ${c.detail}`);
  }
  return lines.join("\n");
}
