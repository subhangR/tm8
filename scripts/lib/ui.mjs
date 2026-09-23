// Which package is the product UI, and is it ready to run?
//
// THE PACKAGE IS `packages/tm8-ui`, and since 2026-09-15 it is the ONLY UI
// package in this repo.
//
// This file used to point at `packages/ui`, and everything downstream inherited
// the mistake: `bun run dev` started the wrong Vite app, `bun run start` built
// the wrong bundle and then warned that no bundle existed, and `bun run doctor`
// reported on a directory nothing serves. That is why this constant exists:
// it is THE pointer every launcher, doctor, and deploy path reads.
//
// The history it arbitrated is over, and is kept short here because the shape
// of it is the warning: the pointer moved to the Astryx redesign
// (`packages/tm8_ui_2.0`) on 2026-08-29, the pair swapped which was mounted and
// which was root twice inside a week, and for the last stretch the alternate at
// `/ui-2.0/` 404ed on prod because its directory pointer named a path that did
// not exist. On 2026-09-15 the owner had both the redesign fork and the legacy
// `packages/ui` oracle deleted; there is one UI, it is served at `/`, and there
// is no second mount to keep in step.
//
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./env.mjs";

/** The product UI package. */
export const UI_DIR = join(REPO_ROOT, "packages", "tm8-ui");

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
