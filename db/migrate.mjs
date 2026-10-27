#!/usr/bin/env node
// =============================================================================
// tm8 migration runner.
//
//   node db/migrate.mjs status            what is applied, what is pending
//   node db/migrate.mjs up                apply every pending migration
//   node db/migrate.mjs up --dry-run      print the plan, touch nothing
//   node db/migrate.mjs create-db         create the target database if absent
//   node db/migrate.mjs reset --force     DROP and recreate the database, then up
//
// Properties that matter:
//   * lexical order — `NNN_name.sql`, sorted by filename, no other ordering input
//   * ONE TRANSACTION PER FILE — a failed migration leaves nothing behind
//   * an `applied_migrations` ledger with a content checksum, so re-running is a
//     no-op and an edited-after-apply file is a loud error, not silent drift
//   * ONE RUNNER AT A TIME — `up` holds a Postgres advisory lock for the whole
//     run, so two deploys (or a deploy and an install) against the same database
//     queue instead of both applying the same pending file (a waiting run gives
//     up after $TM8_MIGRATE_LOCK_TIMEOUT, default 10min)
//   * ZERO npm dependencies: it drives `psql`, which the sidecar already ships.
//     (Same discipline as tools/rigs — no lockfile churn for a dev tool.)
//
// Connection resolution (first that answers):
//   $TM8_DATABASE_URL → $DATABASE_URL → postgres://$USER@127.0.0.1:$TM8_PG_PORT/$TM8_DB
// with TM8_PG_PORT defaulting to 5442 and TM8_DB to tm8_dev.
// =============================================================================

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, 'migrations');
const FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;

// --- psql discovery ---------------------------------------------------------
// The sidecar's binaries are not necessarily on PATH (they are a versioned
// Homebrew keg on macOS), so look where they actually live before giving up.
// tm8 standardises on Postgres 16 (ruled 2026-08-12) but accepts a newer client:
// psql talks happily to an older server, and only pg_dump refuses the reverse.
// So probe the standard major first, then newer ones, then PATH.
//
// Two things were wrong here before. It looked for major 18 ONLY — a version no
// machine in this project has ever run (the three live clusters are 16, CI pinned
// 17) — and it tried a bare `psql` FIRST, which on a host with more than one
// Postgres is whichever formula happened to get linked, pointing at a different
// cluster. A versioned path is a fact; `psql` on PATH is a guess, so the guess
// goes last.
const PG_MAJORS = [process.env.TM8_PG_MAJOR || '16', '18', '17', '16'];

function findPsql() {
  if (process.env.TM8_PSQL) return process.env.TM8_PSQL;
  const seen = new Set();
  for (const major of PG_MAJORS) {
    if (seen.has(major)) continue;
    seen.add(major);
    for (const candidate of [
      `/usr/lib/postgresql/${major}/bin/psql`,      // Debian / Ubuntu
      `/opt/homebrew/opt/postgresql@${major}/bin/psql`, // Homebrew, Apple silicon
      `/usr/local/opt/postgresql@${major}/bin/psql`,    // Homebrew, Intel
      `/usr/pgsql-${major}/bin/psql`,               // RHEL family
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  const probe = spawnSync('psql', ['--version'], { stdio: 'ignore' });
  if (probe.status === 0) return 'psql';
  fail(
    `psql not found. Install the Postgres ${PG_MAJORS[0]} client, or set TM8_PSQL to its path.\n` +
      `  Debian/Ubuntu  apt-get install postgresql-client-${PG_MAJORS[0]}\n` +
      `  macOS          brew install postgresql@${PG_MAJORS[0]}\n` +
      '  Or just run    ./install.sh',
  );
}

// --- connection -------------------------------------------------------------
function databaseUrl() {
  if (process.env.TM8_DATABASE_URL) return process.env.TM8_DATABASE_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const user = process.env.TM8_PG_USER || process.env.USER || 'postgres';
  const port = process.env.TM8_PG_PORT || '5442';
  const host = process.env.TM8_PG_HOST || '127.0.0.1';
  const db = process.env.TM8_DB || 'tm8_dev';
  return `postgres://${user}@${host}:${port}/${db}`;
}

/** Same URL with the database swapped — used to create/drop the target. */
function urlWithDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function databaseNameOf(url) {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name) fail(`connection string has no database name: ${url}`);
  return name;
}

// --- psql plumbing ----------------------------------------------------------
const PSQL = findPsql();

function psql(url, args, { capture = true, quiet = false } = {}) {
  const baseArgs = ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', url, ...args];
  const result = spawnSync(PSQL, baseArgs, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) fail(`could not run ${PSQL}: ${result.error.message}`);
  if (result.status !== 0) {
    if (capture && !quiet) {
      if (result.stdout?.trim()) process.stdout.write(result.stdout);
      if (result.stderr?.trim()) process.stderr.write(result.stderr);
    }
    return { ok: false, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }
  return { ok: true, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Scalar/tabular query → rows of string arrays (unaligned, tuples-only). */
function query(url, sql) {
  const res = psql(url, ['-A', '-t', '-F', '', '-c', sql]);
  if (!res.ok) fail(`query failed:\n  ${sql}\n${res.stderr}`);
  return res.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split(''));
}

function canConnect(url) {
  return psql(url, ['-c', 'select 1'], { quiet: true }).ok;
}

// --- migration files --------------------------------------------------------
function migrationFiles() {
  if (!existsSync(MIGRATIONS_DIR)) fail(`no migrations directory at ${MIGRATIONS_DIR}`);
  const entries = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const bad = entries.filter((f) => !FILE_PATTERN.test(f));
  if (bad.length) {
    fail(
      `migration filenames must match NNN_lower_snake_case.sql:\n  ${bad.join('\n  ')}`,
    );
  }
  const files = entries.sort();
  const seen = new Map();
  for (const file of files) {
    const number = file.slice(0, 3);
    if (seen.has(number)) fail(`duplicate migration number ${number}: ${seen.get(number)} and ${file}`);
    seen.set(number, file);
  }
  return files.map((file) => {
    const path = join(MIGRATIONS_DIR, file);
    const body = readFileSync(path);
    return { file, path, checksum: createHash('sha256').update(body).digest('hex') };
  });
}

const LEDGER_DDL = `
create table if not exists public.applied_migrations (
  filename    text primary key,
  checksum    text not null,
  applied_at  timestamptz not null default now(),
  duration_ms integer not null default 0
);
comment on table public.applied_migrations is
  'Migration ledger written by db/migrate.mjs. Not part of the contract surface.';
`;

function ensureLedger(url) {
  const res = psql(url, ['-q', '-c', LEDGER_DDL]);
  if (!res.ok) fail('could not create the applied_migrations ledger');
}

function appliedMap(url) {
  const rows = query(url, 'select filename, checksum from public.applied_migrations');
  return new Map(rows.map(([filename, checksum]) => [filename, checksum]));
}

// --- the run lock -----------------------------------------------------------
// Two `up`s against one database used to both read the same ledger, both see
// the same file pending and both apply it: the second either failed on an
// object that already existed or, for a data migration, ran it twice before
// tripping over the ledger's primary key. So `up` takes a session-level
// advisory lock before it reads the ledger and keeps it until the last file.
//
// Every psql call here is its own connection, and a session lock dies with its
// session, so the lock lives in one psql kept open on stdin for the whole run.
// Closing stdin ends that session and releases it; so does this process dying,
// because the server drops the lock with the connection. Advisory locks are
// per-database, so runs against different databases never wait on each other.
// The holder shows up in pg_stat_activity as application_name 'tm8 db/migrate.mjs'.
const LOCK_KEY = '8389423504455985010'; // 'tm8:migr' read as a bigint
const LOCK_APP_NAME = 'tm8 db/migrate.mjs';

function lockTimeout() {
  const value = process.env.TM8_MIGRATE_LOCK_TIMEOUT || '10min';
  // Interpolated into SQL below, so only a Postgres interval-ish literal passes.
  if (!/^\d+(ms|s|min|h)?$/.test(value)) {
    fail(`TM8_MIGRATE_LOCK_TIMEOUT must look like 30s, 10min or 600000ms, got: ${value}`);
  }
  return value;
}

function acquireMigrationLock(url) {
  const timeout = lockTimeout();
  return new Promise((resolveLock, rejectLock) => {
    const child = spawn(PSQL, ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-q', url], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PGAPPNAME: LOCK_APP_NAME },
    });
    let held = false;
    let stdout = '';
    let stderr = '';
    const closed = new Promise((resolveClosed) => child.on('close', resolveClosed));

    child.on('error', (error) => rejectLock(new Error(`could not run ${PSQL}: ${error.message}`)));
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        const [state, backendPid] = line.split(':');
        if (state === 'try' && backendPid === 'false') {
          console.log(`waiting for another migration run on this database to finish (up to ${timeout})`);
          child.stdin.write(
            `set lock_timeout = '${timeout}';\n` +
              `select 'held:' || pg_backend_pid() from (select pg_advisory_lock(${LOCK_KEY})) s;\n`,
          );
        } else if (state === 'held') {
          held = true;
          resolveLock({
            async release() {
              // The run is synchronous, so a holder that died mid-run (server
              // restart, terminated backend) is only noticeable now: ask the
              // server whether that backend still has the lock.
              const still = query(
                url,
                `select exists (select 1 from pg_locks where locktype = 'advisory' and granted and pid = ${Number(backendPid)})`,
              );
              if (still[0]?.[0] !== 't') {
                console.warn('warning: the migration lock was lost before the run finished; another runner may have overlapped');
              }
              child.stdin.end();
              await closed;
            },
          });
        }
      }
    });
    child.on('exit', (code) => {
      if (held) return;
      const reason = /lock timeout/i.test(stderr)
        ? `another migration run held the lock for longer than ${timeout} (TM8_MIGRATE_LOCK_TIMEOUT)`
        : `psql exited with ${code}: ${stderr.trim()}`;
      rejectLock(new Error(`could not take the migration lock: ${reason}`));
    });

    child.stdin.on('error', () => {}); // an early psql exit is reported by 'exit'
    // One round trip when the lock is free: try, and on success report the pid.
    child.stdin.write(
      `select case when pg_try_advisory_lock(${LOCK_KEY}) then 'held:' || pg_backend_pid() else 'try:false' end;\n`,
    );
  });
}

// --- commands ---------------------------------------------------------------
function cmdStatus(url) {
  if (!canConnect(url)) {
    console.log(`database unreachable: ${redact(url)}`);
    console.log('  run: node db/migrate.mjs create-db');
    process.exitCode = 1;
    return;
  }
  ensureLedger(url);
  const applied = appliedMap(url);
  const files = migrationFiles();
  console.log(`target: ${redact(url)}`);
  let pending = 0;
  let drifted = 0;
  for (const { file, checksum } of files) {
    const recorded = applied.get(file);
    if (!recorded) {
      pending += 1;
      console.log(`  pending  ${file}`);
    } else if (recorded !== checksum) {
      drifted += 1;
      console.log(`  DRIFT    ${file}  (applied checksum differs from the file on disk)`);
    } else {
      console.log(`  applied  ${file}`);
    }
  }
  for (const file of applied.keys()) {
    if (!files.some((f) => f.file === file)) console.log(`  ORPHAN   ${file}  (applied, no longer on disk)`);
  }
  console.log(`${files.length} migration(s): ${files.length - pending - drifted} applied, ${pending} pending, ${drifted} drifted`);
  if (drifted) process.exitCode = 1;
}

async function cmdUp(url, { dryRun }) {
  if (!canConnect(url)) {
    fail(`database unreachable: ${redact(url)}\n  run: node db/migrate.mjs create-db`);
  }
  // A dry run writes nothing, so it neither needs the lock nor waits behind one.
  if (dryRun) return applyPending(url, { dryRun });
  let lock;
  try {
    lock = await acquireMigrationLock(url);
  } catch (error) {
    fail(error.message);
  }
  try {
    applyPending(url, { dryRun });
  } finally {
    await lock.release();
  }
}

function applyPending(url, { dryRun }) {
  ensureLedger(url);
  const applied = appliedMap(url);
  const files = migrationFiles();

  const drifted = files.filter(({ file, checksum }) => applied.has(file) && applied.get(file) !== checksum);
  if (drifted.length && process.env.TM8_MIGRATE_ALLOW_DRIFT !== '1') {
    fail(
      'these applied migrations were edited after they were applied:\n' +
        drifted.map(({ file }) => `  ${file}`).join('\n') +
        '\nA migration is immutable once applied. Add a new file, or recreate the\n' +
        'database (node db/migrate.mjs reset --force) while the sequence is still\n' +
        'pre-release. Set TM8_MIGRATE_ALLOW_DRIFT=1 to acknowledge and continue.',
    );
  }

  const pending = files.filter(({ file }) => !applied.has(file));
  if (pending.length === 0) {
    console.log(`nothing to do — ${files.length} migration(s) already applied to ${redact(url)}`);
    if (!dryRun) analyzeNeverAnalyzed(url);
    return;
  }
  console.log(`${dryRun ? 'would apply' : 'applying'} ${pending.length} migration(s) to ${redact(url)}`);

  for (const { file, path, checksum } of pending) {
    if (dryRun) {
      console.log(`  would apply  ${file}`);
      continue;
    }
    const started = Date.now();
    process.stdout.write(`  apply  ${file} ... `);
    // -1 wraps the file AND its ledger row in one transaction: either the
    // migration and its record both land, or neither does.
    const res = psql(
      url,
      [
        '-1',
        '-q',
        '-f',
        path,
        '-c',
        `insert into public.applied_migrations(filename, checksum, duration_ms) values ('${file}', '${checksum}', 0)`,
      ],
      { capture: true },
    );
    if (!res.ok) {
      process.stdout.write('FAILED\n');
      process.stderr.write(res.stderr);
      fail(`migration ${file} failed — the transaction was rolled back, nothing was applied`);
    }
    const ms = Date.now() - started;
    psql(url, ['-q', '-c', `update public.applied_migrations set duration_ms = ${ms} where filename = '${file}'`]);
    process.stdout.write(`ok (${ms}ms)\n`);
  }
  if (!dryRun) analyzeNeverAnalyzed(url);
  console.log('migrations applied');
}

// A table the planner has never seen analyzed (reltuples = -1) is estimated at
// 10 pages of rows however empty it is, and the wide entity reads left-join ~25
// such tables: CI measured a 3-row read estimated at 7.8e13 rows. Only DDL puts
// a table in that state (CREATE, TRUNCATE) and only migrations run DDL, so this
// is the one place that keeps it from coming back. 225 carries the evidence.
//
// After EVERY up, including one with nothing pending: it touches only tables
// at -1, so the usual cost is one catalog query. A failure is a warning, not a
// failed deploy — the schema is already correct, only the estimates are not.
function analyzeNeverAnalyzed(url) {
  const hasFn = query(url, "select to_regprocedure('internal.analyze_never_analyzed_tables()') is not null");
  if (hasFn[0]?.[0] !== 't') return;
  const res = psql(url, ['-A', '-t', '-q', '-c', 'select internal.analyze_never_analyzed_tables()'], { quiet: true });
  if (!res.ok) {
    console.warn(`warning: could not analyze never-analyzed tables: ${res.stderr.trim()}`);
    return;
  }
  // A table the login may not ANALYZE comes back as a WARNING on stderr, and
  // psql exits 0 for it; print it, or the skip is silent.
  const warnings = res.stderr.split('\n').filter((line) => line.startsWith('WARNING:'));
  for (const line of warnings) console.warn(`warning: ${line.replace(/^WARNING:\s*/, '')}`);
  const analyzed = res.stdout.split('\n').filter((line) => line.length > 0);
  if (analyzed.length) console.log(`analyzed ${analyzed.length} never-analyzed table(s)`);
}

function cmdCreateDb(url) {
  const name = databaseNameOf(url);
  const adminUrl = urlWithDatabase(url, process.env.TM8_ADMIN_DB || 'postgres');
  if (!canConnect(adminUrl)) fail(`cannot reach the server at ${redact(adminUrl)}`);
  const exists = query(adminUrl, `select 1 from pg_database where datname = '${name}'`).length > 0;
  if (exists) {
    console.log(`database ${name} already exists`);
    return;
  }
  const res = psql(adminUrl, ['-q', '-c', `create database ${quoteIdent(name)}`]);
  if (!res.ok) fail(`could not create database ${name}`);
  console.log(`created database ${name}`);
}

async function cmdReset(url, { force }) {
  if (!force && process.env.TM8_ALLOW_RESET !== '1') {
    fail('reset DROPS the database. Re-run with --force (or TM8_ALLOW_RESET=1).');
  }
  const name = databaseNameOf(url);
  const adminUrl = urlWithDatabase(url, process.env.TM8_ADMIN_DB || 'postgres');
  if (!canConnect(adminUrl)) fail(`cannot reach the server at ${redact(adminUrl)}`);
  const res = psql(adminUrl, ['-q', '-c', `drop database if exists ${quoteIdent(name)} with (force)`]);
  if (!res.ok) fail(`could not drop database ${name}`);
  console.log(`dropped database ${name}`);
  cmdCreateDb(url);
  await cmdUp(url, { dryRun: false });
}

// --- utilities --------------------------------------------------------------
function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail(`refusing an unsafe database name: ${name}`);
  return `"${name}"`;
}

function redact(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return url;
  }
}

function fail(message) {
  console.error(`db/migrate.mjs: ${message}`);
  process.exit(1);
}

// --- entry point ------------------------------------------------------------
const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith('-')) || 'status';
const flags = new Set(args.filter((a) => a.startsWith('-')));
const url = databaseUrl();

switch (command) {
  case 'status':
    cmdStatus(url);
    break;
  case 'up':
    await cmdUp(url, { dryRun: flags.has('--dry-run') || flags.has('-n') });
    break;
  case 'create-db':
    cmdCreateDb(url);
    break;
  case 'reset':
    await cmdReset(url, { force: flags.has('--force') || flags.has('-f') });
    break;
  case 'help':
  case '--help':
  case '-h':
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 25).join('\n').replace(/^\/\/ ?/gm, ''));
    break;
  default:
    fail(`unknown command: ${command} (try: status | up | create-db | reset | help)`);
}
