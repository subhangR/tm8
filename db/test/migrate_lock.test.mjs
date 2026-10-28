// db/migrate.mjs takes an advisory lock for the whole of `up`, so two runners
// against one database queue instead of both applying the same pending file.
// Before it, two concurrent `up`s on a fresh database both started 001 and the
// loser died with "tuple concurrently updated".
//
// Runs against the already-migrated test database, so `up` has nothing pending;
// what is under test is whether it waits for, and gives up on, a held lock.
//
//   TM8_PG_PORT=5443 node --test db/test/migrate_lock.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OWNER_URL, runRawAsync, scalar } from './helpers.mjs';

const MIGRATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrate.mjs');
const LOCK_KEY = '8389423504455985010'; // must match LOCK_KEY in db/migrate.mjs

function up(env = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [MIGRATE, 'up'], {
      env: { ...process.env, TM8_DATABASE_URL: OWNER_URL, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (status) => resolve({ status, output, elapsedMs: Date.now() - started }));
  });
}

/** Hold the migration lock from another session for `seconds`. */
function holdLock(seconds) {
  return runRawAsync(`select pg_advisory_lock(${LOCK_KEY}); select pg_sleep(${seconds});`, { url: OWNER_URL });
}

async function lockIsHeld() {
  return scalar(`select exists (select 1 from pg_locks where locktype = 'advisory' and granted)`, { url: OWNER_URL }) === 't';
}

test('up takes the lock, and releases it when it finishes', async () => {
  const result = await up();
  assert.equal(result.status, 0, result.output);
  assert.equal(await lockIsHeld(), false);
});

test('up waits behind a held lock, then runs', async () => {
  const holder = holdLock(2);
  await new Promise((r) => setTimeout(r, 300));
  const result = await up();
  await holder;
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /waiting for another migration run/);
  assert.ok(result.elapsedMs >= 1200, `up returned after ${result.elapsedMs}ms, before the lock was released`);
});

test('up gives up after TM8_MIGRATE_LOCK_TIMEOUT', async () => {
  const holder = holdLock(4);
  await new Promise((r) => setTimeout(r, 300));
  const result = await up({ TM8_MIGRATE_LOCK_TIMEOUT: '1s' });
  await holder;
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /held the lock for longer than 1s/);
});

test('a timeout that is not an interval literal is refused before it reaches SQL', async () => {
  const result = await up({ TM8_MIGRATE_LOCK_TIMEOUT: "1s'; select 1; --" });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /TM8_MIGRATE_LOCK_TIMEOUT must look like/);
});
