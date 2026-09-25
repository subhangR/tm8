/**
 * 225 — no table is left at `reltuples = -1`, and the wide entity reads plan
 * on real numbers because of it.
 *
 * A never-analyzed table is estimated at 10 pages of rows however empty it is.
 * The wide reads (ENTITY_FROM, the projector's SUMMARY_SQL) left-join ~30 of
 * them, and on a young database — a small ANALYZEd `entities`, every detail
 * table still at -1, which is every CI integration server — the estimate
 * compounds past 1e12 for a 3-row read. Measured through the real CLI receipt
 * suite on PG 17: 151 of 561 wide reads over jit_above_cost, max estimate
 * 5.15e12 for 4 rows; with 225, none, max 4.
 *
 * Two halves, because the fix has two halves:
 *   - the RUNNER calls `internal.analyze_never_analyzed_tables()` after every
 *     `up`, so a table a later migration creates (or a TRUNCATE resets) is
 *     analyzed in the same deploy;
 *   - 225 itself analyzes everything at -1 when it lands, and the planner then
 *     estimates the wide reads within 10x of the id count.
 *
 * Each half carries its negative control: the bad state is built and shown to
 * be bad before the fix is applied to it.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ENTITY_COLUMNS, ENTITY_FROM } from '../../src/facade/entity-read.js';
import { SUMMARY_SQL } from '../../src/events/projector.js';
import { createW1ScratchDatabase, migrationFiles, MIGRATIONS_DIR, REPO_ROOT, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 600_000 });

const MIGRATION = '225_analyze_never_analyzed_tables.sql';

/** Every public table the two wide reads name, from their own text. */
function tablesOf(sql: string): string[] {
  return [...sql.matchAll(/\b(?:from|join)\s+public\.([a-z_]+)/g)].map((m) => m[1]!);
}
const WIDE_READ_TABLES = [...new Set([...tablesOf(ENTITY_FROM), ...tablesOf(SUMMARY_SQL)])].sort();

async function neverAnalyzed(database: W1ScratchDatabase, schemas: readonly string[]): Promise<string[]> {
  const rows = await database.query<{ rel: string }>(
    `select c.relname as rel
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1::text[]) and c.relkind in ('r', 'p') and c.reltuples < 0
      order by 1`,
    [schemas],
  );
  return rows.map((r) => r.rel);
}

describe.sequential('the runner analyzes what a migration leaves never-analyzed', () => {
  let root: string;
  let database: W1ScratchDatabase;

  function runner(): string {
    const result = spawnSync(process.execPath, [join(root, 'db', 'migrate.mjs'), 'up'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, TM8_DATABASE_URL: database.url },
    });
    expect(result.status, `${result.stdout ?? ''}\n${result.stderr ?? ''}`).toBe(0);
    return result.stdout ?? '';
  }

  async function reltuples(table: string): Promise<number> {
    const [row] = await database.query<{ reltuples: number }>(
      `select reltuples from pg_class where oid = to_regclass($1)`,
      [table],
    );
    return Number(row!.reltuples);
  }

  beforeAll(async () => {
    // 001-015 plus 225 is enough: 225 needs only the `internal` schema and
    // tm8_graph_owner, and a short chain keeps this half fast.
    root = mkdtempSync(join(tmpdir(), 'tm8-analyze-runner-'));
    mkdirSync(join(root, 'db', 'migrations'), { recursive: true });
    cpSync(join(REPO_ROOT, 'db', 'migrate.mjs'), join(root, 'db', 'migrate.mjs'));
    const files = migrationFiles();
    const chain = [...files.slice(0, files.indexOf('015_w1_foundations.sql') + 1), MIGRATION];
    expect(chain).toHaveLength(16);
    for (const file of chain) cpSync(join(MIGRATIONS_DIR, file), join(root, 'db', 'migrations', file));
    database = await createW1ScratchDatabase('analyze_runner');
  });

  afterAll(async () => {
    await database?.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  it('leaves no public or internal table at reltuples -1 after up', async () => {
    runner();
    expect(await neverAnalyzed(database, ['public', 'internal'])).toEqual([]);
  });

  it('analyzes a table a LATER migration creates, in the same run', async () => {
    writeFileSync(
      join(root, 'db', 'migrations', '990_probe_new_table.sql'),
      'create table public.analyze_probe (entity_id uuid primary key, name text);\n',
    );
    const output = runner();
    expect(output).toContain('apply  990_probe_new_table.sql');
    // A new empty table is born at -1; the runner is the only thing that moves it.
    expect(await reltuples('public.analyze_probe')).toBe(0);
    expect(output).toContain('analyzed 1 never-analyzed table(s)');
  });

  it('heals a TRUNCATE on a run with nothing pending', async () => {
    await database.query('truncate public.analyze_probe');
    expect(await reltuples('public.analyze_probe')).toBe(-1); // the precondition: TRUNCATE resets it
    const output = runner();
    expect(output).toContain('nothing to do');
    expect(await reltuples('public.analyze_probe')).toBe(0);
  });
});

describe.sequential('the wide entity reads estimate on real numbers after the full chain', () => {
  let database: W1ScratchDatabase;
  const IDENTITY = 'analyze-estimate-owner';
  const SPACE = '01a0d7a3-0000-7000-8000-000000000001';
  const MEMBER = '01a0d7a3-0000-7000-8000-000000000002';
  const IDS = [
    '01a0d7a3-0000-7000-8000-000000000011',
    '01a0d7a3-0000-7000-8000-000000000012',
    '01a0d7a3-0000-7000-8000-000000000013',
  ];

  /** The planner's row estimate and total cost for a read, AS tm8_app with RLS on — how the server runs it. */
  async function plan(sql: string): Promise<{ rows: number; cost: number }> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true), set_config('tm8.node_admin', 'false', true)`, [IDENTITY]);
      const result = await client.query<{ 'QUERY PLAN': Array<{ Plan: { 'Plan Rows': number; 'Total Cost': number } }> }>(
        `explain (format json) ${sql}`,
        [IDS],
      );
      const top = result.rows[0]!['QUERY PLAN'][0]!.Plan;
      return { rows: top['Plan Rows'], cost: top['Total Cost'] };
    });
  }
  const READS = {
    // The real column list: select only e.id and the planner REMOVES the unique
    // left joins, and the read under test is gone.
    'ENTITY_FROM any($1)': `select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = any($1::uuid[])`,
    'projector SUMMARY_SQL': SUMMARY_SQL,
  };

  beforeAll(async () => {
    database = await createW1ScratchDatabase('analyze_estimate');
    database.apply(migrationFiles());
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('names at least 30 tables, and every one of them exists', async () => {
    // Guards the parse: an empty or shrunken list would make the next checks vacuous.
    expect(WIDE_READ_TABLES.length).toBeGreaterThanOrEqual(30);
    const rows = await database.query<{ name: string }>(
      `select name from unnest($1::text[]) name where to_regclass('public.' || name) is null`,
      [WIDE_READ_TABLES],
    );
    expect(rows).toEqual([]);
  });

  it('leaves no public or internal table never-analyzed, wide-read tables included', async () => {
    expect(await neverAnalyzed(database, ['public', 'internal'])).toEqual([]);
  });

  it('estimates a 3-id wide read within 10x of 3, where the never-analyzed state estimates past 1e6', async () => {
    // THE BAD STATE, rebuilt on purpose. TRUNCATE puts an empty table back at
    // -1 (as CREATE does); a table another non-empty table references refuses,
    // which is fine — most of the detail tables go.
    await database.query(`
      do $$
      declare rel regclass;
      begin
        for rel in select c.oid::regclass from pg_class c
                    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
                      and pg_relation_size(c.oid) = 0
        loop
          begin execute format('truncate %s', rel);
          exception when others then null;
          end;
        end loop;
      end $$`);
    const wideAtMinusOne = async (): Promise<string[]> =>
      (await neverAnalyzed(database, ['public'])).filter((t) => WIDE_READ_TABLES.includes(t));
    expect((await wideAtMinusOne()).length).toBeGreaterThanOrEqual(20);

    // A young space: a handful of entities, and `entities` analyzed — which is
    // what autovacuum does first on a CI server, and what makes the detail
    // tables' 10-page guesses compound.
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'Owner')`, [IDENTITY]);
      await client.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'analyze', $2)`, [SPACE, IDENTITY]);
      await client.query(
        `insert into public.entities(id, space_id, kind, position, created_by)
         select id, $2, kind, ord::int, $1
           from unnest($3::uuid[], $4::text[]) with ordinality as x(id, kind, ord)`,
        [MEMBER, SPACE, [MEMBER, ...IDS], ['member', 'task', 'task', 'task']],
      );
      await client.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'owner', 'Owner')`,
        [MEMBER, SPACE, IDENTITY],
      );
      await client.query(
        `insert into public.tasks(entity_id, title, work_status, priority) select unnest($1::uuid[]), 'T', 'open', 'medium'`,
        [IDS],
      );
    });
    await database.query('analyze public.entities');

    // NEGATIVE CONTROL: the state is bad, so a pass below is the fix's doing.
    for (const [name, sql] of Object.entries(READS)) {
      const before = await plan(sql);
      expect(before.rows, `${name} before`).toBeGreaterThan(1e6);
    }

    // Taken HERE, after the fixture's own ANALYZE of entities, so it is exactly
    // what the function has left to do.
    const pending = await wideAtMinusOne();
    expect(pending.length).toBeGreaterThanOrEqual(20);
    const analyzed = (await database.query<{ rel: string }>(
      `select internal.analyze_never_analyzed_tables()::text as rel`,
    )).map((r) => r.rel.replace(/^public\./, ''));
    expect(analyzed).toEqual(expect.arrayContaining(pending));
    expect(await wideAtMinusOne()).toEqual([]);

    for (const [name, sql] of Object.entries(READS)) {
      const after = await plan(sql);
      expect(after.rows, `${name} after`).toBeLessThanOrEqual(IDS.length * 10);
      // Under jit_above_cost (100000): no LLVM compile for a 3-row read.
      expect(after.cost, `${name} after`).toBeLessThan(100_000);
    }
  });
});
