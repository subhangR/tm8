/**
 * `badges.pullRequests` on a session or chat row (task 01a18209), against a
 * REAL PostgreSQL: the session row draws one chip per PR, so the loader must
 * answer with exactly the PRs the `prs` counter counts there (331) — PRs the
 * holder `tracks`, union PRs `authored_from` it, each PR once, newest link
 * first. And a task's answer is unchanged: `tracks` only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadLinkedPullRequestBadges } from '../../src/tracking/pr-projection.js';
import type { Querier } from '../../src/db/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

interface Fixture {
  space: string;
  member: string;
  task: string;
  session: string;
  chat: string;
  pr1: string;
  pr2: string;
  pr3: string;
  doc: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

const querier = (): Querier => ({
  query: async <R>(sql: string, params?: readonly unknown[]) => (await database.query(sql, params)) as R[],
  rpc: async () => {
    throw new Error('the badge loader is a READ');
  },
});

beforeAll(async () => {
  database = await createW1ScratchDatabase('pr_badges_holders');
  database.apply(migrationFiles());

  fixture = await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (
      await client.query<Fixture>(
        `select internal.new_id()::text "space", internal.new_id()::text "member",
                internal.new_id()::text "task", internal.new_id()::text "session",
                internal.new_id()::text "chat", internal.new_id()::text "pr1",
                internal.new_id()::text "pr2", internal.new_id()::text "pr3",
                internal.new_id()::text "doc"`,
      )
    ).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ('prbadges-member', 'Member')`,
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'PR badges', 'prbadges-member')`,
      [ids.space],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by) values
         ($2, $1, 'member', 0, $2), ($3, $1, 'task', 1, $2), ($4, $1, 'work_session', 2, $2),
         ($5, $1, 'chat', 3, $2), ($6, $1, 'pull_request', 4, $2), ($7, $1, 'pull_request', 5, $2),
         ($8, $1, 'pull_request', 6, $2), ($9, $1, 'doc', 7, $2)`,
      [ids.space, ids.member, ids.task, ids.session, ids.chat, ids.pr1, ids.pr2, ids.pr3, ids.doc],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $2, 'prbadges-member', 'owner', 'Member')`,
      [ids.member, ids.space],
    );
    await client.query(
      `insert into public.pull_requests(entity_id, space_id, provider, url, repo, number, title, state) values
         ($1, $4, 'github', 'https://github.com/acme/tm8/pull/1', 'acme/tm8', 1, 'One', 'merged'),
         ($2, $4, 'github', 'https://github.com/acme/tm8/pull/2', 'acme/tm8', 2, 'Two', 'open'),
         ($3, $4, 'github', 'https://github.com/acme/tm8/pull/3', 'acme/tm8', 3, 'Three', 'closed')`,
      [ids.pr1, ids.pr2, ids.pr3, ids.space],
    );
    // The task tracks pr1 and pr2. pr2 and pr3 are authored_from the session,
    // pr3 linked last; a doc authored_from it is not a PR. (A session holds no
    // `tracks` edge — the registry refuses one — so authorship is its route.)
    // The chat authored pr1.
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by, created_at) values
         ($1, $2, $3, 'tracks', $5, '2026-10-28T10:00:00Z'),
         ($1, $2, $4, 'tracks', $5, '2026-10-28T10:01:00Z')`,
      [ids.space, ids.task, ids.pr1, ids.pr2, ids.member],
    );
    // `authored_from` is recorder-owned (308): written as that writer, as the server does.
    await client.query(`select internal.w1_set_writer('entity_recorder')`);
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by, created_at) values
         ($1, $4, $2, 'authored_from', $7, '2026-10-28T10:02:00Z'),
         ($1, $5, $2, 'authored_from', $7, '2026-10-28T10:03:00Z'),
         ($1, $6, $2, 'authored_from', $7, '2026-10-28T10:04:00Z'),
         ($1, $8, $3, 'authored_from', $7, '2026-10-28T10:05:00Z')`,
      [ids.space, ids.session, ids.chat, ids.pr2, ids.pr3, ids.doc, ids.member, ids.pr1],
    );
    return ids;
  });
}, 300_000);

afterAll(async () => {
  await database?.destroy();
});

describe('badges.pullRequests by holder kind', () => {
  it('a session gets the PRs authored from it, newest link first — and matches its prs count', async () => {
    const out = await loadLinkedPullRequestBadges(querier(), [{ id: fixture.session, kind: 'work_session' }]);
    const items = out.get(fixture.session)?.items ?? [];
    expect(items.map((i) => [i.number, i.state])).toEqual([[3, 'closed'], [2, 'open']]);
    const [counted] = await database.query<{ prs: number }>(
      `select prs from public.entity_counters where entity_id = $1`,
      [fixture.session],
    );
    expect(Number(counted!.prs)).toBe(items.length);
  });

  it('a chat gets the PRs authored from it', async () => {
    const out = await loadLinkedPullRequestBadges(querier(), [{ id: fixture.chat, kind: 'chat' }]);
    expect(out.get(fixture.chat)?.items.map((i) => i.number)).toEqual([1]);
  });

  it("a task's answer is unchanged: what it tracks", async () => {
    const out = await loadLinkedPullRequestBadges(querier(), [{ id: fixture.task, kind: 'task' }]);
    expect(out.get(fixture.task)?.items.map((i) => i.number)).toEqual([2, 1]);
  });
});
