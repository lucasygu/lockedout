import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "lockedout-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateDir = join(home, ".lockedout");
  const namedDir = (name) => join(stateDir, "profiles", name);

  function run(...args) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
      timeout: 5000,
    });
    assert.ifError(result.error);
    return result;
  }

  function seed(dir, count, cooldown = false) {
    const now = new Date();
    mkdirSync(join(dir, "profile"), { recursive: true });
    writeFileSync(join(dir, "cookies.json"), "[]");
    writeFileSync(join(dir, "usage.json"), JSON.stringify({
      first_run_utc: now.toISOString(),
      actions: Array.from({ length: count }, () => ({ ts: now.toISOString(), kind: "profile" })),
      cooldown_until: cooldown ? new Date(now.getTime() + 30 * 60_000).toISOString() : null,
    }));
  }

  return { stateDir, namedDir, run, seed };
}

function readJson(result, status = 0) {
  assert.equal(result.status, status, result.stderr);
  return JSON.parse(result.stdout);
}

test("usage, cooldown and diagnostics target the named profile and preserve legacy usage", (t) => {
  const { stateDir, namedDir, run, seed } = fixture(t);
  seed(stateDir, 2, true);
  seed(namedDir("work"), 3, true);
  seed(namedDir("personal"), 1);

  assert.equal(readJson(run("usage", "--json")).today_count, 2);
  assert.equal(readJson(run("--profile", "default", "usage", "--json")).today_count, 2);
  assert.equal(readJson(run("usage", "--profile", "work", "--json")).today_count, 3);
  assert.equal(readJson(run("--profile=personal", "usage", "--json")).today_count, 1);

  const preflight = run("--profile", "work", "profile", "example");
  assert.equal(preflight.status, 1);
  assert.match(preflight.stderr, /lockedout --profile work cooldown clear/);
  const { stdout } = run("--profile", "work", "doctor", "--quick", "--json");
  const { checks } = JSON.parse(stdout);
  assert.equal(
    checks.find((check) => check.name === "Profile dir").detail,
    join(namedDir("work"), "profile"),
  );
  assert.match(checks.find((check) => check.name === "Daily quota").detail, /^3\//);
  assert.match(checks.find((check) => check.name === "Cooldown").detail, /--profile work cooldown clear/);

  assert.equal(run("cooldown", "clear", "--profile", "work").status, 0);
  assert.equal(readJson(run("--profile", "work", "usage", "--json")).cooldown_remaining_minutes, 0);
  assert.ok(readJson(run("usage", "--json")).cooldown_remaining_minutes > 0);
});

test("listing and logout keep named and default browser data separate", (t) => {
  const { stateDir, namedDir, run, seed } = fixture(t);
  assert.deepEqual(readJson(run("profiles", "--json")), []);
  seed(stateDir, 2);
  seed(namedDir("work"), 3);
  seed(namedDir("personal"), 1);
  assert.deepEqual(readJson(run("profiles", "--json")), ["default", "personal", "work"]);

  assert.equal(run("--profile", "personal", "logout").status, 0);
  assert.equal(existsSync(namedDir("personal")), false);
  assert.equal(existsSync(join(stateDir, "profile")), true);

  assert.equal(run("logout").status, 0);
  for (const file of ["profile", "cookies.json", "usage.json"]) {
    assert.equal(existsSync(join(stateDir, file)), false);
    assert.equal(existsSync(join(namedDir("work"), file)), true);
  }
  assert.deepEqual(readJson(run("profiles", "--json")), ["work"]);
});

test("a missing named session does not fall back to default or create state", (t) => {
  const { stateDir, namedDir, run, seed } = fixture(t);
  seed(stateDir, 2);
  assert.deepEqual(readJson(run("--profile", "work", "status", "--json"), 1), {
    logged_in: false,
    message: "No profile yet. Run: lockedout --profile work login",
  });
  assert.equal(readJson(run("--profile", "work", "usage", "--json")).today_count, 0);
  assert.equal(existsSync(namedDir("work")), false);
});

test("profile names cannot escape their directory or alias a Windows device", (t) => {
  const { stateDir, namedDir, run, seed } = fixture(t);
  seed(stateDir, 2);
  seed(namedDir("work"), 3);
  const invalid = [
    "", ".", "..", "../work", "a/b", "a\\b", "/tmp", "C:\\temp", "Work",
    "a.", "a ", "con", "com1", "a".repeat(65),
  ];
  for (const name of invalid) {
    const result = run("--profile", name, "logout");
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, /Invalid profile name/);
  }
  assert.deepEqual(readJson(run("profiles", "--json")), ["default", "work"]);
});
