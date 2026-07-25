// =============================================================================
// Test helpers for the db/ suites.
//
// ZERO npm dependencies (same discipline as tools/rigs — the db package must not
// churn bun.lock for a test harness). Everything drives `psql`, which the sidecar
// already ships, and the suites run under node's built-in test runner:
//
//   node db/test/run.mjs            reset the test db, apply the sequence, run all
//   node --test db/test/            run the suites against an already-migrated db
//
// The important thing this file buys: every query can be run AS tm8_app, with
// claims bound exactly the way tm8-server binds them. A suite that tested through
// the superuser would prove nothing about RLS — the owner bypasses it.
//
// Connection resolution matches db/migrate.mjs, so one env var configures both:
//   $TM8_DATABASE_URL → postgres://$TM8_PG_USER@$TM8_PG_HOST:$TM8_PG_PORT/$TM8_TEST_DB
// =============================================================================

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(HERE, '..');

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

// --- connection -------------------------------------------------------------
// TM8_DATABASE_URL is authoritative when present (that is what the lane brief and
// db/migrate.mjs both use), so the suites can never end up pointed at a different
// database than the migrations were just applied to.
function resolveOwnerUrl() {
  if (process.env.TM8_DATABASE_URL) return process.env.TM8_DATABASE_URL;
  const user = process.env.TM8_PG_USER || process.env.USER || 'postgres';
  const host = process.env.TM8_PG_HOST || '127.0.0.1';
  const port = process.env.TM8_PG_PORT || '5442';
  const db = process.env.TM8_TEST_DB || process.env.TM8_DB || 'tm8_test';
  return `postgres://${user}@${host}:${port}/${db}`;
}

export const OWNER_URL = resolveOwnerUrl();

function withUser(url, user) {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = '';
  return parsed.toString();
}
function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** The low-privilege role tm8-server connects as. RLS applies to it. */
export const APP_URL = withUser(OWNER_URL, 'tm8_app');
export const TEST_DB = new URL(OWNER_URL).pathname.replace(/^\//, '');

// --- SQL plumbing -----------------------------------------------------------

/** SQL string literal, quoted for embedding. */
export function literal(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** uuid literal, or `null` for a missing value. */
export function uuid(value) {
  return value === null || value === undefined ? 'null' : `${literal(value)}::uuid`;
}

const PSQL_ARGS = ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-q'];

/**
 * psql prints the message but not the code, so ask for the code explicitly via
 * VERBOSITY. Falls back to matching the standard "ERROR:  ..." prefix.
 */
function sqlstateOf(stderr) {
  const match = /SQLSTATE=([0-9A-Z]{5})|ERROR:\s+([0-9A-Z]{5}):/.exec(stderr);
  return match ? match[1] || match[2] : null;
}

function claimPreamble(claims) {
  let script = '';
  for (const [key, value] of Object.entries(claims ?? {})) {
    if (value === undefined || value === null) continue;
    script += `select set_config('${key}', ${literal(String(value))}, true);\n`;
  }
  return script;
}

function buildScript(sql, { claims = null, singleTransaction = false, verbose = false }) {
  let script = verbose ? '\\set VERBOSITY verbose\n' : '';
  const wrap = claims !== null || singleTransaction;
  if (wrap) script += 'begin;\n';
  if (claims) script += claimPreamble(claims);
  script += sql.endsWith(';') ? `${sql}\n` : `${sql};\n`;
  if (wrap) script += 'commit;\n';
  return script;
}

/**
 * Run SQL and return { ok, stdout, stderr, sqlstate }.
 *
 * `claims` are applied with set_config(..., true) — transaction-local, exactly as
 * the server does it. When claims are present the whole script runs inside one
 * transaction, because that is the only scope in which a claim exists.
 */
export function run(sql, { url = APP_URL, claims = null, singleTransaction = false, verbose = false } = {}) {
  const script = buildScript(sql, { claims, singleTransaction, verbose });
  const result = spawnSync(PSQL, [...PSQL_ARGS, url, '-f', '-'], { input: script, encoding: 'utf8' });
  const stderr = result.stderr ?? '';
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: stderr.trim(),
    sqlstate: sqlstateOf(stderr),
    script,
  };
}

/**
 * Run a script VERBATIM — no transaction wrapper, no claim preamble. The only way
 * to exercise anything that spans more than one transaction (claim leakage,
 * explicit begin/commit interleaving).
 */
export function runRaw(script, { url = APP_URL } = {}) {
  const result = spawnSync(PSQL, [...PSQL_ARGS, url, '-f', '-'], { input: script, encoding: 'utf8' });
  const stderr = result.stderr ?? '';
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: stderr.trim(),
    sqlstate: sqlstateOf(stderr),
  };
}

/**
 * The async twin of runRaw. Concurrency tests need two live connections at the
 * same instant, which a synchronous runner cannot give them.
 */
export function runRawAsync(script, { url = APP_URL } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(PSQL, [...PSQL_ARGS, url, '-f', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) =>
      resolve({
        ok: status === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        sqlstate: sqlstateOf(stderr),
        elapsedMs: Date.now() - started,
      }),
    );
    child.stdin.end(script);
  });
}

/**
 * Async runner with the standard claim/transaction wrapper. Pass verbose: true when
 * the test needs the loser's SQLSTATE out of a concurrent pair — psql only prints
 * the code under VERBOSITY verbose.
 */
export function runAsync(
  sql,
  { url = APP_URL, claims = null, singleTransaction = false, verbose = false } = {},
) {
  return runRawAsync(buildScript(sql, { claims, singleTransaction, verbose }), { url });
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
 * Run SQL that must FAIL, returning the SQLSTATE. psql needs verbose errors to
 * print the code, so this variant asks for them.
 */
export function expectFailure(sql, opts = {}) {
  const res = run(sql, { ...opts, verbose: true });
  if (res.ok) {
    throw new Error(`expected a failure, but the statement succeeded:\n${sql}`);
  }
  return { sqlstate: res.sqlstate, stderr: res.stderr };
}

/**
 * The negative-path assertion, and the reason the suites read the way they do.
 *
 * `label` names the policy or guard under test and the caller who must be refused,
 * so a red run says "space_invites_select: non-admin member ..." rather than
 * "expected 42501, got null". Every RLS/guard negative goes through here.
 */
export function denied(label, sql, { expect = null, ...opts } = {}) {
  const res = run(sql, { ...opts, verbose: true });
  if (res.ok) {
    throw new Error(
      `${label}\n  EXPECTED: refused${expect ? ` with SQLSTATE ${expect}` : ''}\n` +
        `  ACTUAL:   the statement SUCCEEDED and returned ${JSON.stringify(res.stdout)}\n` +
        `  sql:      ${sql}`,
    );
  }
  if (expect && res.sqlstate !== expect) {
    throw new Error(
      `${label}\n  EXPECTED: SQLSTATE ${expect}\n  ACTUAL:   SQLSTATE ${res.sqlstate}\n` +
        `  stderr:   ${res.stderr}\n  sql:      ${sql}`,
    );
  }
  return res.sqlstate;
}

/**
 * The RLS negative that is NOT an error: a policy does not raise, it returns
 * nothing. `invisible` asserts the caller sees zero of the rows it named.
 */
export function invisible(label, sql, opts = {}) {
  const count = Number(scalar(sql, opts));
  if (count !== 0) {
    throw new Error(
      `${label}\n  EXPECTED: 0 visible rows (RLS should filter them out)\n` +
        `  ACTUAL:   ${count} row(s) visible\n  sql:      ${sql}`,
    );
  }
}

/** The positive twin of `invisible`, with the same diagnostic shape. */
export function visible(label, sql, expected, opts = {}) {
  const count = Number(scalar(sql, opts));
  if (count !== expected) {
    throw new Error(
      `${label}\n  EXPECTED: ${expected} visible row(s)\n  ACTUAL:   ${count}\n  sql:      ${sql}`,
    );
  }
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

/**
 * Rows of a query, as objects.
 *
 * jsonb_agg, not json_agg: `json` preserves the input's formatting and psql prints
 * a multi-element aggregate across several lines, which the single-line payload
 * convention above cannot read. jsonb normalises to one line.
 */
export function rows(sql, opts = {}) {
  return json(`select coalesce(jsonb_agg(t), '[]'::jsonb) from (${sql}) t`, opts) ?? [];
}

/** A single scalar. */
export function scalar(sql, opts = {}) {
  const out = ok(sql, opts);
  return out.split('\n').filter((l) => l.length > 0).pop() ?? null;
}

/** `select count(*)` against a table, as the given caller. */
export function countRows(table, where, opts = {}) {
  return Number(scalar(`select count(*) from ${table} where ${where}`, opts));
}

export function claimsFor(identityId, actorId = null, nodeAdmin = false) {
  const claims = { 'tm8.identity_id': identityId };
  if (actorId) claims['tm8.actor_id'] = actorId;
  claims['tm8.node_admin'] = nodeAdmin ? 'true' : 'false';
  return claims;
}

// --- fresh databases --------------------------------------------------------

/**
 * Create a throwaway sibling database with the full sequence applied, for the
 * handful of assertions that are about a database's FIRST moments (the
 * zero-accounts branch of ensure_account) and therefore cannot share a database
 * with anything else.
 */
export function freshDatabase(suffix) {
  const name = `${TEST_DB}_${suffix}`;
  const url = withDatabase(OWNER_URL, name);
  const result = spawnSync(process.execPath, [join(DB_DIR, 'migrate.mjs'), 'reset', '--force'], {
    encoding: 'utf8',
    cwd: DB_DIR,
    env: { ...process.env, TM8_DATABASE_URL: url, TM8_ALLOW_RESET: '1' },
  });
  if (result.status !== 0) {
    throw new Error(`could not build the fresh database ${name}:\n${result.stdout}\n${result.stderr}`);
  }
  return { name, ownerUrl: url, appUrl: withUser(url, 'tm8_app') };
}

// --- world building ---------------------------------------------------------

// A node has exactly one owner account and (after the first one) account creation
// is node-admin-only, so every suite's world hangs off ONE bootstrapped root.
export const ROOT_IDENTITY = 'identity-root';

/**
 * Idempotent, and idempotent on purpose in BOTH directions: on a virgin database
 * ensure_account takes the zero-accounts branch and the bound claims are ignored;
 * on a populated one the same call takes the node-admin branch and root is a node
 * admin. One call, both worlds.
 */
export function ensureRoot({ url = APP_URL } = {}) {
  const sql =
    `select public.ensure_account(${literal(ROOT_IDENTITY)}, 'root', 'Root', null, true, true)`;
  const claims = claimsFor(ROOT_IDENTITY, null, true);
  let res = run(sql, { url, claims });
  if (!res.ok) {
    // Lost a bootstrap race against another suite: the owner now exists, so the
    // very same call resolves to it.
    res = run(sql, { url, claims });
  }
  if (!res.ok) {
    if (/node admin required/.test(res.stderr)) {
      throw new Error(
        `root bootstrap failed: ${TEST_DB} already has an owner account that is NOT ` +
          `'${ROOT_IDENTITY}', so the suites cannot mint their accounts.\n` +
          `This database was populated by something other than the suites. Start clean:\n` +
          `  node db/test/run.mjs\n\n${res.stderr}`,
      );
    }
    throw new Error(`root bootstrap failed:\n${res.stderr}`);
  }
  return JSON.parse(res.stdout.split('\n').filter((l) => l.trim()).pop()).id;
}

/** Root's claims — a node admin, used to mint the per-suite accounts. */
export function rootClaims() {
  return claimsFor(ROOT_IDENTITY, null, true);
}

/**
 * Build a world to test against: two accounts (A is a node admin, B is NOT — the
 * asymmetry is what the node-admin negatives are made of), two spaces, a project,
 * a task, a persona. Runs through the REAL RPCs as tm8_app, so world building is
 * itself a test that the write path works from the low-privilege role.
 *
 * `tag` must be unique per world: accounts and usernames are node-wide.
 */
export function buildWorld(tag = 'w', { url = APP_URL } = {}) {
  const idA = `identity-${tag}-a`;
  const idB = `identity-${tag}-b`;
  const opts = { url };

  ensureRoot(opts);

  const accountA = json(
    `select public.ensure_account(${literal(idA)}, ${literal(`${tag}-a`)}, 'Owner A', null, false, true)`,
    { ...opts, claims: rootClaims() },
  ).id;
  const accountB = json(
    `select public.ensure_account(${literal(idB)}, ${literal(`${tag}-b`)}, 'User B', null, false, false)`,
    { ...opts, claims: rootClaims() },
  ).id;

  const spaceA = json(`select public.create_space('Space A', 'first', 'private')`, {
    ...opts,
    claims: claimsFor(idA),
  });
  const spaceB = json(`select public.create_space('Space B', 'second', 'public')`, {
    ...opts,
    claims: claimsFor(idB),
  });

  const memberA = spaceA.memberId;
  const memberB = spaceB.memberId;

  const taskA = json(`select public.create_task(${uuid(spaceA.space.id)}, 'Task in A')`, {
    ...opts,
    claims: claimsFor(idA, memberA),
  });
  const personaA = json(`select public.create_team_member(${uuid(spaceA.space.id)}, 'Cygnus-bot')`, {
    ...opts,
    claims: claimsFor(idA, memberA),
  });

  // working_dir is UNIQUE node-wide, so it carries the space id: ensure_account and
  // create_space tolerate a second run against a non-reset database, and this is
  // the one call that would not.
  const project = json(
    `select public.create_project('proj-${tag}', '/tmp/tm8-test-${tag}-${spaceA.space.id}', null, 'trusted')`,
    { ...opts, claims: claimsFor(idA, null, true) },
  );
  ok(`select public.link_project(${uuid(spaceA.space.id)}, ${uuid(project.project.id)})`, {
    ...opts,
    claims: claimsFor(idA, memberA),
  });

  return {
    url,
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
    taskAVersion: taskA.entity.version,
    personaA: personaA.entity.id,
    projectId: project.project.id,
    claimsA: claimsFor(idA, memberA),
    claimsB: claimsFor(idB, memberB),
    adminA: claimsFor(idA, memberA, true),
  };
}

/** A unique cmid per call site, without needing a random source. */
let cmidCounter = 0;
export function cmid(tag) {
  cmidCounter += 1;
  return `cmid-${tag}-${process.pid}-${cmidCounter}`;
}
