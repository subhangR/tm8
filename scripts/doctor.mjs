#!/usr/bin/env node
// tm8 doctor — print the resolved environment and run every preflight check
// without starting anything. First thing to run when `bun run dev` misbehaves.
//
// Usage: node scripts/doctor.mjs [--prod]

import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT, resolveEnv } from "./lib/env.mjs";
import { preflight } from "./lib/preflight.mjs";
import { logger } from "./lib/run.mjs";
import { PG_MAJOR, inspectDatabase, redact } from "./lib/pg.mjs";
import { uiBundleExists, uiDevStatus } from "./lib/ui.mjs";

const prod = process.argv.includes("--prod");
const log = logger("doctor", "cyan");
const { env, sources, mode } = resolveEnv(prod ? "prod" : "dev");

log.info(`mode: ${mode}`);
log.info(`env files: ${sources.length ? sources.join(", ") : "(none — using defaults)"}`);
for (const key of Object.keys(env).sort()) {
  log.info(`  ${key}=${env[key]}`);
}

log.info("");
log.info(`node: ${process.versions.node}`);
log.info(`repo: ${REPO_ROOT}`);

const dataDir = env.TM8_DATA_DIR;
log.info(
  `data dir: ${dataDir} ${existsSync(dataDir) ? `(exists, ${statSync(dataDir).isDirectory() ? "dir" : "NOT A DIR"})` : "(will be created on first run)"}`,
);

const serverDist = join(REPO_ROOT, "packages", "server", "dist", "index.js");
log.info(`server build: ${existsSync(serverDist) ? serverDist : "missing — run `bun run build`"}`);

const ui = uiDevStatus();
log.info(`ui dev: ${ui.ready ? "ready" : `not ready — ${ui.reason}`}`);
log.info(`ui bundle: ${uiBundleExists() ? "present" : "absent (served API-only)"}`);

// --- the database, in detail -------------------------------------------------
// The section this file was missing. Doctor used to check node, ports and
// node_modules and then say "all clear" about an installation with no database
// at all, in which every one of the 141 catalog operations answers 501.
log.info("");
const db = inspectDatabase(env);
log.info(`psql: ${db.psql ?? `NOT FOUND (Postgres ${PG_MAJOR} client)`}`);
log.info(`database url: ${env.TM8_DATABASE_URL ? redact(env.TM8_DATABASE_URL) : "NOT SET"}`);
if (!db.reachable) {
  log.error(`database: ${db.detail}`);
} else {
  log.info(`database: reachable, ${db.applied}/${db.onDisk} migrations applied`);
  if (db.applied !== db.onDisk) {
    log.warn("schema is behind the checkout — run `node db/migrate.mjs up`");
  }
  log.info(
    `delivery role: ${
      db.delivery === null
        ? "TM8_DELIVERY_DATABASE_URL not set — messages will be stored but never delivered"
        : db.delivery
          ? "can authenticate"
          : "CANNOT authenticate — messages will be stored but never delivered"
    }`,
  );
}

// --- the agent CLI ----------------------------------------------------------
// The other section this file was missing, and the sharper one: a node can pass
// every check here and still not run a single agent. tm8 stores NO agent
// credential — a spawned session runs the host's `claude`/`codex` and inherits
// its login — so with neither installed (or logged in) every spawn sits at
// "running" forever, the refusal visible only in the terminal.
//
// This is a zero-dependency PRESENCE probe, in keeping with the rest of
// scripts/ (which must run before `bun install`/`bun run build` have
// necessarily succeeded). Login state is not decided here: the authoritative
// check — presence AND login, honouring TM8_AGENT_CMD — is `tm8 doctor`
// (packages/cli/src/commands/doctor.ts), and this points there rather than
// re-implementing it.
log.info("");
const agentCmd = process.env.TM8_AGENT_CMD?.trim();
if (agentCmd) {
  const bin = agentCmd.split(/\s+/)[0] ?? agentCmd;
  const found = spawnSync("which", [bin], { encoding: "utf8" }).status === 0;
  if (found) log.info(`agent cli: TM8_AGENT_CMD=${agentCmd} (found) — confirm login with \`tm8 doctor\``);
  else log.error(`agent cli: TM8_AGENT_CMD=${agentCmd} but ${bin} is not on PATH — every spawn dies with exit 127`);
} else {
  const present = ["claude", "codex"].filter(
    (b) => spawnSync("which", [b], { encoding: "utf8" }).status === 0,
  );
  if (present.length) {
    log.info(`agent cli: ${present.join(", ")} on PATH — run \`tm8 doctor\` for login status (tm8 stores no agent login)`);
  } else {
    log.warn(
      "agent cli: neither claude nor codex on PATH — this node cannot run an agent. " +
        "A spawn will sit at \"running\" and never finish. Install one and log in:\n" +
        "        npm i -g @anthropic-ai/claude-code   # then: claude       (to log in)\n" +
        "        npm i -g @openai/codex                # then: codex login\n" +
        "      Then confirm with `tm8 doctor`.",
    );
  }
}

log.info("");
const results = await preflight(env, { needUiPort: !prod, needPgPort: true });
let failed = 0;
for (const r of results) {
  if (r.ok) {
    // `detail` describes the FAILURE case — only meaningful when the check failed.
    log.info(`  ok    ${r.title}`);
  } else if (r.level === "warn") {
    log.warn(`${r.title} — ${r.detail}`);
  } else {
    failed++;
    log.error(`${r.title} — ${r.detail}`);
  }
}

log.info("");
if (failed) {
  log.error(`${failed} blocking problem(s)`);
  process.exit(1);
}
log.info("all clear");
