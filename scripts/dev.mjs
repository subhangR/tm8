#!/usr/bin/env node
// tm8 dev orchestrator — the one-command start story for development (AM-1/T-D21).
//
//   bun run dev            → preflight, build, tm8-server under NODE, UI dev server
//
// What it does, in order:
//   1. resolve env  (~/.tm8-dev, TM8_PORT 4610, TM8_UI_PORT 4611, TM8_PG_PORT 5442)
//   2. preflight    (node version, port isolation from live maestro, data-dir isolation)
//   3. build        (scoped `tsc -b` — NEVER a parallel vite build)
//   4. run          tm8-server under node (node-pty is broken under bun) + Vite UI on 4611
//   5. watch        rebuild on source change, restart the server when its dist changes
//
// Postgres is NOT started by anything in this repo. packages/server/src/sidecar/
// looks like it does that job and is dead code (only `import type` references it),
// so a database has to exist before this script is useful: run ./install.sh once.
// Preflight now says so out loud instead of reporting "ready" over an empty node.
//
// Usage: node scripts/dev.mjs [--no-ui] [--no-watch] [--no-build] [--server-only] [--help]

import { watch } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, resolveEnv } from "./lib/env.mjs";
import { preflight, reportPreflight } from "./lib/preflight.mjs";
import { installShutdownHandler, logger, run, start } from "./lib/run.mjs";
import { UI_DIR, uiDevStatus } from "./lib/ui.mjs";

const flags = new Set(process.argv.slice(2));

if (flags.has("--help") || flags.has("-h")) {
  console.log(`tm8 dev orchestrator

  node scripts/dev.mjs [options]

  --no-ui        server only, skip the Vite UI dev server
  --server-only  alias for --no-ui
  --no-watch     build once, do not watch for changes
  --no-build     skip the initial build (assumes dist/ is current)
  --help         this message

Environment (see docs/ops/CONFIG.md, override in .env):
  TM8_ENV=dev  TM8_DATA_DIR=~/.tm8-dev  TM8_PORT=4610  TM8_UI_PORT=4611  TM8_PG_PORT=5442
`);
  process.exit(0);
}

const withUi = !flags.has("--no-ui") && !flags.has("--server-only");
const withWatch = !flags.has("--no-watch");
const withBuild = !flags.has("--no-build");

const log = logger("tm8", "cyan");
const buildLog = logger("build", "yellow");
const serverLog = logger("server", "green");
const uiLog = logger("ui", "magenta");

installShutdownHandler(log);

const { env, sources } = resolveEnv("dev");

log.info(`tm8 dev — env=${env.TM8_ENV} data=${env.TM8_DATA_DIR}`);
log.info(
  `ports: server ${env.TM8_PORT} · ui ${env.TM8_UI_PORT} · sidecar pg ${env.TM8_PG_PORT}`,
);
if (sources.length) log.dim(`env files: ${sources.join(", ")}`);

// --- 1. preflight -----------------------------------------------------------
const results = await preflight(env, { needUiPort: withUi, needPgPort: true });
if (!reportPreflight(results, log)) {
  log.error("aborting — fix the above and re-run `bun run dev`");
  process.exit(1);
}

// --- 2. build ---------------------------------------------------------------
// Scoped project build only. `tsc -b packages/server` pulls packages/contract in
// through its project reference. Never a vite build here (concurrent vite builds
// SIGTERM each other — a lesson from the old repo).
const SERVER_PROJECTS = ["packages/server"];

if (withBuild) {
  buildLog.info(`tsc -b ${SERVER_PROJECTS.join(" ")}`);
  const code = await run("node_modules/.bin/tsc", ["-b", ...SERVER_PROJECTS], {
    cwd: REPO_ROOT,
    log: buildLog,
  });
  if (code !== 0) {
    buildLog.error("initial build failed — fix the type errors above, then re-run");
    process.exit(code);
  }
  buildLog.info("build ok");
}

const SERVER_ENTRY = join(REPO_ROOT, "packages", "server", "dist", "index.js");
if (!existsSync(SERVER_ENTRY)) {
  log.error(`${SERVER_ENTRY} does not exist. Run without --no-build, or \`bun run build\`.`);
  process.exit(1);
}

// --- 3. tm8-server, under node ----------------------------------------------
let serverProc = null;
let serverGeneration = 0;

function startServer() {
  const generation = ++serverGeneration;
  serverLog.info(`node ${SERVER_ENTRY.replace(REPO_ROOT + "/", "")}`);
  serverProc = start("node", ["--enable-source-maps", SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env,
    log: serverLog,
  });
  const proc = serverProc;
  proc.on("exit", (code, signal) => {
    if (generation !== serverGeneration) return; // superseded by a restart
    if (signal) {
      serverLog.dim(`exited on ${signal}`);
    } else if (code === 0) {
      // Expected today: packages/server is still the W0 scaffold, which prints and
      // exits. Once the facade listens on TM8_PORT this becomes a real long-run.
      serverLog.dim("exited cleanly (scaffold has no listener yet) — waiting for changes");
    } else {
      serverLog.error(`exited with code ${code} — waiting for changes`);
    }
    serverProc = null;
  });
}

function restartServer() {
  if (serverProc && serverProc.exitCode === null) {
    serverGeneration++; // orphan the old exit handler
    serverProc.kill("SIGTERM");
    const proc = serverProc;
    const forceKill = setTimeout(() => proc.kill("SIGKILL"), 3000);
    proc.once("exit", () => {
      clearTimeout(forceKill);
      startServer();
    });
    serverProc = null;
    return;
  }
  startServer();
}

startServer();
// NOT "managed by tm8-server". That claim was here for months and was never
// true: packages/server/src/sidecar/ is imported by nothing but `import type`,
// so no tm8 process has ever started, owned or reconciled a postmaster. tm8 uses
// the system Postgres (ruled 2026-08-12) and ./install.sh is what puts it there.
log.dim(
  `Postgres on ${env.TM8_PG_PORT} is the system cluster — neither started nor owned by tm8 ` +
    `(set it up with ./install.sh)`,
);

// --- 4. UI dev server -------------------------------------------------------
if (withUi) {
  const ui = uiDevStatus();
  if (ui.ready) {
    uiLog.info(`vite dev on ${env.TM8_UI_PORT}`);
    start("bun", ["run", "dev", "--port", String(env.TM8_UI_PORT), "--strictPort"], {
      cwd: UI_DIR,
      env: {
        ...env,
        // The browser app talks to tm8-server over HTTP/WS (AM-1: no desktop shell).
        VITE_TM8_API_URL: `http://localhost:${env.TM8_PORT}/api`,
        VITE_TM8_WS_URL: `ws://localhost:${env.TM8_PORT}/ws`,
      },
      log: uiLog,
    });
  } else {
    uiLog.warn(`UI dev server not started — ${ui.reason}.`);
    uiLog.dim(
      `The product UI is packages/tm8-ui (NOT packages/ui, which is the legacy ` +
        `collab-v2 oracle). Fix the reason above and re-run; port ${env.TM8_UI_PORT} stays reserved.`,
    );
  }
}

// --- 5. watch ---------------------------------------------------------------
if (withWatch) {
  buildLog.info("watching packages/{contract,server}/src for changes");

  let buildTimer = null;
  let building = false;
  let queued = false;

  async function rebuild() {
    if (building) {
      queued = true;
      return;
    }
    building = true;
    const code = await run("node_modules/.bin/tsc", ["-b", ...SERVER_PROJECTS], {
      cwd: REPO_ROOT,
      log: buildLog,
    });
    building = false;
    if (code === 0) {
      buildLog.info("rebuild ok — restarting server");
      restartServer();
    } else {
      buildLog.error("rebuild failed — server left running on the last good build");
    }
    if (queued) {
      queued = false;
      rebuild();
    }
  }

  const scheduleRebuild = () => {
    clearTimeout(buildTimer);
    buildTimer = setTimeout(rebuild, 250);
  };

  for (const dir of ["packages/contract/src", "packages/server/src"]) {
    const abs = join(REPO_ROOT, dir);
    if (!existsSync(abs)) continue;
    try {
      watch(abs, { recursive: true }, (_event, filename) => {
        if (filename && !/\.(ts|mts|cts|json)$/.test(filename)) return;
        scheduleRebuild();
      });
    } catch (err) {
      buildLog.warn(`cannot watch ${dir}: ${err.message}`);
    }
  }
}

log.info("ready — Ctrl-C to stop everything");
