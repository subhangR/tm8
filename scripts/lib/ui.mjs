// Which package is the product UI, and is it ready to run?
//
// THE PACKAGE IS `packages/tm8_ui_2.0` — NOT `packages/tm8-ui` (the frozen 1.0
// snapshot) and NOT `packages/ui` (the legacy collab-v2 oracle).
//
// This file used to point at `packages/ui`, and everything downstream inherited
// the mistake: `bun run dev` started the wrong Vite app, `bun run start` built
// the wrong bundle and then warned that no bundle existed, and `bun run doctor`
// reported on a directory nothing serves. That is why this constant exists:
// it is THE pointer every launcher, doctor, and deploy path reads.
//
// 2026-08-29: the pointer moved from `packages/tm8-ui` to `packages/tm8_ui_2.0`
// when the Astryx redesign (PRs #526/#531) became the product UI. Prod's
// TM8_UI_DIR must point at `packages/tm8_ui_2.0/dist`.
//
// 2026-09-02: `tm8-ui` is BUILT AND SERVED AGAIN, as the ALTERNATE UI behind
// the version switch — at `/ui-1.0/`, from `dist-1.0`, on the same origin, and
// only when an operator sets TM8_UI_1_0_DIR. It is still not the product UI and
// this pointer does not move. Two claims in the note this replaces are now
// stale and were measured rather than assumed: it typechecks clean under the
// workspace's React 19 (the React 18 declaration in its package.json is
// overridden and was never the blocker anyone thought it was), and it is in the
// merge gate again — see tools/ci/check.sh.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./env.mjs";

/** The product UI package. */
export const UI_DIR = join(REPO_ROOT, "packages", "tm8_ui_2.0");

/** The legacy collab-v2 oracle. Not served, not built, not started. */
export const LEGACY_UI_DIR = join(REPO_ROOT, "packages", "ui");

/**
 * The pre-Astryx 1.0 snapshot — the ALTERNATE UI, not the product one.
 *
 * Built to `dist-1.0` (never `dist`; the reason is a production interlock
 * documented in its vite.config.ts) and served under `/ui-1.0/` when
 * TM8_UI_1_0_DIR names that directory.
 */
export const UI_1_0_DIR = join(REPO_ROOT, "packages", "tm8-ui");

/** Where the 1.0 bundle is emitted, and what TM8_UI_1_0_DIR should name. */
export function ui10BundleDir() {
  return join(UI_1_0_DIR, "dist-1.0");
}

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
    return { ready: false, reason: `packages/tm8_ui_2.0/package.json is unreadable: ${err.message}` };
  }
  const devScript = pkg.scripts?.dev;
  if (!devScript) return { ready: false, reason: "packages/tm8_ui_2.0 has no `dev` script" };
  if (/^echo\b/.test(devScript.trim())) {
    return { ready: false, reason: "packages/tm8_ui_2.0 `dev` script is still a placeholder" };
  }
  const hasVite =
    Boolean(pkg.devDependencies?.vite || pkg.dependencies?.vite) ||
    ["vite.config.ts", "vite.config.js", "vite.config.mts"].some((f) =>
      existsSync(join(UI_DIR, f)),
    );
  if (!hasVite) return { ready: false, reason: "packages/tm8_ui_2.0 has no vite config or dependency" };
  // node_modules per workspace package is not optional under bun's isolated
  // linker: `vite` resolves out of packages/tm8_ui_2.0/node_modules/.bin, and its
  // absence fails as "vite: not found" long after the launcher has claimed
  // everything is fine.
  if (!existsSync(join(UI_DIR, "node_modules"))) {
    return { ready: false, reason: "packages/tm8_ui_2.0 has no node_modules — run `bun install`" };
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
