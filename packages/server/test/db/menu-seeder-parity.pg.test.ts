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

  it('names every kind added after the original menu so the features stay reachable', async () => {
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
      expect.arrayContaining([
        'memory', 'artifact', 'worktree',
        'file', 'spell', 'collection',
      ]),
    );
  });
});
