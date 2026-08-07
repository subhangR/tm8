// CANARY — architect ruling 14. This test exists to fail one specific day.
//
// PR5 injects a member's own vendor credential into a spawned agent by building
// a filesystem path from the spawner's IDENTITY id
// (`<dataDir>/credentials/<identityId>/<provider>/`, PR2's layout), while the
// index that says the credential exists — `account_agent_credentials` — is
// keyed on ACCOUNT id and scoped by RLS through `internal.current_account_id()`.
//
// Reading a row keyed on one thing and building a path keyed on another is only
// safe because the two are 1:1. That is not a convention or a code comment: it
// is `public.accounts.identity_id text not null UNIQUE` — constraint
// `accounts_identity_id_key`, 002_identity.sql. A single ALTER TABLE ... DROP
// CONSTRAINT is all that stands between today and one account owning two
// identities.
//
// WHAT BREAKS IF IT GOES, so nobody has to reconstruct it later:
// one account with two identities shares ONE `account_agent_credentials` row
// while owning TWO credential directories. The index says "connected" for an
// identity whose directory is empty, and because `CLAUDE_CONFIG_DIR` REPLACES
// the default config location rather than adding to it, that member's agent
// launches with NO authentication at all. Silent, and worse than the problem
// PR5 solves.
//
// SO: if this test fails, do not delete it and do not relax it. Re-key the
// credential home to `account_id` in the SAME change that drops the constraint —
// `packages/server/src/credentials/agent-credential-home.ts` and
// `agent-credential-injection.ts` are the two files that must move together.
//
// Asserted BY CONSTRAINT NAME rather than by attempting a duplicate insert:
// a behavioural probe would also pass if uniqueness were enforced by some new
// trigger or partial index with different semantics, and this is precisely a
// case where "something stops duplicates" is not the same claim as "the column
// is unique".

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

let database: W1ScratchDatabase;

beforeAll(async () => {
  database = await createW1ScratchDatabase('identity_account_canary');
  database.apply(migrationFiles());
}, 180000);

afterAll(async () => {
  await database?.destroy();
});

describe('CANARY — identity is 1:1 with account, by constraint', () => {
  it('public.accounts.identity_id still carries a UNIQUE constraint named accounts_identity_id_key', async () => {
    const rows = await database.query<{ conname: string; contype: string }>(
      `select c.conname, c.contype
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public'
          and t.relname = 'accounts'
          and c.conname = 'accounts_identity_id_key'`,
    );

    expect(
      rows,
      'accounts_identity_id_key is GONE. PR5 builds credential paths from identity_id ' +
        'while reading an account-keyed index; re-key the credential home to account_id ' +
        'in the same change that dropped this. See this file header.',
    ).toHaveLength(1);
    // 'u' = unique. A constraint that still exists under a different type would
    // not carry the guarantee the credential path depends on.
    expect(rows[0]?.contype).toBe('u');
  });

  it('and identity_id is still NOT NULL, so no account can exist without one', async () => {
    // Uniqueness alone is not enough: Postgres permits many NULLs in a unique
    // column, so a nullable identity_id would let several accounts share the
    // "no identity" state while the credential path silently became
    // `<dataDir>/credentials/undefined/`.
    const rows = await database.query<{ is_nullable: string; data_type: string }>(
      `select is_nullable, data_type
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'accounts'
          and column_name = 'identity_id'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_nullable).toBe('NO');
  });
});
