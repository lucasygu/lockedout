import { homedir } from "node:os";
import { join } from "node:path";

export const LOCKEDOUT_HOME = join(homedir(), ".lockedout");
export const PROFILE_DIR = join(LOCKEDOUT_HOME, "profile");
