#!/usr/bin/env node
// Reset the test database, apply the whole sequence, then run every suite.
//
//   node db/test/run.mjs
//
// Uses a database SEPARATE from tm8_dev so a test run can never touch the
// database the facade is developed against.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(HERE, '..');
const TEST_DB = process.env.TM8_TEST_DB || 'tm8_test';

const env = { ...process.env, TM8_DB: TEST_DB, TM8_ALLOW_RESET: '1' };

function step(label, command, args) {
  process.stdout.write(`\n==> ${label}\n`);
  const result = spawnSync(command, args, { stdio: 'inherit', env, cwd: DB_DIR });
  if (result.status !== 0) {
    process.stderr.write(`\n${label} failed\n`);
    process.exit(result.status ?? 1);
  }
}

step(`reset ${TEST_DB} and apply migrations`, process.execPath, [
  join(DB_DIR, 'migrate.mjs'),
  'reset',
  '--force',
]);

step('run db suites', process.execPath, ['--test', join(HERE)]);

process.stdout.write('\nall db suites green\n');
