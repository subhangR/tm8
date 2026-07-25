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
//   * ZERO npm dependencies: it drives `psql`, which the sidecar already ships.
//     (Same discipline as tools/rigs — no lockfile churn for a dev tool.)
//
// Connection resolution (first that answers):
//   $TM8_DATABASE_URL → $DATABASE_URL → postgres://$USER@127.0.0.1:$TM8_PG_PORT/$TM8_DB
// with TM8_PG_PORT defaulting to 5442 and TM8_DB to tm8_dev.
// =============================================================================

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, 'migrations');
const FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;

// --- psql discovery ---------------------------------------------------------
// The sidecar's binaries are not necessarily on PATH (they are a versioned
// Homebrew keg on macOS), so look where they actually live before giving up.
function findPsql() {
  if (process.env.TM8_PSQL) return process.env.TM8_PSQL;
  const candidates = [
    'psql',
    '/opt/homebrew/opt/postgresql@18/bin/psql',
    '/usr/local/opt/postgresql@18/bin/psql',
    '/usr/lib/postgresql/18/bin/psql',
  ];
  for (const candidate of candidates) {
    if (candidate === 'psql') {
      const probe = spawnSync('psql', ['--version'], { stdio: 'ignore' });
      if (probe.status === 0) return 'psql';
      continue;
    }
    if (existsSync(candidate)) return candidate;
  }
  fail(
    'psql not found. Install the Postgres 18 client or set TM8_PSQL to its path.\n' +
      '  brew --prefix postgresql@18  → <prefix>/bin/psql',
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

function cmdUp(url, { dryRun }) {
  if (!canConnect(url)) {
    fail(`database unreachable: ${redact(url)}\n  run: node db/migrate.mjs create-db`);
  }
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
  console.log('migrations applied');
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

function cmdReset(url, { force }) {
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
  cmdUp(url, { dryRun: false });
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
    cmdUp(url, { dryRun: flags.has('--dry-run') || flags.has('-n') });
    break;
  case 'create-db':
    cmdCreateDb(url);
    break;
  case 'reset':
    cmdReset(url, { force: flags.has('--force') || flags.has('-f') });
    break;
  case 'help':
  case '--help':
  case '-h':
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 24).join('\n').replace(/^\/\/ ?/gm, ''));
    break;
  default:
    fail(`unknown command: ${command} (try: status | up | create-db | reset | help)`);
}
