// The db/ suites' port guard refuses the PROD port (5442) and an unset port, and
// passes on the test cluster (5443). Pure: no database is contacted.
//
//   node --test db/test/pg-port-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TestPgPortRefusal, testDatabaseUrl } from './pg-port-guard.mjs';

test('refuses when nothing names a port', () => {
  assert.throws(() => testDatabaseUrl({}, 'tm8_test'), TestPgPortRefusal);
  assert.throws(() => testDatabaseUrl({}, 'tm8_test'), /unset.*TM8_PG_PORT=5443/);
});

test('refuses TM8_PG_PORT=5442', () => {
  assert.throws(() => testDatabaseUrl({ TM8_PG_PORT: '5442' }, 'tm8_test'), /TM8_PG_PORT=5442/);
});

test('refuses TM8_DATABASE_URL on 5442 or with no port, and hides its password', () => {
  assert.throws(
    () => testDatabaseUrl({ TM8_DATABASE_URL: 'postgres://tm8:hunter2@127.0.0.1:5442/tm8_test', TM8_PG_PORT: '5443' }, 'x'),
    (error) => error instanceof TestPgPortRefusal && /on port 5442/.test(error.message) && !error.message.includes('hunter2'),
  );
  assert.throws(() => testDatabaseUrl({ TM8_DATABASE_URL: 'postgres://tm8@localhost/tm8_test' }, 'x'), /no explicit port/);
});

test('passes on 5443', () => {
  assert.equal(
    testDatabaseUrl({ TM8_PG_PORT: '5443', TM8_PG_USER: 'tm8' }, 'tm8_test'),
    'postgres://tm8@127.0.0.1:5443/tm8_test',
  );
  assert.equal(
    testDatabaseUrl({ TM8_DATABASE_URL: 'postgres://tm8@127.0.0.1:5443/tm8_cygnus' }, 'ignored'),
    'postgres://tm8@127.0.0.1:5443/tm8_cygnus',
  );
});

test('admits 5442 only on a GitHub Actions runner; unset is still refused there', () => {
  assert.equal(
    testDatabaseUrl({ GITHUB_ACTIONS: 'true', TM8_DATABASE_URL: 'postgres://tm8@127.0.0.1:5442/tm8_test' }, 'x'),
    'postgres://tm8@127.0.0.1:5442/tm8_test',
  );
  assert.throws(() => testDatabaseUrl({ GITHUB_ACTIONS: 'true' }, 'x'), TestPgPortRefusal);
});
