import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type VaultSource = "env" | "home" | "demo";

export interface VaultLocation {
  path: string;
  source: VaultSource;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** The demo vault that ships with the package. */
export const DEMO_VAULT = path.join(here, "..", "vault");

export function defaultHomeVault(home: string = os.homedir()): string {
  return path.join(home, "SecondBrain");
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Decide which vault to use:
 *   1. VAULT_PATH, if set
 *   2. ~/SecondBrain, if it exists (created by `second-brain-mcp init`)
 *   3. the bundled demo vault
 */
export function resolveVault(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): VaultLocation {
  if (env.VAULT_PATH) return { path: path.resolve(env.VAULT_PATH), source: "env" };
  const homeVault = defaultHomeVault(home);
  if (isDirectory(homeVault)) return { path: homeVault, source: "home" };
  return { path: DEMO_VAULT, source: "demo" };
}

export function describeSource(source: VaultSource): string {
  switch (source) {
    case "env":
      return "set by VAULT_PATH";
    case "home":
      return "your ~/SecondBrain folder";
    case "demo":
      return "the bundled demo vault";
  }
}
