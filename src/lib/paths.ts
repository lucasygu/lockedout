import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOCKEDOUT_HOME = join(homedir(), ".lockedout");
const PROFILES_DIR = join(LOCKEDOUT_HOME, "profiles");
const DEFAULT_PROFILE_NAME = "default";

export interface ProfilePaths {
  name: string;
  stateDir: string;
  browserDir: string;
  cookiesFile: string;
  usageFile: string;
}

function isProfileName(name: string): boolean {
  return (
    /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(name)
  );
}

export function getProfilePaths(name = DEFAULT_PROFILE_NAME): ProfilePaths {
  if (!isProfileName(name)) {
    throw new Error(
      "Invalid profile name. Use 1–64 lowercase letters, digits, hyphens or underscores, " +
        "start with a letter or digit, and avoid reserved device names.",
    );
  }
  const stateDir = name === DEFAULT_PROFILE_NAME ? LOCKEDOUT_HOME : join(PROFILES_DIR, name);
  return {
    name,
    stateDir,
    browserDir: join(stateDir, "profile"),
    cookiesFile: join(stateDir, "cookies.json"),
    usageFile: join(stateDir, "usage.json"),
  };
}

export const defaultProfile = getProfilePaths();
export const PROFILE_DIR = defaultProfile.browserDir;
export const COOKIES_FILE = defaultProfile.cookiesFile;
export const USAGE_FILE = defaultProfile.usageFile;

function profileFiles(profile: ProfilePaths): string[] {
  return [profile.browserDir, profile.cookiesFile, profile.usageFile];
}

export function listProfiles(): string[] {
  const names = profileFiles(defaultProfile).some((path) => existsSync(path))
    ? [DEFAULT_PROFILE_NAME]
    : [];
  if (!existsSync(PROFILES_DIR)) return names;

  const named = readdirSync(PROFILES_DIR, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && entry.name !== DEFAULT_PROFILE_NAME && isProfileName(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
  return [...names, ...named];
}

export function removeProfile(profile: ProfilePaths): boolean {
  // Named profiles live under the legacy state directory. Leave the parent
  // directory in place when clearing the default profile.
  const paths = profile.name === DEFAULT_PROFILE_NAME ? profileFiles(profile) : [profile.stateDir];
  const existing = paths.filter((path) => existsSync(path));
  for (const path of existing) rmSync(path, { recursive: true, force: true });
  return existing.length > 0;
}

export function commandForProfile(profile: ProfilePaths, command: string): string {
  const option = profile.name === DEFAULT_PROFILE_NAME ? "" : ` --profile ${profile.name}`;
  return `lockedout${option} ${command}`;
}
