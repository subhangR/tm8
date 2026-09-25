/**
 * packages/server's scratch-database harness (w1-pg.ts) refuses the PROD port
 * (5442) and an unset port, and passes on the test cluster (5443). Pure: no
 * database is contacted.
 */
import { describe, expect, it } from 'vitest';

import { TestPgPortRefusal, testAdminUrl } from './pg-port-guard.js';

const URL_VARS = ['TM8_W1_ADMIN_DATABASE_URL', 'TM8_MIGRATION_DATABASE_URL', 'TM8_DATABASE_URL'];

describe('server DB test harness — test Postgres port guard', () => {
  it('refuses when nothing names a port', () => {
    expect(() => testAdminUrl({})).toThrow(TestPgPortRefusal);
    expect(() => testAdminUrl({})).toThrow(/unset.*TM8_W1_ADMIN_DATABASE_URL=postgres:\/\/tm8@127\.0\.0\.1:5443/);
  });

  it('refuses TM8_PG_PORT=5442', () => {
    expect(() => testAdminUrl({ TM8_PG_PORT: '5442' })).toThrow(/TM8_PG_PORT=5442/);
  });

  it('refuses a URL on 5442 in every variable the harness reads', () => {
    for (const name of URL_VARS) {
      expect(() => testAdminUrl({ [name]: 'postgres://tm8@127.0.0.1:5442/postgres', TM8_PG_PORT: '5443' }))
        .toThrow(new RegExp(`${name} is on port 5442`));
    }
  });

  it('refuses a URL with no explicit port', () => {
    expect(() => testAdminUrl({ TM8_DATABASE_URL: 'postgres://tm8@localhost/tm8_dev' })).toThrow(/no explicit port/);
  });

  it('never echoes a password from the URL', () => {
    expect(() => testAdminUrl({ TM8_W1_ADMIN_DATABASE_URL: 'postgres://tm8:hunter2@127.0.0.1:5442/postgres' }))
      .toThrow(expect.objectContaining({ message: expect.not.stringContaining('hunter2') }));
  });

  it('passes on 5443', () => {
    expect(testAdminUrl({ TM8_PG_PORT: '5443' })).toBe('postgres://tm8@127.0.0.1:5443/postgres');
    for (const name of URL_VARS) {
      expect(testAdminUrl({ [name]: 'postgres://tm8@127.0.0.1:5443/postgres' })).toBe('postgres://tm8@127.0.0.1:5443/postgres');
    }
  });

  it('keeps the old precedence: the W1 URL wins', () => {
    expect(testAdminUrl({
      TM8_W1_ADMIN_DATABASE_URL: 'postgres://tm8@127.0.0.1:5443/postgres',
      TM8_DATABASE_URL: 'postgres://tm8@127.0.0.1:5442/tm8_dev',
    })).toBe('postgres://tm8@127.0.0.1:5443/postgres');
  });
});
