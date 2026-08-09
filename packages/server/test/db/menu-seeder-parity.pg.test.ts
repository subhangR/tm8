/**
 * The server default-menu seeder vs the client shipped default — the test the
 * 059 regression proved was missing.
 *
 * Migration 059 rewrote `internal.w1_default_menu_payload()` from the 045
 * payload and silently dropped the Voice group the voice lane had added
 * client-side (tm8-ui `SHIPPED_DEFAULT_MENU`). Every suite stayed green; the
 * STABLE DEPLOYMENT caught it, because no test asserted the served default's
 * group list. Fixed by 061; this file makes the next such rewrite loud.
 *
 * The expected list comes from the contract's `DEFAULT_MENU_GROUP_SPINE` —
 * the ONE constant both twins are pinned to (tm8-ui's menu.test.ts pins the
 * client side against the same spine). It was a hand-copied literal here at
 * first; the voice lane probed that version and measured the gap — deleting
 * the client's voice group left this test green — which is exactly the
 * two-unjoined-twins shape that produced four incidents on 2026-07-31. Now a
 * group added or dropped on either side must go through the spine, where both
 * tests see it. (`workspace` client-side is `work` server-side — the spine
 * encodes that historical split rather than pretending the ids match.)
 * (The voice group is items-EMPTY by necessity, not omission: `MenuViewRef`
 * is a closed enum with no 'voice', so the channels-style view ref is not
 * available without a frozen-contract amendment. GateApp hangs live
 * voice_channel rows beneath the group id.)
 *
 * Needs a database: set TM8_DATABASE_URL. Skipped loudly otherwise, same as
 * the rest of this directory.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_MENU_GROUP_SPINE,
  DEFAULT_MENU_WORKSPACE_KIND_SPINE,
} from '@tm8/contract';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

const DATABASE_URL = process.env.TM8_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
const LOOPS_MENU_MIGRATION_SUFFIX = '_menu_loops_row.sql';

function loopsMenuMigration(files: readonly string[]): string {
  const matches = files.filter((file) => file.endsWith(LOOPS_MENU_MIGRATION_SUFFIX));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one *${LOOPS_MENU_MIGRATION_SUFFIX} migration, found ${matches.length}: ${matches.join(', ')}`,
    );
  }
  return matches[0]!;
}

describeDb('default-menu seeder parity (the 059 lesson)', () => {
  let db: W1ScratchDatabase;

  beforeAll(async () => {
    db = await createW1ScratchDatabase('menu-seeder-parity');
    // The FULL chain, deliberately: the seeder is redefined by whichever
    // migration touched it last (045 → 059 → 061), so a subset would test a
    // superseded definition — the exact mistake the instruments memory warns
    // about ("a migration file is not the definition of its own function").
    db.apply(migrationFiles());
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  }, 30_000);

  it('serves every group the client shipped default promises, in order', async () => {
    const rows = await db.query<{ ids: string[] }>(
      `select array_agg(g->>'id' order by ord) as ids
         from jsonb_array_elements(internal.w1_default_menu_payload()->'groups')
              with ordinality as t(g, ord)`,
    );
    expect(rows[0]?.ids).toEqual(DEFAULT_MENU_GROUP_SPINE.map((g) => g.serverId));
  });

  it('keeps the voice group items-empty — the only shape the closed MenuViewRef union permits', async () => {
    const rows = await db.query<{ items: unknown }>(
      `select g->'items' as items
         from jsonb_array_elements(internal.w1_default_menu_payload()->'groups') g
        where g->>'id' = 'voice'`,
    );
    expect(rows[0]?.items).toEqual([]);
  });

  it('names all eight Workspace kinds in client order, filling but not widening the cap', async () => {
    const rows = await db.query<{ refs: string[] }>(
      `select array_agg(child->>'ref' order by child_ord) as refs
         from jsonb_array_elements(internal.w1_default_menu_payload()->'groups') g,
              jsonb_array_elements(g->'items') item,
              jsonb_array_elements(item->'children') with ordinality children(child, child_ord)
        where g->>'id' = 'work'
          and item->>'type' = 'view'
          and item->>'ref' = 'workspace'`,
    );
    expect(rows[0]?.refs).toEqual(DEFAULT_MENU_WORKSPACE_KIND_SPINE);
    expect(rows[0]?.refs).toHaveLength(8);
  });

  it('names Files, Spells and Collections as first-class Library rows', async () => {
    const rows = await db.query<{ refs: string[] }>(
      `select array_agg(item->>'ref' order by item_ord) as refs
         from jsonb_array_elements(internal.w1_default_menu_payload()->'groups') g,
              jsonb_array_elements(g->'items') with ordinality items(item, item_ord)
        where g->>'id' = 'library'`,
    );
    expect(rows[0]?.refs).toEqual(['file', 'spell', 'collection']);
  });
});

describeDb('Loop default-menu saved-row compatibility', () => {
  let db: W1ScratchDatabase;
  let oldDefault: unknown;
  let customized: unknown;

  beforeAll(async () => {
    const files = migrationFiles();
    const migration = loopsMenuMigration(files);
    const migrationIndex = files.indexOf(migration);
    if (migrationIndex < 0) throw new Error(`${migration} is missing from the migration chain`);

    db = await createW1ScratchDatabase('menu-loops-upgrade');
    // Position-pinned on purpose: characterize a real 071-default saved row
    // immediately before the migration under test, then apply that migration.
    db.apply(files.slice(0, migrationIndex));

    oldDefault = (await db.query<{ payload: unknown }>(
      `select internal.w1_default_menu_payload() payload`,
    ))[0]!.payload;
    customized = (await db.query<{ payload: unknown }>(
      `select jsonb_set($1::jsonb, '{groups,0,label}', to_jsonb('My Home'::text)) payload`,
      [oldDefault],
    ))[0]!.payload;

    await db.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const ids = (await client.query<{ untouched: string; custom: string }>(
        `select internal.new_id()::text untouched, internal.new_id()::text custom`,
      )).rows[0]!;
      await client.query(
        `insert into public.user_profiles(identity_id, display_name)
         values ('menu-loops-owner', 'Menu loops owner')`,
      );
      await client.query(
        `insert into public.spaces(id, name, created_by_identity)
         values ($1, 'Untouched default', 'menu-loops-owner'),
                ($2, 'Customized menu', 'menu-loops-owner')`,
        [ids.untouched, ids.custom],
      );
      await client.query(
        `insert into public.space_menu_configs(space_id, schema_version, revision, payload)
         values ($1, 1, 41, $2::jsonb), ($3, 1, 73, $4::jsonb)`,
        [ids.untouched, oldDefault, ids.custom, customized],
      );
    });

    db.apply([migration]);
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  }, 30_000);

  it('upgrades only the untouched default and preserves per-Space revision semantics', async () => {
    const rows = await db.query<{ name: string; revision: number; payload: unknown }>(
      `select s.name, menu.revision, menu.payload
         from public.spaces s
         join public.space_menu_configs menu on menu.space_id = s.id
        order by s.name`,
    );
    const seeded = (await db.query<{ payload: unknown }>(
      `select internal.w1_default_menu_payload() payload`,
    ))[0]!.payload;

    expect(rows).toEqual([
      { name: 'Customized menu', revision: 73, payload: customized },
      { name: 'Untouched default', revision: 42, payload: seeded },
    ]);
    expect(rows[0]!.payload).not.toEqual(seeded);
  });

  it('serves Loop as the eighth Workspace child after the upgrade', async () => {
    const rows = await db.query<{ refs: string[] }>(
      `select array_agg(child->>'ref' order by child_ord) refs
         from jsonb_array_elements(internal.w1_default_menu_payload()->'groups') g,
              jsonb_array_elements(g->'items') item,
              jsonb_array_elements(item->'children') with ordinality children(child, child_ord)
        where g->>'id' = 'work'
          and item->>'ref' = 'workspace'`,
    );
    expect(rows[0]?.refs).toEqual(DEFAULT_MENU_WORKSPACE_KIND_SPINE);
    expect(rows[0]?.refs.at(-1)).toBe('loop');
  });
});
