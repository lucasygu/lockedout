import kleur from "kleur";
import { existsSync, rmSync } from "node:fs";
import { LOCKEDOUT_HOME } from "../lib/paths.js";

export async function logoutCommand(): Promise<void> {
  if (!existsSync(LOCKEDOUT_HOME)) {
    console.log(kleur.dim("Already logged out."));
    return;
  }
  rmSync(LOCKEDOUT_HOME, { recursive: true, force: true });
  console.log(kleur.green("✓ Logged out. Session cleared."));
}
