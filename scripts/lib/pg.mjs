// Postgres probes for the launchers. Zero npm dependencies on purpose: this
// drives `psql`, which is already a hard requirement, rather than pulling `pg`
// into a path that runs before `bun install` has necessarily succeeded.
//
// Everything here answers ONE question the launchers never used to ask: can tm8
// actually use its database? `bun run doctor` reported "all clear" while the
// server it was clearing the way for logged
//
//     graph: NOT CONFIGURED (set TM8_DATABASE_URL) — all operations answer 501
//
// because doctor checked node's version, three ports and node_modules, and
// nothing else. "Doctor is happy" and "tm8 works" were unrelated claims.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./env.mjs";

/** The Postgres major tm8 standardises on (ruled 2026-08-12). */
export const PG_MAJOR = process.env.TM8_PG_MAJOR || "16";

/**
 * Find a psql. An explicit TM8_PSQL wins; then the versioned path for the
 * standard major; a bare PATH `psql` is the LAST resort, not the first, because
 * on a machine with more than one Postgres it is frequently an older linked
 * formula pointing at a different cluster.
 * @returns {string|null}
 */
export function findPsql() {
  const candidates = [
    process.env.TM8_PSQL,
    `/usr/lib/postgresql/${PG_MAJOR}/bin/psql`,
    `/opt/homebrew/opt/postgresql@${PG_MAJOR}/bin/psql`,
    `/usr/local/opt/postgresql@${PG_MAJOR}/bin/psql`,
    `/usr/pgsql-${PG_MAJOR}/bin/psql`,
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  const probe = spawnSync("psql", ["--version"], { stdio: "ignore" });
  return probe.status === 0 ? "psql" : null;
}

/**
 * Run one scalar query. Returns the trimmed first cell, or null on any failure.
 * A REAL authenticated query — never pg_isready, which reports OK while
 * authentication is failing and so cannot tell "the cluster is up" from "tm8 can
 * use it". The difference between those two is the whole bug class this exists
 * to catch.
 */
export function scalar(psql, url, sql, timeoutMs = 5000) {
  if (!psql) return null;
  const r = spawnSync(psql, [url, "-tAc", sql], {
    encoding: "utf8",
    timeout: timeoutMs,
    // PGCONNECT_TIMEOUT so an unreachable host fails in seconds, not in the
    // TCP stack's own sweet time.
    env: { ...process.env, PGCONNECT_TIMEOUT: "3" },
  });
  if (r.status !== 0) return null;
  return (r.stdout || "").split("\n")[0].trim();
}

/** Can we authenticate and query at all? */
export function canQuery(psql, url) {
  return scalar(psql, url, "select 1") === "1";
}

/** How many migration files are on disk. */
export function migrationsOnDisk() {
  const dir = join(REPO_ROOT, "db", "migrations");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).length;
}

/**
 * The full picture of one database, as the launchers need it.
 * @returns {{psql: string|null, reachable: boolean, applied: number|null,
 *            onDisk: number, delivery: boolean|null, detail: string}}
 */
export function inspectDatabase(env) {
  const psql = findPsql();
  const onDisk = migrationsOnDisk();
  const url = env.TM8_DATABASE_URL;
  const deliveryUrl = env.TM8_DELIVERY_DATABASE_URL;

  if (!psql) {
    return {
      psql: null, reachable: false, applied: null, onDisk, delivery: null,
      detail: `no psql found for Postgres ${PG_MAJOR}. Install the client or set TM8_PSQL.`,
    };
  }
  if (!url) {
    return {
      psql, reachable: false, applied: null, onDisk, delivery: null,
      detail: "TM8_DATABASE_URL is not set — the server will answer 501 to every operation.",
    };
  }
  if (!canQuery(psql, url)) {
    return {
      psql, reachable: false, applied: null, onDisk, delivery: null,
      detail: `cannot authenticate against ${redact(url)}. Is the cluster up, and does the role exist? Run ./install.sh`,
    };
  }

  // `to_regclass` rather than a bare count: an unmigrated database has no
  // applied_migrations table at all, and a failed query would read as
  // "unreachable" when the truth is "reachable but empty".
  const hasLedger = scalar(psql, url, "select to_regclass('public.applied_migrations') is not null");
  const applied =
    hasLedger === "t" ? Number(scalar(psql, url, "select count(*) from applied_migrations")) : 0;

  // The delivery role must AUTHENTICATE, not merely be assumable. When it
  // cannot, messages are stored and never pushed to a live terminal — a failure
  // with no error anywhere, which reads as "delivery is flaky".
  const delivery = deliveryUrl ? canQuery(psql, deliveryUrl) : null;

  return { psql, reachable: true, applied, onDisk, delivery, detail: "" };
}

/** Hide the password in a connection string before printing it. */
export function redact(url) {
  return String(url).replace(/:\/\/([^:@/]+):[^@]*@/, "://$1:***@");
}
