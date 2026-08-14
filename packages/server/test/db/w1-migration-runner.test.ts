import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createW1ScratchDatabase,
  migrationFiles,
  MIGRATIONS_DIR,
  REPO_ROOT,
  type W1ScratchDatabase,
} from './w1-pg.js';

const DELIVERY_FUNCTIONS = [
  'claim_session_message_delivery',
  'reserve_session_message_delivery',
  'settle_session_message_delivery',
] as const;

/**
 * ⚠ POSITION-PINNED FIXTURE. Suites built on this assert CHAIN POSITION 015,
 * not present system behaviour. READ THIS BEFORE "CLEANING" ANY TEST THAT USES
 * IT: a later migration's removal never reaches these suites, so an assertion
 * about a feature the system no longer has is CORRECT here, not stale.
 * (R15 / R15b, 2026-08-07.)
 *
 * Greenness cannot classify a suite. After a removal, a green pg suite is
 * EITHER pinned below the change (leave it) OR full-chain and passing vacuously
 * (fix it) — opposite edits, and only this `.apply(...)`/copy argument tells
 * them apart. Reference counts and grep hits are non-evidence for that question.
 *
 * THIS IS ONE OF THREE BYTE-IDENTICAL COPIES of this pin —
 * `w1-foundations.test.ts` and `w2-migration-order.pg.test.ts` hold the others,
 * and each is fenced separately because a cleanup lane reaches whichever file it
 * happened to open. Editing one does not warn the next reader about the rest.
 */
function w1MigrationFiles(): string[] {
  const files = migrationFiles();
  const tail = files.indexOf('015_w1_foundations.sql');
  expect(tail).toBe(14);
  return files.slice(0, tail + 1);
}

let runnerRoot: string;

beforeAll(() => {
  runnerRoot = mkdtempSync(join(tmpdir(), 'tm8-w1-runner-'));
  const dbDir = join(runnerRoot, 'db');
  const migrationsDir = join(dbDir, 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
  cpSync(join(REPO_ROOT, 'db', 'migrate.mjs'), join(dbDir, 'migrate.mjs'));
  for (const filename of w1MigrationFiles()) {
    cpSync(join(MIGRATIONS_DIR, filename), join(migrationsDir, filename));
  }
});

afterAll(() => {
  rmSync(runnerRoot, { recursive: true, force: true });
});

function runOfficialMigrator(database: W1ScratchDatabase): string {
  const result = spawnSync(process.execPath, [join(runnerRoot, 'db', 'migrate.mjs'), 'up'], {
    cwd: runnerRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      TM8_DATABASE_URL: database.url,
    },
  });
  expect(
    result.status,
    `official migrator failed for ${database.name}:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  ).toBe(0);
  return result.stdout ?? '';
}

async function seedRunnerLedgerThrough014(database: W1ScratchDatabase): Promise<void> {
  await database.query(`
    create table public.applied_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now(),
      duration_ms integer not null default 0
    )
  `);
  for (const filename of w1MigrationFiles().slice(0, -1)) {
    const checksum = createHash('sha256')
      .update(readFileSync(join(MIGRATIONS_DIR, filename)))
      .digest('hex');
    await database.query(
      `insert into public.applied_migrations(filename, checksum) values ($1, $2)`,
      [filename, checksum],
    );
  }
}

async function expectRunnerAndAclState(database: W1ScratchDatabase): Promise<void> {
  const ledger = await database.query<{ filename: string }>(
    `select filename from public.applied_migrations order by filename`,
  );
  expect(ledger.map((row) => row.filename)).toEqual(w1MigrationFiles());

  const ownership = await database.query<{
    runner_owns_ledger: boolean;
    wrong_product_owners: number;
  }>(`
    select
      (select tableowner = current_user from pg_tables
        where schemaname = 'public' and tablename = 'applied_migrations') runner_owns_ledger,
      (select count(*)::integer from pg_tables
        where schemaname = 'public'
          and tablename <> 'applied_migrations'
          and tableowner <> 'tm8_graph_owner') wrong_product_owners
  `);
  expect(ownership[0]).toEqual({
    runner_owns_ledger: true,
    wrong_product_owners: 0,
  });

  const tablePrivileges = await database.query<{ relation_name: string; privileges: string[] }>(`
    select c.relname relation_name,
           array_remove(array[
             case when has_table_privilege('tm8_delivery_worker', c.oid, 'SELECT') then 'SELECT' end,
             case when has_table_privilege('tm8_delivery_worker', c.oid, 'INSERT') then 'INSERT' end,
             case when has_table_privilege('tm8_delivery_worker', c.oid, 'UPDATE') then 'UPDATE' end,
             case when has_table_privilege('tm8_delivery_worker', c.oid, 'DELETE') then 'DELETE' end,
             case when has_table_privilege('tm8_delivery_worker', c.oid, 'TRUNCATE') then 'TRUNCATE' end,
             case when has_table_privilege('tm8_delivery_worker', c.oid, 'REFERENCES') then 'REFERENCES' end,
             case when has_table_privilege('tm8_delivery_worker', c.oid, 'TRIGGER') then 'TRIGGER' end
           ], null) privileges
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
     order by c.relname
  `);
  expect(tablePrivileges.some((row) => row.relation_name === 'applied_migrations')).toBe(true);
  expect(tablePrivileges.every((row) => row.privileges.length === 0)).toBe(true);

  const sequencePrivileges = await database.query<{ sequence_name: string }>(`
    select c.relname sequence_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'S'
       and (has_sequence_privilege('tm8_delivery_worker', c.oid, 'USAGE')
         or has_sequence_privilege('tm8_delivery_worker', c.oid, 'SELECT')
         or has_sequence_privilege('tm8_delivery_worker', c.oid, 'UPDATE'))
     order by c.relname
  `);
  expect(sequencePrivileges).toEqual([]);

  const functionPrivileges = await database.query<{ function_name: string }>(`
    select p.proname function_name
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'internal')
       and has_function_privilege('tm8_delivery_worker', p.oid, 'EXECUTE')
     order by p.proname
  `);
  expect(functionPrivileges.map((row) => row.function_name)).toEqual(DELIVERY_FUNCTIONS);
}

describe.sequential('W1 official migration runner compatibility', () => {
  it('applies 001-015 from empty and retains the runner ledger under the closed ACL', async () => {
    const database = await createW1ScratchDatabase('runner_empty');
    try {
      expect(runOfficialMigrator(database)).toContain('migrations applied');
      await expectRunnerAndAclState(database);
    } finally {
      await database.destroy();
    }
  }, 120_000);

  it('applies 015 over a runner-ledger current 001-014 database', async () => {
    const database = await createW1ScratchDatabase('runner_current');
    try {
      const files = w1MigrationFiles();
      database.apply(files.slice(0, -1));
      await seedRunnerLedgerThrough014(database);

      const output = runOfficialMigrator(database);
      expect(output).toContain('applying 1 migration(s)');
      expect(output).toContain('apply  015_w1_foundations.sql');
      await expectRunnerAndAclState(database);
    } finally {
      await database.destroy();
    }
  }, 120_000);
});
