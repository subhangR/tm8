/**
 * The CLI integration harness refuses the PROD port (5442) and an unset port,
 * and passes on the test cluster (5443). Pure: no database is contacted.
 */
import { describe, expect, it } from 'vitest';

import { TestPgPortRefusal, testAdminUrl } from './integration/pg-port-guard.js';

describe('CLI integration harness — test Postgres port guard', () => {
  it('refuses when nothing names a port', () => {
    expect(() => testAdminUrl({})).toThrow(TestPgPortRefusal);
    expect(() => testAdminUrl({})).toThrow(/TM8_PG_PORT=5443/);
    expect(() => testAdminUrl({ TM8_PG_PORT: '  ' })).toThrow(/unset/);
  });

  it('refuses TM8_PG_PORT=5442', () => {
    expect(() => testAdminUrl({ TM8_PG_PORT: '5442' })).toThrow(/TM8_PG_PORT=5442.*TM8_PG_PORT=5443/);
  });

  it('refuses an admin URL on 5442, whichever variable carries it', () => {
    for (const name of ['TM8_W4_ADMIN_DATABASE_URL', 'TM8_MIGRATION_DATABASE_URL']) {
      expect(() => testAdminUrl({ [name]: 'postgres://tm8@127.0.0.1:5442/postgres', TM8_PG_PORT: '5443' }))
        .toThrow(new RegExp(`${name} is on port 5442`));
    }
  });

  it('refuses an admin URL with no explicit port', () => {
    expect(() => testAdminUrl({ TM8_W4_ADMIN_DATABASE_URL: 'postgres://tm8@127.0.0.1/postgres' })).toThrow(/no explicit port/);
  });

  it('never echoes a password from the URL', () => {
    try {
      testAdminUrl({ TM8_MIGRATION_DATABASE_URL: 'postgres://tm8:hunter2@127.0.0.1:5442/postgres' });
    } catch (error) {
      expect((error as Error).message).not.toContain('hunter2');
    }
  });

  it('passes on 5443', () => {
    expect(testAdminUrl({ TM8_PG_PORT: '5443' })).toBe('postgres://tm8@127.0.0.1:5443/postgres');
    expect(testAdminUrl({ TM8_PG_PORT: '5443', TM8_PG_USER: 'me' })).toBe('postgres://me@127.0.0.1:5443/postgres');
    expect(testAdminUrl({ TM8_W4_ADMIN_DATABASE_URL: 'postgres://tm8@127.0.0.1:5443/postgres' }))
      .toBe('postgres://tm8@127.0.0.1:5443/postgres');
    expect(testAdminUrl({ TM8_MIGRATION_DATABASE_URL: 'postgres://tm8@127.0.0.1:5443/postgres' }))
      .toBe('postgres://tm8@127.0.0.1:5443/postgres');
  });

  it('the W4 URL wins over the migration URL (unchanged precedence)', () => {
    expect(testAdminUrl({
      TM8_W4_ADMIN_DATABASE_URL: 'postgres://tm8@127.0.0.1:5443/postgres',
      TM8_MIGRATION_DATABASE_URL: 'postgres://tm8@127.0.0.1:5442/postgres',
    })).toBe('postgres://tm8@127.0.0.1:5443/postgres');
  });

  it('admits 5442 only on a GitHub Actions runner (its own service container); unset is still refused there', () => {
    expect(testAdminUrl({ GITHUB_ACTIONS: 'true', TM8_MIGRATION_DATABASE_URL: 'postgres://tm8@127.0.0.1:5442/postgres' }))
      .toBe('postgres://tm8@127.0.0.1:5442/postgres');
    expect(testAdminUrl({ GITHUB_ACTIONS: 'true', TM8_PG_PORT: '5442' })).toBe('postgres://tm8@127.0.0.1:5442/postgres');
    expect(() => testAdminUrl({ GITHUB_ACTIONS: 'true' })).toThrow(/unset/);
    expect(() => testAdminUrl({ GITHUB_ACTIONS: '1', TM8_PG_PORT: '5442' })).toThrow(TestPgPortRefusal);
  });
});
