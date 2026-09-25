/**
 * The real-node fixture's port guard refuses the PROD port (5442) and an unset
 * port, and passes on the test cluster (5443). Pure: no database is contacted.
 */
import { describe, expect, it } from 'vitest';

import { TestPgPortRefusal, testPgPort } from './pg-port-guard';

describe('UI real-node fixture — test Postgres port guard', () => {
  it('refuses when TM8_PG_PORT is unset or blank', () => {
    expect(() => testPgPort({})).toThrow(TestPgPortRefusal);
    expect(() => testPgPort({})).toThrow(/unset.*TM8_PG_PORT=5443/);
    expect(() => testPgPort({ TM8_PG_PORT: ' ' })).toThrow(/unset/);
  });

  it('refuses TM8_PG_PORT=5442', () => {
    expect(() => testPgPort({ TM8_PG_PORT: '5442' })).toThrow(/TM8_PG_PORT=5442.*TM8_PG_PORT=5443/);
  });

  it('passes on 5443', () => {
    expect(testPgPort({ TM8_PG_PORT: '5443' })).toBe('5443');
  });
});
