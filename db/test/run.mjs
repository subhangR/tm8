#!/usr/bin/env node
// Reset the test database, apply the whole sequence, then run every suite.
//
//   node db/test/run.mjs
//   TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_cygnus node db/test/run.mjs
//
// Uses a database SEPARATE from tm8_dev so a test run can never touch the
// database the facade is developed against. TM8_DATABASE_URL wins when set, and
// is passed down verbatim so migrate.mjs and helpers.mjs cannot disagree about
// which database is under test.
//
// Suites run with --test-concurrency=1 deliberately. Accounts are node-wide and
// there is exactly one owner per node, so parallel suites would race on the
// bootstrap; serial suites also make the shared session-concurrency cap
// (internal.live_work_session_count) predictable.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(HERE, '..');

function resolveUrl() {
  if (process.env.TM8_DATABASE_URL) return process.env.TM8_DATABASE_URL;
  const user = process.env.TM8_PG_USER || process.env.USER || 'postgres';
  const host = process.env.TM8_PG_HOST || '127.0.0.1';
  const port = process.env.TM8_PG_PORT || '5442';
  const db = process.env.TM8_TEST_DB || 'tm8_test';
  return `postgres://${user}@${host}:${port}/${db}`;
}

const url = resolveUrl();
const testDb = new URL(url).pathname.replace(/^\//, '');
const env = { ...process.env, TM8_DATABASE_URL: url, TM8_TEST_DB: testDb, TM8_ALLOW_RESET: '1' };

function step(label, command, args) {
  process.stdout.write(`\n==> ${label}\n`);
  const result = spawnSync(command, args, { stdio: 'inherit', env, cwd: DB_DIR });
  if (result.status !== 0) {
    process.stderr.write(`\n${label} failed\n`);
    process.exit(result.status ?? 1);
  }
}

step(`reset ${testDb} and apply migrations`, process.execPath, [
  join(DB_DIR, 'migrate.mjs'),
  'reset',
  '--force',
]);

// Explicit, lexically sorted file list rather than the directory: node 25 no
// longer expands a bare directory positional under --test (it tries to load it as
// a module), and an explicit list also fixes the ORDER, which matters because the
// suites share one database.
const suites = readdirSync(HERE)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => join(HERE, f));
if (suites.length === 0) {
  process.stderr.write(`no *.test.mjs suites found in ${HERE}\n`);
  process.exit(1);
}
step(`run ${suites.length} db suite(s)`, process.execPath, ['--test', '--test-concurrency=1', ...suites]);

process.stdout.write('\nall db suites green\n');
