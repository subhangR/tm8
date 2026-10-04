/**
 * StoryNode.counts (story map W6, task 01a1090f): every node on the page
 * carries its mailbox size and its pending-attention count, computed by two
 * set-based queries over the page's ids — never a query per node.
 *
 * Pinned here:
 *   - `messages` uses the recentMessages window's predicate (not redacted,
 *     message entity not deleted) with no window.
 *   - `pendingAttention` uses `internal.story_summary`'s predicate (289):
 *     status open or acknowledged, target = the node — so the nodes sum to
 *     the summary's pendingAttentionCount.
 *   - a node with neither reads {0, 0}, never undefined.
 *   - the 50-row recentMessages window is unchanged.
 */
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Querier } from '../../src/db/types.js';
import { loadStoryPage } from '../../src/facade/story-page.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const IDENTITY = 'story-counts-probe';

let database: W1ScratchDatabase;
const id: Record<string, string> = {};

async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

function querierOf(client: PoolClient): Querier {
  return {
    query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
      (await client.query(sql, [...params])).rows as R[],
    rpc: async () => { throw new Error('not used'); },
  } as Querier;
}

async function summary(storyId: string): Promise<Record<string, any>> {
  return asOwner(async (c) => (await c.query(`select internal.story_summary($1) s`, [storyId])).rows[0]!.s);
}

/** The queries one page read issues, by their SQL text. */
async function pageWithQueryLog(storyId: string) {
  return asOwner(async (c) => {
    const sql: string[] = [];
    const q = querierOf(c);
    const logged: Querier = {
      ...q,
      query: async <R>(text: string, params: readonly unknown[] = []): Promise<R[]> => {
        sql.push(text);
        return q.query<R>(text, params);
      },
    } as Querier;
    const page = await loadStoryPage(logged, storyId);
    return { page, sql };
  });
}

describe('story page per-node counts', () => {
  beforeAll(async () => {
    database = await createW1ScratchDatabase('story_counts');
    database.apply(migrationFiles());

    await asOwner(async (c) => {
      const names = ['space', 'member', 'story', 'mailbox', 'asking', 'quiet',
        'm1', 'm2', 'm_redacted', 'm_deleted', 'm_story'];
      const rows = (await c.query<{ ids: string[] }>(
        `select array(select internal.new_id() from generate_series(1, $1)) ids`, [names.length])).rows[0]!.ids;
      names.forEach((n, i) => { id[n] = rows[i]!; });

      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'probe')`, [IDENTITY]);
      await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'probe', $2)`,
        [id['space'], IDENTITY]);
      let pos = 0;
      const entity = async (key: string, kind: string, parent: string | null = null) => {
        await c.query(
          `insert into public.entities(id, space_id, kind, position, created_by, parent_id)
           values ($1, $2, $3, $4, $5, $6)`,
          [id[key], id['space'], kind, pos++, key === 'member' ? id[key] : id['member'], parent ? id[parent] : null],
        );
      };
      await entity('member', 'member');
      await c.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name)
         values ($1, $2, $3, 'owner', 'probe')`,
        [id['member'], id['space'], IDENTITY],
      );
      const task = async (key: string) => {
        await entity(key, 'task');
        await c.query(`insert into public.tasks(entity_id, title, work_status) values ($1, $2, 'open')`, [id[key], key]);
      };
      const message = async (key: string, anchor: string, at: string) => {
        await entity(key, 'message');
        await c.query(
          `insert into public.messages(entity_id, anchor_id, author_id, body, created_at)
           values ($1, $2, $3, $4, $5::timestamptz)`,
          [id[key], id[anchor], id['member'], key, at],
        );
      };
      const attention = async (target: string, status: string) => {
        await c.query(
          `insert into public.attention_requests(space_id, entity_id, reason, points, requested_by, status)
           values ($1, $2, $3, 40, $4, $5)`,
          [id['space'], id[target], `${target} ${status}`, id['member'], status],
        );
      };

      await entity('story', 'story');
      await c.query(`insert into public.stories(entity_id, title) values ($1, 'story')`, [id['story']]);
      await task('mailbox');
      await task('asking');
      await task('quiet');
      for (const dst of ['mailbox', 'asking', 'quiet']) {
        await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'contains', $4)`,
          [id['space'], id['story'], id[dst], id['member']]);
      }

      // mailbox: two live messages, one redacted, one whose entity row is deleted.
      await message('m1', 'mailbox', '2026-10-01T10:00:00Z');
      await message('m2', 'mailbox', '2026-10-01T11:00:00Z');
      await message('m_redacted', 'mailbox', '2026-10-01T12:00:00Z');
      await c.query(`update public.messages set redacted_at = now() where entity_id = $1`, [id['m_redacted']]);
      await message('m_deleted', 'mailbox', '2026-10-01T13:00:00Z');
      await c.query(`update public.entities set deleted_at = now() where id = $1`, [id['m_deleted']]);
      // The story itself is a feed anchor too.
      await message('m_story', 'story', '2026-10-01T09:00:00Z');

      // asking: open + acknowledged are pending; resolved and dismissed are not.
      await attention('asking', 'open');
      await attention('asking', 'acknowledged');
      await attention('asking', 'resolved');
      await attention('asking', 'dismissed');
      // A settled request on the quiet node must not make it count.
      await attention('quiet', 'resolved');
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('every node carries counts; messages follow the feed predicate, attention the summary predicate', async () => {
    const page = await asOwner(async (c) => loadStoryPage(querierOf(c), id['story']!));
    const node = (key: string) => page.nodes.find((n) => n.id === id[key])!;

    for (const n of page.nodes) expect(n.counts).toBeDefined();
    expect(node('mailbox').counts).toEqual({ messages: 2, pendingAttention: 0 });
    expect(node('asking').counts).toEqual({ messages: 0, pendingAttention: 2 });
    expect(node('quiet').counts).toEqual({ messages: 0, pendingAttention: 0 });
    expect(node('story').counts).toEqual({ messages: 1, pendingAttention: 0 });
  });

  it('the nodes sum to the summary pendingAttentionCount', async () => {
    const page = await asOwner(async (c) => loadStoryPage(querierOf(c), id['story']!));
    const s = await summary(id['story']!);
    const total = page.nodes.reduce((acc, n) => acc + (n.counts?.pendingAttention ?? 0), 0);
    expect(total).toBe(2);
    expect(s['pendingAttentionCount']).toBe(total);
  });

  it('recentMessages is unchanged: the live messages newest first, nothing redacted or deleted', async () => {
    const page = await asOwner(async (c) => loadStoryPage(querierOf(c), id['story']!));
    expect(page.recentMessages.map((m) => m.id)).toEqual([id['m2'], id['m1'], id['m_story']]);
    expect(page.feedAnchorIds).toEqual(expect.arrayContaining([id['story'], id['mailbox'], id['asking'], id['quiet']]));
    expect(page.feedAnchorIds).not.toContain(id['m1']);
  });

  it('counts come from two grouped queries, not one per node', async () => {
    const { sql } = await pageWithQueryLog(id['story']!);
    const grouped = sql.filter((s) => /group by m\.anchor_id|group by ar\.entity_id/.test(s));
    expect(grouped).toHaveLength(2);
    expect(sql.filter((s) => /from public\.attention_requests/.test(s))).toHaveLength(1);
    // The window query (limit 50) and the count query are the only message reads.
    expect(sql.filter((s) => /from public\.messages m/.test(s))).toHaveLength(2);
  });
});
