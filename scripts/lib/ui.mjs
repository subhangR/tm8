// packages/ui arrives at W3/M2 (transplant of the collab-v2 module + RealFacade).
// Until then the launchers must degrade gracefully instead of failing: the
// one-command start story has to work at every wave, not only the last one.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./env.mjs";

export const UI_DIR = join(REPO_ROOT, "packages", "ui");

/**
 * Is packages/ui a real Vite app yet, or still the scaffold placeholder?
 * @returns {{ready: boolean, reason: string}}
 */
export function uiDevStatus() {
  const pkgPath = join(UI_DIR, "package.json");
  if (!existsSync(pkgPath)) {
    return { ready: false, reason: "packages/ui has no package.json" };
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (err) {
    return { ready: false, reason: `packages/ui/package.json is unreadable: ${err.message}` };
  }
  const devScript = pkg.scripts?.dev;
  if (!devScript) return { ready: false, reason: "packages/ui has no `dev` script" };
  if (/^echo\b/.test(devScript.trim())) {
    return { ready: false, reason: "packages/ui `dev` script is still the scaffold placeholder" };
  }
  const hasVite =
    Boolean(pkg.devDependencies?.vite || pkg.dependencies?.vite) ||
    ["vite.config.ts", "vite.config.js", "vite.config.mts"].some((f) =>
      existsSync(join(UI_DIR, f)),
    );
  if (!hasVite) return { ready: false, reason: "packages/ui has no vite config or dependency" };
  return { ready: true, reason: "" };
}

/** Path to the production UI bundle tm8-server serves on TM8_PORT (AM-1). */
export function uiBundleDir() {
  return join(UI_DIR, "dist");
}

export function uiBundleExists() {
  return existsSync(join(uiBundleDir(), "index.html"));
}
