import { homedir } from "node:os";
import { join } from "node:path";

export const LOCKEDOUT_HOME = join(homedir(), ".lockedout");
export const PROFILE_DIR = join(LOCKEDOUT_HOME, "profile");
export const COOKIES_FILE = join(LOCKEDOUT_HOME, "cookies.json");
export const USAGE_FILE = join(LOCKEDOUT_HOME, "usage.json");
