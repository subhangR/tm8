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
  DEFAULT_MENU_CHANNELS_SPINE,
  DEFAULT_MENU_GROUP_SPINE,
  DEFAULT_MENU_WORKSPACE_KIND_SPINE,
  DEFAULT_MENU_WORK_ITEM_SPINE,
} from '@tm8/contract';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

const DATABASE_URL = process.env.TM8_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
const LOOPS_MENU_MIGRATION_SUFFIX = '_menu_loops_row.sql';
const FILES_MENU_MIGRATION_SUFFIX = '_menu_files_view.sql';

function loopsMenuMigration(files: readonly string[]): string {
  const matches = files.filter((file) => file.endsWith(LOOPS_MENU_MIGRATION_SUFFIX));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one *${LOOPS_MENU_MIGRATION_SUFFIX} migration, found ${matches.length}: ${matches.join(', ')}`,
    );
  }
  return matches[0]!;
}

function filesMenuMigration(files: readonly string[]): string {
  const matches = files.filter((file) => file.endsWith(FILES_MENU_MIGRATION_SUFFIX));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one *${FILES_MENU_MIGRATION_SUFFIX} migration, found ${matches.length}: ${matches.join(', ')}`,
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

  it('clusters the conversation surfaces in channels, pinned to the contract spine (125)', async () => {
    // 125 renamed `chats` to `channels` (five-tab ruling R4; D2 keeps the
    // messages view riding with the channel collection). Live rooms still
    // hang beneath this group id client-side (the dynamic group).
    const rows = await db.query<{ items: Array<{ type: string; ref: string }> }>(
      `select jsonb_agg(jsonb_build_object('type', item->>'type', 'ref', item->>'ref') order by item_ord) as items
         from jsonb_array_elements(internal.w1_default_menu_payload()->'groups') g,
              jsonb_array_elements(g->'items') with ordinality items(item, item_ord)
        where g->>'id' = 'channels'`,
    );
    expect(rows[0]?.items).toEqual(DEFAULT_MENU_CHANNELS_SPINE);
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

  it('serves the whole Work group pinned to the contract item spine (125 — the retired Code fold, R3/D1)', async () => {
    // 125: the `code` group retired into Work — the three dev collections are
    // ORDINARY rows and the git view a plain childless row — and the files
    // view left for its own tab. Items, order and shape all come from the one
    // spine both twins prove against.
    const rows = await db.query<{ items: Array<{ type: string; ref: string }> }>(
      `select jsonb_agg(jsonb_build_object('type', item->>'type', 'ref', item->>'ref') order by item_ord) as items
         from jsonb_array_elements(internal.w1_default_menu_payload()->'groups') g,
              jsonb_array_elements(g->'items') with ordinality items(item, item_ord)
        where g->>'id' = 'work'`,
    );
    expect(rows[0]?.items).toEqual(
      DEFAULT_MENU_WORK_ITEM_SPINE.map((item) => ({ type: item.type, ref: item.ref })),
    );
    // The git row is childless — D1 kept the surface, R3 flattened the caret.
    const git = await db.query<{ has_children: boolean }>(
      `select (item ? 'children') as has_children
         from jsonb_array_elements(internal.w1_default_menu_payload()->'groups') g,
              jsonb_array_elements(g->'items') items(item)
        where g->>'id' = 'work' and item->>'ref' = 'git'`,
    );
    expect(git[0]?.has_children).toBe(false);
  });

  it('leads with a single-item Chats group holding dashboard (127 — the tab restored)', async () => {
    // 126 retired the `home` group and left the brand mark as the only way
    // back to conversations; 127 puts a tab back, named for what the surface
    // holds. ONE childless view item is the load-bearing detail: it is the
    // shape tm8-ui's `isRaillessGroup` keys on, and it is what keeps the
    // surface at two panes (conversation list | conversation) instead of
    // growing a rail column repeating the tab's own name.
    const rows = await db.query<{ items: Array<{ type: string; ref: string }> }>(
      `select jsonb_agg(jsonb_build_object('type', item->>'type', 'ref', item->>'ref') order by item_ord) as items
         from jsonb_array_elements(internal.w1_default_menu_payload()->'groups') g,
              jsonb_array_elements(g->'items') with ordinality items(item, item_ord)
        where g->>'id' = 'chats'`,
    );
    expect(rows[0]?.items).toEqual([{ type: 'view', ref: 'dashboard' }]);

    const shape = await db.query<{ label: string; ord: number; has_children: boolean }>(
      `select g->>'label' as label, ord::int, (g->'items'->0 ? 'children') as has_children
         from jsonb_array_elements(internal.w1_default_menu_payload()->'groups')
              with ordinality t(g, ord)
        where g->>'id' = 'chats'`,
    );
    expect(shape[0]).toEqual({ label: 'Chats', ord: 1, has_children: false });
  });

  it('serves the File browser as its own tab group (125 — user amendment)', async () => {
    const rows = await db.query<{ items: Array<{ type: string; ref: string }> }>(
      `select jsonb_agg(jsonb_build_object('type', item->>'type', 'ref', item->>'ref') order by item_ord) as items
         from jsonb_array_elements(internal.w1_default_menu_payload()->'groups') g,
              jsonb_array_elements(g->'items') with ordinality items(item, item_ord)
        where g->>'id' = 'files'`,
    );
    expect(rows[0]?.items).toEqual([{ type: 'view', ref: 'files' }]);
  });

  it('the guard ACCEPTS the new default — the registry row exists, so the seeder cannot refuse its own payload', async () => {
    // The failure mode 071 hit: a default the write-path validator rejects.
    // w2_normalize_menu_payload checks view refs against menu_view_registry
    // (menu_eligible AND implemented); if 102's registry insert were missing,
    // this raises 22023 rather than returning the canonical payload.
    const rows = await db.query<{ ok: boolean }>(
      `select internal.w2_normalize_menu_payload(
                gen_random_uuid(), internal.w1_default_menu_payload()
              ) is not null as ok`,
    );
    expect(rows[0]?.ok).toBe(true);
  });
});

/**
 * The 127 UPGRADE BLOCK, proven against real rows.
 *
 * A menu migration has two halves and they fail independently: the SEEDER
 * (what a NEW space gets, covered above) and the UPGRADE (what an EXISTING
 * space gets). The upgrade is guarded by `payload = <the previous default,
 * verbatim>`, and a single character wrong in that literal makes the update
 * match zero rows — silently, with no error and a green seeder test. Every
 * existing space would then keep a menu with no Chats tab while the code
 * shipped one, which is the precise shape of the 059 incident this file
 * exists for.
 *
 * So: apply the chain through 126, plant one verbatim-default row and one
 * hand-edited row, then run 127 and measure both.
 */
describeDb('127 upgrade — existing spaces gain the Chats tab, customized menus do not move', () => {
  let db: W1ScratchDatabase;
  const DEFAULT_SPACE = '00000000-0000-4000-8000-000000000127';
  const CUSTOM_SPACE = '00000000-0000-4000-8000-000000000128';
  let customPayloadBefore: unknown;

  beforeAll(async () => {
    db = await createW1ScratchDatabase('menu-chats-upgrade');
    const files = migrationFiles();
    const migration = files.find((file) => file.startsWith('127_'));
    if (!migration) throw new Error('the 127 migration is missing from the chain');
    const index = files.indexOf(migration);
    // Split application is the point: the rows must EXIST before 127 runs for
    // its WHERE clause to be the thing under test.
    db.apply(files.slice(0, index));

    await db.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.user_profiles(identity_id, display_name)
         values ('chats-default', 'Chats default'), ('chats-custom', 'Chats custom')`,
      );
      await client.query(
        `insert into public.spaces(id, name, created_by_identity)
         values ($1, 'Default menu', 'chats-default'), ($2, 'Custom menu', 'chats-custom')`,
        [DEFAULT_SPACE, CUSTOM_SPACE],
      );
      await client.query(
        `insert into public.space_menu_configs(space_id, schema_version, revision, payload)
         values ($1, 1, 9, internal.w1_default_menu_payload())`,
        [DEFAULT_SPACE],
      );
      await client.query(
        `insert into public.space_menu_configs(space_id, schema_version, revision, payload)
         values ($1, 1, 31,
                 jsonb_set(internal.w1_default_menu_payload(),
                           '{groups,0,label}', '"Mission Control"'))`,
        [CUSTOM_SPACE],
      );
    });

    customPayloadBefore = (await db.query<{ payload: unknown }>(
      `select payload from public.space_menu_configs where space_id = $1`,
      [CUSTOM_SPACE],
    ))[0]?.payload;

    // THE RED SIDE, measured rather than assumed: before 127 neither row names
    // a chats group. Without this the assertion below could pass on a chain
    // that already carried the tab.
    const before = await db.query<{ has_chats: boolean }>(
      `select bool_or(payload @> '{"groups":[{"id":"chats"}]}') as has_chats
         from public.space_menu_configs`,
    );
    expect(before[0]?.has_chats).toBe(false);

    db.apply([migration]);
  }, 180_000);

  afterAll(async () => {
    await db?.destroy();
  }, 30_000);

  it('the verbatim-default row gained the Chats tab and exactly one revision', async () => {
    const rows = await db.query<{ revision: number; first: unknown; payload: unknown }>(
      `select revision, payload->'groups'->0 as first, payload
         from public.space_menu_configs where space_id = $1`,
      [DEFAULT_SPACE],
    );
    expect(rows[0]?.first).toEqual({
      id: 'chats',
      label: 'Chats',
      items: [{ type: 'view', ref: 'dashboard' }],
    });
    expect(rows[0]?.revision).toBe(10);
    // And it is the CURRENT seeder output, not merely something chats-shaped —
    // an upgraded space and a fresh space must be indistinguishable.
    const seeded = (await db.query<{ payload: unknown }>(
      `select internal.w1_default_menu_payload() payload`,
    ))[0]!.payload;
    expect(rows[0]?.payload).toEqual(seeded);
  });

  it('the customized row is untouched — payload byte-identical, revision unmoved', async () => {
    const rows = await db.query<{ revision: number; payload: unknown }>(
      `select revision, payload from public.space_menu_configs where space_id = $1`,
      [CUSTOM_SPACE],
    );
    expect(rows[0]?.revision).toBe(31);
    expect(rows[0]?.payload).toEqual(customPayloadBefore);
  });
});

describeDb('Files explorer default-menu saved-row compatibility', () => {
  let db: W1ScratchDatabase;
  let oldDefault: unknown;
  let customized: unknown;

  beforeAll(async () => {
    const files = migrationFiles();
    const migration = filesMenuMigration(files);
    const migrationIndex = files.indexOf(migration);
    if (migrationIndex < 0) throw new Error(`${migration} is missing from the migration chain`);

    db = await createW1ScratchDatabase('menu-files-upgrade');
    db.apply(files.slice(0, migrationIndex));

    oldDefault = (await db.query<{ payload: unknown }>(
      `select internal.w1_default_menu_payload() payload`,
    ))[0]!.payload;
    const oldLibraryRefs = await db.query<{ refs: string[] }>(
      `select array_agg(item->>'ref' order by item_ord) as refs
         from jsonb_array_elements($1::jsonb->'groups') g,
              jsonb_array_elements(g->'items') with ordinality items(item, item_ord)
        where g->>'id' = 'library'`,
      [oldDefault],
    );
    expect(oldLibraryRefs[0]?.refs).toEqual(['file', 'spell', 'collection']);
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
         values ('menu-files-owner', 'Menu files owner')`,
      );
      await client.query(
        `insert into public.spaces(id, name, created_by_identity)
         values ($1, 'Untouched default', 'menu-files-owner'),
                ($2, 'Customized menu', 'menu-files-owner')`,
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

  it('upgrades the untouched default and leaves an authored menu unchanged', async () => {
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
  });

  it('registers the Files view as implemented and menu-eligible', async () => {
    const rows = await db.query<{
      route_template: string;
      menu_eligible: boolean;
      implemented: boolean;
    }>(
      `select route_template, menu_eligible, implemented
         from public.menu_view_registry
        where ref = 'files'`,
    );
    expect(rows).toEqual([
      {
        route_template: '#/s/{s}/files',
        menu_eligible: true,
        implemented: true,
      },
    ]);
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
    // The HISTORICAL caret, literal on purpose: this block applies the chain
    // only through the loops migration, so it characterizes that era's
    // payload. 122 later swaps channel→file (the contract spine moved with
    // it), which must not rewrite what this frozen point in history served.
    expect(rows[0]?.refs).toEqual([
      'task',
      'work_session',
      'doc',
      'channel',
      'team_member',
      'memory',
      'artifact',
      'loop',
    ]);
    expect(rows[0]?.refs.at(-1)).toBe('loop');
  });
});

/**
 * The 102 BACKFILL, proven against real rows rather than asserted in prose:
 * the chain is applied only through 101-era files, two seeded spaces are
 * given menu rows — one holding the pre-102 default verbatim, one customized
 * — and then 102 runs. The default row must gain the git view with its
 * revision bumped; the customized row must come through BYTE-IDENTICAL,
 * because overwriting an administrator's arrangement is the one thing the
 * backfill may never do (the git ref stays offerable via the menu editor's
 * free view refs instead).
 */
describeDb('102 backfill — upgrades the verbatim default, never a customized menu', () => {
  let db: W1ScratchDatabase;
  const DEFAULT_SPACE = '00000000-0000-4000-8000-000000000089';
  const CUSTOM_SPACE = '00000000-0000-4000-8000-000000000090';
  let customPayloadBefore: unknown;

  beforeAll(async () => {
    db = await createW1ScratchDatabase('menu-git-backfill');
    const files = migrationFiles();
    const before102 = files.filter((file) => file < '102');
    // Split application is the point: rows must EXIST before 102 runs for the
    // backfill's WHERE clause to be the thing under test.
    db.apply(before102);

    await db.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.user_profiles(identity_id, display_name)
         values ('backfill-default', 'Backfill default'), ('backfill-custom', 'Backfill custom')`,
      );
      await client.query(
        `insert into public.spaces(id, name, created_by_identity)
         values ($1, 'Default menu', 'backfill-default'), ($2, 'Custom menu', 'backfill-custom')`,
        [DEFAULT_SPACE, CUSTOM_SPACE],
      );
      // The pre-102 seeder output IS the 096 payload at this point in the
      // chain — inserted exactly as repair/seed paths insert it.
      await client.query(
        `insert into public.space_menu_configs(space_id, schema_version, revision, payload)
         values ($1, 1, 3, internal.w1_default_menu_payload())`,
        [DEFAULT_SPACE],
      );
      // A customized menu: one renamed label off the default. jsonb equality
      // is structural, so this must NOT match the backfill's verbatim guard.
      await client.query(
        `insert into public.space_menu_configs(space_id, schema_version, revision, payload)
         values ($1, 1, 5,
                 jsonb_set(internal.w1_default_menu_payload(),
                           '{groups,0,label}', '"Mission Control"'))`,
        [CUSTOM_SPACE],
      );
    });
    const rows = await db.query<{ payload: unknown }>(
      `select payload from public.space_menu_configs where space_id = $1`,
      [CUSTOM_SPACE],
    );
    customPayloadBefore = rows[0]?.payload;

    // The RED side of the proof, measured not assumed: before 102 the seeded
    // default names no git ref anywhere. If a prior migration already carried
    // it, the upgrade assertion below would be testing nothing.
    const before = await db.query<{ has_git: boolean }>(
      `select payload::text like '%"git"%' as has_git
         from public.space_menu_configs where space_id = $1`,
      [DEFAULT_SPACE],
    );
    expect(before[0]?.has_git).toBe(false);

    db.apply(['102_menu_git_view.sql']);
  }, 180_000);

  afterAll(async () => {
    await db?.destroy();
  }, 30_000);

  it('the verbatim-default row gained the git view and one revision', async () => {
    const rows = await db.query<{ revision: number; first: { type: string; ref: string } }>(
      `select revision,
              (select g->'items'->0
                 from jsonb_array_elements(payload->'groups') g
                where g->>'id' = 'tracking') as first
         from public.space_menu_configs where space_id = $1`,
      [DEFAULT_SPACE],
    );
    expect(rows[0]?.first).toEqual({ type: 'view', ref: 'git' });
    expect(rows[0]?.revision).toBe(4);
  });

  it('the customized row is untouched — payload byte-identical, revision unmoved', async () => {
    const rows = await db.query<{ revision: number; payload: unknown }>(
      `select revision, payload from public.space_menu_configs where space_id = $1`,
      [CUSTOM_SPACE],
    );
    expect(rows[0]?.revision).toBe(5);
    expect(rows[0]?.payload).toEqual(customPayloadBefore);
  });
});
