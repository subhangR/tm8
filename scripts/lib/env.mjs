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

const DEFAULTS = {
  dev: {
    TM8_ENV: "dev",
    TM8_DATA_DIR: join(homedir(), ".tm8-dev"),
    TM8_PORT: "4610",
    TM8_UI_PORT: "4611",
    TM8_PG_PORT: "5442",
    TM8_LOG_LEVEL: "debug",
  },
  prod: {
    TM8_ENV: "prod",
    TM8_DATA_DIR: join(homedir(), ".tm8"),
    TM8_PORT: "4610",
    TM8_UI_PORT: "4611",
    TM8_PG_PORT: "5442",
    TM8_LOG_LEVEL: "info",
  },
};

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
