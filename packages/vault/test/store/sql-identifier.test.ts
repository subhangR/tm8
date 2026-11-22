import { describe, expect, it } from 'vitest';
import { sqlColumn } from '../../src/store/postgres-repos.js';

// Identifiers cannot be bound parameters, so the only record-derived SQL text is gated here (RULE 8).
describe('Postgres column guard', () => {
  it('maps store field names to snake-case columns', () => {
    expect(sqlColumn('ownerMemberId')).toBe('owner_member_id');
    expect(sqlColumn('id')).toBe('id');
    expect(sqlColumn('secretVersion')).toBe('secret_version');
  });

  it.each([
    'name = name; drop table vault.items --',
    'a"b',
    "a'b",
    'a b',
    '1abc',
    '_leading',
    '',
    'x'.repeat(64),
    'ownerMemberId)',
    'naïve',
  ])('refuses %j before it can reach a query', (name) => {
    expect(() => sqlColumn(name)).toThrow('vault store: invalid column');
  });
});
