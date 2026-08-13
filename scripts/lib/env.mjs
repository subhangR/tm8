// Shared environment resolution for the tm8 dev/prod launchers.
//
// Resolution order (first wins):
//   1. real process environment
//   2. <repo>/.env.<TM8_ENV>.local   (gitignored, per-developer, per-env)
//   3. <repo>/.env.local             (gitignored, per-developer)
//   4. <repo>/.env                   (gitignored)
//   5. built-in defaults below
//
// Canonical values live in docs/ops/CONFIG.md. Ports and data dirs are chosen
// to never collide with live maestro (4567-4569, 4571; ~/.maestro*).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Ports that live maestro owns. tm8 must never bind these. */
export const MAESTRO_RESERVED_PORTS = [4567, 4568, 4569, 4570, 4571, 3001];

/** Data dirs that live maestro owns. tm8 must never write inside these. */
export const MAESTRO_RESERVED_DIRS = [
  join(homedir(), ".maestro"),
  join(homedir(), ".maestro-staging"),
];

// These MUST agree with deploy/environments.sh, which is the one topology table
// (`bash deploy/environments.sh` prints it). Two places is already one too many;
// they are duplicated here only because a .mjs launcher cannot source a .sh, and
// the day they disagree is the day `bun run dev` and `./install.sh` set up two
// different tm8's in the same checkout.
//
// TM8_DATABASE_URL and TM8_DELIVERY_DATABASE_URL are the entries that were
// missing until 2026-08-12, and their absence WAS the onboarding bug: without
// them a fresh clone boots a server that logs
//   graph: NOT CONFIGURED (set TM8_DATABASE_URL) — all operations answer 501
// and every single operation answers 501. Nothing in the launcher path noticed,
// because nothing in the launcher path ever looked at a database.
//
// TM8_DELIVERY_DATABASE_URL must AUTHENTICATE as tm8_delivery_worker — the
// server rejects a connection that can merely SET ROLE to it — so the cluster
// has to trust loopback. ./install.sh sets that up; see its PHASE 3.
const DEFAULTS = {
  dev: {
    TM8_ENV: "dev",
    TM8_DATA_DIR: join(homedir(), ".tm8-dev"),
    TM8_PORT: "4610",
    TM8_UI_PORT: "4611",
    TM8_PG_PORT: "5442",
    TM8_LOG_LEVEL: "debug",
    TM8_DATABASE_URL: "postgres://tm8@127.0.0.1:5442/tm8_dev",
    TM8_DELIVERY_DATABASE_URL: "postgres://tm8_delivery_worker@127.0.0.1:5442/tm8_dev",
  },
  // The canonical prod slot (ruled 2026-08-12): server 17777, database tm8_prod.
  // This used to read 4610 / ~/.tm8, which described no instance that has ever
  // run — the live prod has been 17777 behind nginx on 7777 the whole time.
  prod: {
    TM8_ENV: "prod",
    TM8_DATA_DIR: join(homedir(), ".tm8"),
    TM8_PORT: "17777",
    TM8_UI_PORT: "7777",
    TM8_PG_PORT: "5442",
    TM8_LOG_LEVEL: "info",
    TM8_DATABASE_URL: "postgres://tm8@127.0.0.1:5442/tm8_prod",
    TM8_DELIVERY_DATABASE_URL: "postgres://tm8_delivery_worker@127.0.0.1:5442/tm8_prod",
  },
};

/**
 * The per-session identity a tm8-spawned agent carries, which must NEVER be
 * forwarded into a server this launcher starts.
 *
 * `resolveEnv` deliberately carries unknown TM8_* variables through so the
 * server's own config can grow without editing this file. That is right for
 * config and wrong for identity: an agent session running `bun run dev` exports
 * TM8_AGENT_TOKEN, TM8_ACTOR_ID, TM8_SESSION_ID and TM8_BASE_URL pointing at the
 * node that SPAWNED it, and forwarding those hands the new server a stranger's
 * credentials while making every CLI probe against it fail as
 * `unauthenticated: invalid token`. Running a launcher from inside a tm8 session
 * is ordinary here, so this is a normal path, not an exotic one.
 *
 * Config stays; identity is dropped.
 */
const SESSION_VARS = new Set([
  "TM8_AGENT_TOKEN",
  "TM8_BASE_URL",
  "TM8_ACTOR_ID",
  "TM8_SESSION_ID",
  "TM8_TEAM_MEMBER_ID",
  "TM8_SPACE_ID",
  "TM8_PROJECT_ID",
  "TM8_TASK_IDS",
  "TM8_MANIFEST_PATH",
  "TM8_JOURNAL_PATH",
  "TM8_MODE",
  "TM8_MODEL",
  "TM8_AGENT_TOOL",
  "TM8_GIT_LOGIN",
  "TM8_SESSION_COOKIE",
  "TM8_CLIENT_HEADER",
]);

/** Minimal .env parser: KEY=VALUE, `#` comments, optional quotes, no interpolation. */
function parseDotenv(text) {
  const out = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadDotenvFiles(env) {
  const files = [`.env.${env}.local`, ".env.local", ".env"];
  const merged = {};
  const loaded = [];
  for (const name of files) {
    const path = join(REPO_ROOT, name);
    if (!existsSync(path)) continue;
    loaded.push(name);
    const parsed = parseDotenv(readFileSync(path, "utf8"));
    // earlier files win
    for (const [k, v] of Object.entries(parsed)) {
      if (!(k in merged)) merged[k] = v;
    }
  }
  return { merged, loaded };
}

/** Expand a leading `~` against the user's home directory. */
export function expandHome(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve the tm8 runtime configuration.
 * @param {"dev"|"prod"} mode which default set to start from
 * @returns {{env: Record<string,string>, sources: string[], mode: string}}
 */
export function resolveEnv(mode) {
  const requested = process.env.TM8_ENV || mode;
  const base = DEFAULTS[requested] ?? DEFAULTS[mode];
  const { merged, loaded } = loadDotenvFiles(requested);

  const env = {};
  for (const key of Object.keys(base)) {
    env[key] = process.env[key] ?? merged[key] ?? base[key];
  }
  // Carry any extra TM8_* keys the .env files define (forward-compat for the
  // server's own config: TM8_PG_BIN_DIR, TM8_BACKUP_CRON, ...).
  for (const [k, v] of Object.entries(merged)) {
    if (k.startsWith("TM8_") && !(k in env)) env[k] = process.env[k] ?? v;
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (SESSION_VARS.has(k)) continue;
    if (k.startsWith("TM8_") && !(k in env) && v !== undefined) env[k] = v;
  }

  env.TM8_ENV = requested;
  env.TM8_DATA_DIR = expandHome(env.TM8_DATA_DIR);

  return { env, sources: loaded, mode: requested };
}

/** Numeric port accessor with a clear error on garbage input. */
export function port(env, key) {
  const raw = env[key];
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${key} must be an integer port, got ${JSON.stringify(raw)}`);
  }
  return n;
}
