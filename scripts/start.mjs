#!/usr/bin/env node
// tm8 production launcher — the one-command start story for real use (AM-1/T-D21).
//
//   bun run start          → build everything, then run tm8-server under NODE
//
// There is no installed desktop app (AM-1). This is the whole product entry point:
// tm8-server owns the sidecar Postgres (R15), serves the built web UI, and the user
// opens http://localhost:<TM8_PORT>.
//
// Usage: node scripts/start.mjs [--no-build] [--no-open] [--help]

import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, resolveEnv } from "./lib/env.mjs";
import { preflight, reportPreflight } from "./lib/preflight.mjs";
import { installShutdownHandler, logger, run, start } from "./lib/run.mjs";
import { UI_DIR, uiBundleExists, uiDevStatus } from "./lib/ui.mjs";

const flags = new Set(process.argv.slice(2));

if (flags.has("--help") || flags.has("-h")) {
  console.log(`tm8 launcher (production)

  node scripts/start.mjs [options]

  --no-build   skip the build, launch what is already in dist/
  --help       this message

Environment (see docs/ops/CONFIG.md, override in .env):
  TM8_ENV=prod  TM8_DATA_DIR=~/.tm8  TM8_PORT=4610  TM8_PG_PORT=5442
`);
  process.exit(0);
}

const withBuild = !flags.has("--no-build");

const log = logger("tm8", "cyan");
const buildLog = logger("build", "yellow");
const serverLog = logger("server", "green");

installShutdownHandler(log);

const { env, sources } = resolveEnv("prod");

log.info(`tm8 — env=${env.TM8_ENV} data=${env.TM8_DATA_DIR}`);
log.info(`ports: server ${env.TM8_PORT} · sidecar pg ${env.TM8_PG_PORT}`);
if (sources.length) log.dim(`env files: ${sources.join(", ")}`);

const results = await preflight(env, { needUiPort: false, needPgPort: true });
if (!reportPreflight(results, log)) {
  log.error("aborting — fix the above and re-run");
  process.exit(1);
}

// --- build ------------------------------------------------------------------
// Strictly sequential: the scoped tsc project build first, then at most ONE vite
// build. Parallel vite builds SIGTERM each other (old-repo lesson) — never fan out.
if (withBuild) {
  const projects = ["packages/server", "packages/execution", "packages/cli"];
  buildLog.info(`tsc -b ${projects.join(" ")}`);
  const code = await run("node_modules/.bin/tsc", ["-b", ...projects], {
    cwd: REPO_ROOT,
    log: buildLog,
  });
  if (code !== 0) {
    buildLog.error("build failed");
    process.exit(code);
  }

  const ui = uiDevStatus();
  if (ui.ready) {
    buildLog.info("building the web UI bundle (single vite build)");
    const uiCode = await run("bun", ["run", "build"], { cwd: UI_DIR, env, log: buildLog });
    if (uiCode !== 0) {
      buildLog.error("UI build failed");
      process.exit(uiCode);
    }
  } else {
    buildLog.info(`skipping the UI bundle — ${ui.reason}`);
  }
  buildLog.info("build ok");
}

const SERVER_ENTRY = join(REPO_ROOT, "packages", "server", "dist", "index.js");
if (!existsSync(SERVER_ENTRY)) {
  log.error(`${SERVER_ENTRY} does not exist. Re-run without --no-build.`);
  process.exit(1);
}

if (!uiBundleExists()) {
  log.warn(
    "no web UI bundle at packages/ui/dist — tm8-server will serve the API only " +
      "(expected until W3/M2 lands the UI transplant).",
  );
}

// --- run --------------------------------------------------------------------
// node, never bun: packages/server and packages/execution depend on node-pty.
serverLog.info(`node ${SERVER_ENTRY.replace(REPO_ROOT + "/", "")}`);
const proc = start("node", ["--enable-source-maps", SERVER_ENTRY], {
  cwd: REPO_ROOT,
  env,
  log: serverLog,
});

log.info(`open http://localhost:${env.TM8_PORT}`);

proc.on("exit", (code, signal) => {
  if (signal) {
    log.dim(`tm8-server exited on ${signal}`);
    process.exit(0);
  }
  if (code !== 0) log.error(`tm8-server exited with code ${code}`);
  process.exit(code ?? 1);
});
