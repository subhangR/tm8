#!/usr/bin/env node
// tm8 doctor — print the resolved environment and run every preflight check
// without starting anything. First thing to run when `bun run dev` misbehaves.
//
// Usage: node scripts/doctor.mjs [--prod]

import { existsSync, statSync } from "node:fs";
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
