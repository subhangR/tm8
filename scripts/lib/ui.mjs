// Which package is the product UI, and is it ready to run?
//
// THE PACKAGE IS `packages/tm8-ui` — NOT `packages/tm8_ui_2.0` (the Astryx
// redesign, now the ALTERNATE UI) and NOT `packages/ui` (the legacy collab-v2
// oracle).
//
// This file used to point at `packages/ui`, and everything downstream inherited
// the mistake: `bun run dev` started the wrong Vite app, `bun run start` built
// the wrong bundle and then warned that no bundle existed, and `bun run doctor`
// reported on a directory nothing serves. That is why this constant exists:
// it is THE pointer every launcher, doctor, and deploy path reads.
//
// 2026-08-29: the pointer moved from `packages/tm8-ui` to `packages/tm8_ui_2.0`
// when the Astryx redesign (PRs #526/#531) became the product UI.
//
// 2026-09-02: `tm8-ui` was BUILT AND SERVED AGAIN, as the ALTERNATE UI behind
// the version switch — at `/ui-1.0/`, from `dist-1.0`.
//
// 2026-09-03: THE OWNER REVERSED IT. `packages/tm8-ui` is the product UI at `/`
// again, from `dist`, and `packages/tm8_ui_2.0` is the alternate — at
// `/ui-2.0/`, from `dist-2.0`, on the same origin, and only when an operator
// sets TM8_UI_2_0_DIR. Prod's TM8_UI_DIR must point at `packages/tm8-ui/dist`.
//
// 2026-09-05: THE VERSION SWITCH IS GONE from the product UI's tab bar. The
// build and serve story below is UNCHANGED — the mount still exists for an
// operator who sets TM8_UI_2_0_DIR — but nothing links to it, so `/ui-2.0/` is
// reached by typing it. The control had no server to point at anywhere it was
// deployed and spent its life disabled, quoting this env var at viewers.
//
// BOTH PACKAGES DECLARE REACT 19 and both typecheck under CI's frozen
// lockfile; the swap did not reopen the two-React-type-identities problem that
// kept `tm8-ui` out of the merge gate before 2026-09-02. See tools/ci/check.sh
// for which stages run which package's typecheck and vitest.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./env.mjs";

/** The product UI package. */
export const UI_DIR = join(REPO_ROOT, "packages", "tm8-ui");

/** The legacy collab-v2 oracle. Not served, not built, not started. */
export const LEGACY_UI_DIR = join(REPO_ROOT, "packages", "ui");

/**
 * The Astryx redesign — the ALTERNATE UI, not the product one.
 *
 * Built to `dist-2.0` (never `dist`; the reason is a production interlock
 * documented in its vite.config.ts) and served under `/ui-2.0/` when
 * TM8_UI_2_0_DIR names that directory.
 */
export const UI_2_0_DIR = join(REPO_ROOT, "packages", "tm8_ui_2.0");

/** Where the 2.0 bundle is emitted, and what TM8_UI_2_0_DIR should name. */
export function ui20BundleDir() {
  return join(UI_2_0_DIR, "dist-2.0");
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
  // linker: `vite` resolves out of packages/tm8_ui_2.0/node_modules/.bin, and its
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
