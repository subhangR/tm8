/**
 * `state.channel.unreadCount` — real, per-viewer, and identical on both paths.
 *
 * This field was hardcoded `0` in two places (`facade/entity-read.ts` and
 * `events/projector.ts`). A hardcoded 0 and a true 0 are pixel-identical to the
 * user and only one of them is a true statement, so every assertion here is a
 * red/green pair: a number that would still pass if the field were stuck at 0
 * proves nothing, and each case below therefore asserts a NON-zero count and
 * then the zero it collapses to for a stated reason.
 *
 * The last test is the load-bearing one. The read path and the event feed are
 * two independent assemblers over the same row, and the codebase's stated
 * invariant is that they agree. If only the facade were fixed, an
 * `entity.upsert` for a channel would intermittently overwrite a correct badge
 * with a false zero — a worse defect than the one being fixed, because it is
 * non-deterministic.
 */
import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Querier } from '../../src/db/types.js';
import { PgEntityProjector } from '../../src/events/projector.js';
import { loadEntitySummariesByIds } from '../../src/facade/entity-read.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const VIEWER_IDENTITY = 'unread-viewer';
const OTHER_IDENTITY = 'unread-other';

interface Fixture {
  spaceId: string;
  viewerMemberId: string;
  otherMemberId: string;
  channelId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

/** Run as the graph owner — seeding, not the thing under test. */
async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

/**
 * Run under a real viewer's claims. This matters more than usual here:
 * `public.unread_counts` is SECURITY DEFINER and resolves the member from
 * `tm8.identity_id`, NOT from a parameter, so a test that skipped the claims
 * would be measuring nobody's unread.
 */
async function asViewer<T>(identityId: string, fn: (q: Querier) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', 'false', true),
              set_config('tm8.request_id', 'channel-unread-pg', true)`,
      [identityId],
    );
    // Mirrors the production Querier, including `select * from fn(...)`, so the
    // RPC is exercised the way the server actually calls it.
    const q: Querier = {
      query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
        (await client.query(sql, [...params])).rows as R[],
      rpc: async <T2>(fn2: string, args: readonly unknown[] = []): Promise<T2> => {
        const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
        const result = await client.query(`select * from public.${fn2}(${placeholders})`, [...args]);
        return result.rows as unknown as T2;
      },
    };
    return fn(q);
  });
}

async function seed(): Promise<Fixture> {
  return asOwner(async (client) => {
    const ids = (await client.query<{
      space_id: string;
      viewer_member_id: string;
      other_member_id: string;
      channel_id: string;
    }>(
      `select internal.new_id() space_id, internal.new_id() viewer_member_id,
              internal.new_id() other_member_id, internal.new_id() channel_id`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'Unread viewer'), ($2, 'Unread other')`,
      [VIEWER_IDENTITY, OTHER_IDENTITY],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'Unread', $2)`,
      [ids.space_id, VIEWER_IDENTITY],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by) values
       ($1, $3, 'member', 0, $1), ($2, $3, 'member', 1, $2), ($4, $3, 'channel', 2, $1)`,
      [ids.viewer_member_id, ids.other_member_id, ids.space_id, ids.channel_id],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name) values
       ($1, $3, $4, 'owner', 'Unread viewer'), ($2, $3, $5, 'member', 'Unread other')`,
      [ids.viewer_member_id, ids.other_member_id, ids.space_id, VIEWER_IDENTITY, OTHER_IDENTITY],
    );
    await client.query(
      `insert into public.channels(entity_id, space_id, name, topic)
       values ($1, $2, 'general', 'unread under test')`,
      [ids.channel_id, ids.space_id],
    );

    return {
      spaceId: ids.space_id,
      viewerMemberId: ids.viewer_member_id,
      otherMemberId: ids.other_member_id,
      channelId: ids.channel_id,
    };
  });
}

/** Post `count` messages to the channel, authored by `authorId`. */
async function post(authorId: string, count: number): Promise<void> {
  await asOwner(async (client) => {
    for (let i = 0; i < count; i += 1) {
      const messageId = (await client.query<{ id: string }>('select internal.new_id() id')).rows[0]!.id;
      await client.query(
        `insert into public.entities(id, space_id, kind, position, created_by)
         values ($1, $2, 'message', null, $3)`,
        [messageId, fixture.spaceId, authorId],
      );
      await client.query(
        `insert into public.messages(entity_id, anchor_id, author_id, body, client_msg_id)
         values ($1, $2, $3, $4, $5)`,
        [messageId, fixture.channelId, authorId, `message ${i}`, randomUUID()],
      );
    }
  });
}

/** The channel's unreadCount as the FACADE read path reports it. */
async function facadeUnread(identityId: string): Promise<number> {
  return asViewer(identityId, async (q) => {
    const summaries = await loadEntitySummariesByIds(q, [fixture.channelId], identityId);
    expect(summaries).toHaveLength(1);
    const state = summaries[0]!.state;
    if (state.kind !== 'channel') throw new Error(`expected a channel, got ${state.kind}`);
    return state.unreadCount;
  });
}

/** The channel's unreadCount as the EVENT FEED projector reports it. */
async function projectorUnread(identityId: string): Promise<number> {
  return asViewer(identityId, async (q) => {
    const summaries = await new PgEntityProjector().entitySummaries(q, [fixture.channelId]);
    const summary = summaries.get(fixture.channelId);
    if (!summary) throw new Error('projector did not return the channel');
    if (summary.state.kind !== 'channel') throw new Error('expected a channel');
    return summary.state.unreadCount;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('channel_unread');
  database.apply(migrationFiles());
  fixture = await seed();
});

afterAll(async () => {
  await database?.destroy();
});

describe('channel unreadCount is a real per-viewer number', () => {
  it('counts another member\'s messages, and is NOT the hardcoded zero', async () => {
    await post(fixture.otherMemberId, 3);
    expect(await facadeUnread(VIEWER_IDENTITY)).toBe(3);
  });

  it('does not count the viewer\'s OWN messages', async () => {
    // The author already knows what they wrote; counting it would make a channel
    // permanently unread to the person most active in it.
    await post(fixture.viewerMemberId, 4);
    expect(await facadeUnread(VIEWER_IDENTITY)).toBe(3);
    // ...and those 4 ARE unread for the other member, which is the red/green
    // half that proves the exclusion is per-viewer and not a global filter.
    expect(await facadeUnread(OTHER_IDENTITY)).toBe(4);
  });

  it('is viewer-scoped: two members of one channel see different numbers', async () => {
    expect(await facadeUnread(VIEWER_IDENTITY)).not.toBe(await facadeUnread(OTHER_IDENTITY));
  });

  it('collapses to zero once the viewer has a read mark, and only for them', async () => {
    await asOwner(async (client) => {
      await client.query(
        `insert into public.read_marks(member_id, anchor_id, last_read_at)
         values ($1, $2, now())
         on conflict (member_id, anchor_id) do update set last_read_at = excluded.last_read_at`,
        [fixture.viewerMemberId, fixture.channelId],
      );
    });
    expect(await facadeUnread(VIEWER_IDENTITY)).toBe(0);
    // The other member never marked read, so their count must survive. This is
    // what distinguishes a real 0 from a regression back to the hardcoded one.
    expect(await facadeUnread(OTHER_IDENTITY)).toBe(4);
  });

  it('counts again after the read mark, when new messages arrive', async () => {
    await post(fixture.otherMemberId, 2);
    expect(await facadeUnread(VIEWER_IDENTITY)).toBe(2);
  });

  it('THE INVARIANT: the event feed reports exactly what the read path does', async () => {
    // Both assemblers, same viewer, same channel, same transaction shape. If
    // these ever diverge, an entity.upsert overwrites a correct badge with a
    // false zero and the bug is intermittent rather than constant.
    expect(await projectorUnread(VIEWER_IDENTITY)).toBe(await facadeUnread(VIEWER_IDENTITY));
    expect(await projectorUnread(OTHER_IDENTITY)).toBe(await facadeUnread(OTHER_IDENTITY));
    // Pinned to the concrete numbers too, so a mutual collapse to 0 cannot
    // satisfy the equality above.
    expect(await projectorUnread(VIEWER_IDENTITY)).toBe(2);
    expect(await projectorUnread(OTHER_IDENTITY)).toBe(4);
  });
});
