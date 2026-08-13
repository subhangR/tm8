// Which package is the product UI, and is it ready to run?
//
// THE PACKAGE IS `packages/tm8-ui`, NOT `packages/ui`.
//
// This file used to point at `packages/ui`, and everything downstream inherited
// the mistake: `bun run dev` started the wrong Vite app, `bun run start` built
// the wrong bundle and then warned that no bundle existed, and `bun run doctor`
// reported on a directory nothing serves. `packages/ui` is the legacy collab-v2
// oracle — kept for reference, not shipped. The product UI, the one prod serves
// out of `packages/tm8-ui/dist` and the one deploy/utho/deploy.sh runs its
// separate `vite build` over, is `packages/tm8-ui`.
//
// deploy/staging/run-server.sh had already worked around this by passing
// --server-only and starting the UI itself, with a comment naming the bug. The
// workaround can go now that the cause is fixed.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./env.mjs";

/** The product UI package. */
export const UI_DIR = join(REPO_ROOT, "packages", "tm8-ui");

/** The legacy collab-v2 oracle. Not served, not built, not started. */
export const LEGACY_UI_DIR = join(REPO_ROOT, "packages", "ui");

/**
 * Can we start a Vite dev server for the product UI?
 * @returns {{ready: boolean, reason: string}}
 */
export function uiDevStatus() {
  const pkgPath = join(UI_DIR, "package.json");
  if (!existsSync(pkgPath)) {
    return { ready: false, reason: `${UI_DIR} has no package.json` };
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (err) {
    return { ready: false, reason: `packages/tm8-ui/package.json is unreadable: ${err.message}` };
  }
  const devScript = pkg.scripts?.dev;
  if (!devScript) return { ready: false, reason: "packages/tm8-ui has no `dev` script" };
  if (/^echo\b/.test(devScript.trim())) {
    return { ready: false, reason: "packages/tm8-ui `dev` script is still a placeholder" };
  }
  const hasVite =
    Boolean(pkg.devDependencies?.vite || pkg.dependencies?.vite) ||
    ["vite.config.ts", "vite.config.js", "vite.config.mts"].some((f) =>
      existsSync(join(UI_DIR, f)),
    );
  if (!hasVite) return { ready: false, reason: "packages/tm8-ui has no vite config or dependency" };
  // node_modules per workspace package is not optional under bun's isolated
  // linker: `vite` resolves out of packages/tm8-ui/node_modules/.bin, and its
  // absence fails as "vite: not found" long after the launcher has claimed
  // everything is fine.
  if (!existsSync(join(UI_DIR, "node_modules"))) {
    return { ready: false, reason: "packages/tm8-ui has no node_modules — run `bun install`" };
  }
  return { ready: true, reason: "" };
}

/** Path to the production UI bundle tm8-server serves as TM8_UI_DIR. */
export function uiBundleDir() {
  return join(UI_DIR, "dist");
}

export function uiBundleExists() {
  return existsSync(join(uiBundleDir(), "index.html"));
}
