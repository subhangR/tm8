// =============================================================================
// Test helpers for the db/ suites.
//
// ZERO npm dependencies (same discipline as tools/rigs — the db package must not
// churn bun.lock for a test harness). Everything drives `psql`, which the sidecar
// already ships, and the suites run under node's built-in test runner:
//
//   node db/test/run.mjs            reset tm8_test, apply the sequence, run all suites
//   node --test db/test/            run the suites against an already-migrated tm8_test
//
// The important thing this file buys: every query can be run AS tm8_app, with
// claims bound exactly the way tm8-server binds them. A suite that tested through
// the superuser would prove nothing about RLS — the owner bypasses it.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const HOST = process.env.TM8_PG_HOST || '127.0.0.1';
const PORT = process.env.TM8_PG_PORT || '5442';
export const TEST_DB = process.env.TM8_TEST_DB || 'tm8_test';
const OWNER_USER = process.env.TM8_PG_USER || process.env.USER || 'postgres';

function findPsql() {
  if (process.env.TM8_PSQL) return process.env.TM8_PSQL;
  for (const candidate of [
    '/opt/homebrew/opt/postgresql@18/bin/psql',
    '/usr/local/opt/postgresql@18/bin/psql',
    '/usr/lib/postgresql/18/bin/psql',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return 'psql';
}
const PSQL = findPsql();

export const OWNER_URL = `postgres://${OWNER_USER}@${HOST}:${PORT}/${TEST_DB}`;
export const APP_URL = `postgres://tm8_app@${HOST}:${PORT}/${TEST_DB}`;

/**
 * Run SQL and return { ok, stdout, stderr, sqlstate }.
 *
 * `claims` are applied with set_config(..., true) — transaction-local, exactly as
 * the server does it. When claims are present the whole script runs inside one
 * transaction, because that is the only scope in which a claim exists.
 */
export function run(sql, { url = APP_URL, claims = null, singleTransaction = false } = {}) {
  let script = '';
  const wrap = claims !== null || singleTransaction;
  if (wrap) script += 'begin;\n';
  if (claims) {
    for (const [key, value] of Object.entries(claims)) {
      if (value === undefined || value === null) continue;
      script += `select set_config('${key}', ${literal(String(value))}, true);\n`;
    }
  }
  script += sql.endsWith(';') ? `${sql}\n` : `${sql};\n`;
  if (wrap) script += 'commit;\n';

  const result = spawnSync(
    PSQL,
    ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-q', url, '-f', '-'],
    { input: script, encoding: 'utf8' },
  );
  const stderr = result.stderr ?? '';
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: stderr.trim(),
    sqlstate: sqlstateOf(stderr),
  };
}

/** SQL string literal, quoted for embedding. */
export function literal(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * psql prints the message but not the code, so ask for the code explicitly via
 * VERBOSITY. Falls back to matching the standard "ERROR:  ..." prefix.
 */
function sqlstateOf(stderr) {
  const match = /SQLSTATE=([0-9A-Z]{5})|ERROR:\s+([0-9A-Z]{5}):/.exec(stderr);
  return match ? match[1] || match[2] : null;
}

/**
 * Run SQL that must FAIL, returning the SQLSTATE. psql needs verbose errors to
 * print the code, so this variant asks for them.
 */
export function expectFailure(sql, opts = {}) {
  const res = run(`\\set VERBOSITY verbose\n${sql}`, opts);
  if (res.ok) {
    throw new Error(`expected a failure, but the statement succeeded:\n${sql}`);
  }
  return { sqlstate: res.sqlstate, stderr: res.stderr };
}

/** Run SQL that must succeed; returns trimmed stdout. */
export function ok(sql, opts = {}) {
  const res = run(sql, opts);
  if (!res.ok) {
    throw new Error(`statement failed unexpectedly:\n${sql}\n\n${res.stderr}`);
  }
  return res.stdout;
}

/**
 * Run a query and JSON.parse its result. The query must produce a single row and
 * a single column; wrap sets with json_agg.
 */
export function json(sql, opts = {}) {
  const out = ok(sql, opts);
  const payload = out.split('\n').filter((l) => l.trim().length > 0).pop();
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    throw new Error(`result was not JSON:\n${sql}\n\n${out}`);
  }
}

/** Rows of a query, as objects. */
export function rows(sql, opts = {}) {
  return json(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t`, opts) ?? [];
}

/** A single scalar. */
export function scalar(sql, opts = {}) {
  const out = ok(sql, opts);
  return out.split('\n').filter((l) => l.length > 0).pop() ?? null;
}

export function claimsFor(identityId, actorId = null, nodeAdmin = false) {
  const claims = { 'tm8.identity_id': identityId };
  if (actorId) claims['tm8.actor_id'] = actorId;
  claims['tm8.node_admin'] = nodeAdmin ? 'true' : 'false';
  return claims;
}

/**
 * Build a world to test against: two accounts, two spaces, a project, tasks, a
 * persona. Runs through the REAL RPCs as tm8_app, so world building is itself a
 * test that the write path works from the low-privilege role.
 *
 * Returns ids for both identities so cross-tenant negatives have something real
 * to be denied.
 */
export function buildWorld(tag = 'w') {
  const idA = `identity-${tag}-a`;
  const idB = `identity-${tag}-b`;

  // First-run bootstrap: the owner account may be created with no claim bound
  // (T-L7). Any later account requires a node admin, so B is created under A's
  // node-admin claim.
  const bootstrapped = json(
    `select public.ensure_account(${literal(idA)}, ${literal(`${tag}-a`)}, 'Owner A', null, true, true)`,
    { claims: null },
  );
  const accountA = bootstrapped.id;

  const accountB = json(
    `select public.ensure_account(${literal(idB)}, ${literal(`${tag}-b`)}, 'User B')`,
    { claims: claimsFor(idA, null, true) },
  ).id;

  const spaceA = json(`select public.create_space('Space A', 'first', 'private')`, {
    claims: claimsFor(idA),
  });
  const spaceB = json(`select public.create_space('Space B', 'second', 'public')`, {
    claims: claimsFor(idB),
  });

  const memberA = spaceA.memberId;
  const memberB = spaceB.memberId;

  const taskA = json(
    `select public.create_task(${literal(spaceA.space.id)}, 'Task in A')`,
    { claims: claimsFor(idA, memberA) },
  );
  const personaA = json(
    `select public.create_team_member(${literal(spaceA.space.id)}, 'Cygnus-bot')`,
    { claims: claimsFor(idA, memberA) },
  );

  const project = json(
    `select public.create_project('proj-${tag}', '/tmp/tm8-test-${tag}', null, 'trusted')`,
    { claims: claimsFor(idA, null, true) },
  );
  ok(
    `select public.link_project(${literal(spaceA.space.id)}, ${literal(project.project.id)})`,
    { claims: claimsFor(idA, memberA) },
  );

  return {
    identityA: idA,
    identityB: idB,
    accountA,
    accountB,
    spaceA: spaceA.space.id,
    spaceB: spaceB.space.id,
    memberA,
    memberB,
    channelA: spaceA.defaultChannelId,
    channelB: spaceB.defaultChannelId,
    taskA: taskA.entity.id,
    personaA: personaA.entity.id,
    projectId: project.project.id,
    claimsA: claimsFor(idA, memberA),
    claimsB: claimsFor(idB, memberB),
    adminA: claimsFor(idA, memberA, true),
  };
}
