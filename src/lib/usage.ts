import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { LOCKEDOUT_HOME, USAGE_FILE } from "./paths.js";

/**
 * Action log + cooldown tracker. Persisted to ~/.lockedout/usage.json.
 *
 * Caps:
 * - First 14 days post-install: 50 actions per UTC day (warm-up period)
 * - Otherwise: 40 per UTC day (configurable via LOCKEDOUT_DAILY_CAP env var)
 *
 * Cooldown:
 * - Set on first hard signal (RateLimitError or AuthenticationError)
 * - Default 30 min; refuses scrapes until expired
 */

export interface UsageRecord {
  ts: string; // ISO 8601 UTC
  kind: string;
  target?: string;
}

export interface UsageState {
  first_run_utc: string;
  actions: UsageRecord[];
  cooldown_until: string | null;
}

const DEFAULT_CAP = 40;
const RAMP_CAP = 50;
const RAMP_DAYS = 14;
const COUNTED_KINDS = new Set(["profile"]); // status/login/logout exempt

function emptyState(): UsageState {
  return {
    first_run_utc: new Date().toISOString(),
    actions: [],
    cooldown_until: null,
  };
}

export function loadUsage(): UsageState {
  if (!existsSync(USAGE_FILE)) return emptyState();
  try {
    const raw = readFileSync(USAGE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<UsageState>;
    return {
      first_run_utc: parsed.first_run_utc ?? new Date().toISOString(),
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      cooldown_until: parsed.cooldown_until ?? null,
    };
  } catch {
    return emptyState();
  }
}

export function saveUsage(state: UsageState): void {
  if (!existsSync(LOCKEDOUT_HOME)) {
    mkdirSync(LOCKEDOUT_HOME, { recursive: true, mode: 0o700 });
  }
  writeFileSync(USAGE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function utcDay(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD
}

function envCap(): number {
  const env = process.env.LOCKEDOUT_DAILY_CAP;
  if (!env) return DEFAULT_CAP;
  const n = parseInt(env, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP;
}

function currentCap(state: UsageState): number {
  const firstRun = new Date(state.first_run_utc).getTime();
  const ageDays = (Date.now() - firstRun) / (1000 * 60 * 60 * 24);
  return ageDays < RAMP_DAYS ? RAMP_CAP : envCap();
}

function todayActions(state: UsageState): number {
  const today = utcDay(new Date().toISOString());
  return state.actions.filter(
    (a) => COUNTED_KINDS.has(a.kind) && utcDay(a.ts) === today,
  ).length;
}

export interface QuotaCheckResult {
  blocked: boolean;
  reason?: string;
  count: number;
  cap: number;
  is_warmup: boolean;
}

/** Returns whether a counted action would exceed the daily cap. */
export function checkDailyQuota(opts: { force?: boolean } = {}): QuotaCheckResult {
  const state = loadUsage();
  const count = todayActions(state);
  const cap = currentCap(state);
  const firstRun = new Date(state.first_run_utc).getTime();
  const isWarmup = (Date.now() - firstRun) / (1000 * 60 * 60 * 24) < RAMP_DAYS;

  if (opts.force || count < cap) {
    return { blocked: false, count, cap, is_warmup: isWarmup };
  }
  const tomorrow = new Date();
  tomorrow.setUTCHours(24, 0, 0, 0);
  const hours = Math.ceil((tomorrow.getTime() - Date.now()) / (1000 * 60 * 60));
  return {
    blocked: true,
    reason: `Daily cap reached: ${count}/${cap}${isWarmup ? " (first-14-days warm-up)" : ""}. Resets in ~${hours}h. Override with --force.`,
    count,
    cap,
    is_warmup: isWarmup,
  };
}

export function recordAction(kind: string, target?: string): void {
  const state = loadUsage();
  state.actions.push({
    ts: new Date().toISOString(),
    kind,
    ...(target ? { target } : {}),
  });
  // Trim history older than 30 days to keep the file bounded.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  state.actions = state.actions.filter((a) => new Date(a.ts).getTime() >= cutoff);
  saveUsage(state);
}

// ─── Cooldown ──────────────────────────────────────────────────────────────

export function setCooldown(minutes = 30): void {
  const state = loadUsage();
  state.cooldown_until = new Date(Date.now() + minutes * 60_000).toISOString();
  saveUsage(state);
}

export function clearCooldown(): void {
  const state = loadUsage();
  state.cooldown_until = null;
  saveUsage(state);
}

export function getCooldownRemainingMs(): number {
  const state = loadUsage();
  if (!state.cooldown_until) return 0;
  const ms = new Date(state.cooldown_until).getTime() - Date.now();
  return ms > 0 ? ms : 0;
}

export function summarizeUsage(): {
  first_run_utc: string;
  today_count: number;
  cap: number;
  is_warmup: boolean;
  cooldown_remaining_minutes: number;
} {
  const state = loadUsage();
  const remainingMs = getCooldownRemainingMs();
  return {
    first_run_utc: state.first_run_utc,
    today_count: todayActions(state),
    cap: currentCap(state),
    is_warmup:
      (Date.now() - new Date(state.first_run_utc).getTime()) /
        (1000 * 60 * 60 * 24) <
      RAMP_DAYS,
    cooldown_remaining_minutes: Math.ceil(remainingMs / 60000),
  };
}
