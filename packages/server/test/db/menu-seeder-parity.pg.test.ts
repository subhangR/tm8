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

import { DEFAULT_MENU_GROUP_SPINE } from '@tm8/contract';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

const DATABASE_URL = process.env.TM8_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

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

  it('names the three 059 kinds so the features stay reachable from the rail', async () => {
    const rows = await db.query<{ refs: string[] }>(
      `select array_agg(distinct leaf->>'ref') as refs
         from jsonb_array_elements(internal.w1_default_menu_payload()->'groups') g,
              jsonb_array_elements(g->'items') item,
              lateral (
                select item as leaf
                union all
                select child from jsonb_array_elements(coalesce(item->'children', '[]'::jsonb)) child
              ) leaves(leaf)
        where leaf->>'type' = 'kind'`,
    );
    expect(rows[0]?.refs).toEqual(
      expect.arrayContaining(['memory', 'artifact', 'worktree']),
    );
  });

  it('leads Tracking with the git VIEW row (089) — the wave’s screen must be reachable on real spaces', async () => {
    const rows = await db.query<{ first: { type: string; ref: string } }>(
      `select g->'items'->0 as first
         from jsonb_array_elements(internal.w1_default_menu_payload()->'groups') g
        where g->>'id' = 'tracking'`,
    );
    expect(rows[0]?.first).toEqual({ type: 'view', ref: 'git' });
  });

  it('the guard ACCEPTS the new default — the registry row exists, so the seeder cannot refuse its own payload', async () => {
    // The failure mode 071 hit: a default the write-path validator rejects.
    // w2_normalize_menu_payload checks view refs against menu_view_registry
    // (menu_eligible AND implemented); if 089's registry insert were missing,
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
 * The 089 BACKFILL, proven against real rows rather than asserted in prose:
 * the chain is applied only through 088-era files, two seeded spaces are
 * given menu rows — one holding the pre-089 default verbatim, one customized
 * — and then 089 runs. The default row must gain the git view with its
 * revision bumped; the customized row must come through BYTE-IDENTICAL,
 * because overwriting an administrator's arrangement is the one thing the
 * backfill may never do (the git ref stays offerable via the menu editor's
 * free view refs instead).
 */
describeDb('089 backfill — upgrades the verbatim default, never a customized menu', () => {
  let db: W1ScratchDatabase;
  const DEFAULT_SPACE = '00000000-0000-4000-8000-000000000089';
  const CUSTOM_SPACE = '00000000-0000-4000-8000-000000000090';
  let customPayloadBefore: unknown;

  beforeAll(async () => {
    db = await createW1ScratchDatabase('menu-git-backfill');
    const files = migrationFiles();
    const before089 = files.filter((file) => file < '089');
    // Split application is the point: rows must EXIST before 089 runs for the
    // backfill's WHERE clause to be the thing under test.
    db.apply(before089);

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
      // The pre-089 seeder output IS the 071 payload at this point in the
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

    // The RED side of the proof, measured not assumed: before 089 the seeded
    // default names no git ref anywhere. If a prior migration already carried
    // it, the upgrade assertion below would be testing nothing.
    const before = await db.query<{ has_git: boolean }>(
      `select payload::text like '%"git"%' as has_git
         from public.space_menu_configs where space_id = $1`,
      [DEFAULT_SPACE],
    );
    expect(before[0]?.has_git).toBe(false);

    db.apply(['089_menu_git_view.sql']);
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
