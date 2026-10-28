/**
 * 329 — prs/artifacts/drawings link counters, proved against a REAL
 * PostgreSQL, the same two-step way as 108's test: everything before 329,
 * then the seed, then 329 — so the BACKFILL runs on rows that genuinely
 * predate it. Then the trigger is proved by moving edges.
 *
 * The negatives are the point: a `tracks` edge to a COMMIT is not a PR, an
 * `attached_to` from a doc is still a doc (108's arm, unchanged by the
 * rewrite), and a `produces` edge to an artifact counts nothing (option A,
 * Subhang 2026-10-17).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

interface Fixture {
  space: string;
  member: string;
  task: string;
  session: string;
  pr: string;
  pr2: string;
  commit: string;
  artifact: string;
  drawing: string;
  doc: string;
}

interface Counts {
  docs: number;
  memories: number;
  prs: number;
  artifacts: number;
  drawings: number;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function counters(entity: string): Promise<Counts> {
  const [row] = await database.query<Counts>(
    `select docs, memories, prs, artifacts, drawings from public.entity_counters where entity_id = $1`,
    [entity],
  );
  return {
    docs: Number(row!.docs),
    memories: Number(row!.memories),
    prs: Number(row!.prs),
    artifacts: Number(row!.artifacts),
    drawings: Number(row!.drawings),
  };
}

const zero: Counts = { docs: 0, memories: 0, prs: 0, artifacts: 0, drawings: 0 };

async function asOwner<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

async function edge(src: string, dst: string, type: string): Promise<void> {
  await asOwner((client) =>
    client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, $4, $5)`,
      [fixture.space, src, dst, type, fixture.member],
    ),
  );
}

async function unedge(src: string, dst: string, type: string): Promise<void> {
  await asOwner((client) =>
    client.query(`delete from public.edges where src_id = $1 and dst_id = $2 and type = $3`, [src, dst, type]),
  );
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('links_328');
  const files = migrationFiles();
  const cut = files.findIndex((f) => f.startsWith('329_'));
  if (cut === -1) throw new Error('329 migration not found');

  database.apply(files.slice(0, cut));

  fixture = await asOwner(async (client) => {
    const ids = (
      await client.query<Fixture>(
        `select internal.new_id()::text "space", internal.new_id()::text "member",
                internal.new_id()::text "task", internal.new_id()::text "session",
                internal.new_id()::text "pr", internal.new_id()::text "pr2",
                internal.new_id()::text "commit", internal.new_id()::text "artifact",
                internal.new_id()::text "drawing", internal.new_id()::text "doc"`,
      )
    ).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ('links329-member', 'Member')`,
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'Links 329', 'links329-member')`,
      [ids.space],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by) values
         ($2, $1, 'member', 0, $2), ($3, $1, 'task', 1, $2), ($4, $1, 'work_session', 2, $2),
         ($5, $1, 'pull_request', 3, $2), ($6, $1, 'pull_request', 4, $2), ($7, $1, 'commit', 5, $2),
         ($8, $1, 'artifact', 6, $2), ($9, $1, 'drawing', 7, $2), ($10, $1, 'doc', 8, $2)`,
      [ids.space, ids.member, ids.task, ids.session, ids.pr, ids.pr2, ids.commit, ids.artifact, ids.drawing, ids.doc],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $2, 'links329-member', 'owner', 'Member')`,
      [ids.member, ids.space],
    );
    // Pre-329 edges: two PRs and a commit tracked by the task; an artifact,
    // a drawing and a doc attached to it; the artifact also attached to the
    // session. The commit is the negative; the doc proves 108's arm survives.
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by) values
         ($1, $2, $3, 'tracks', $9), ($1, $2, $4, 'tracks', $9), ($1, $2, $5, 'tracks', $9),
         ($1, $6, $2, 'attached_to', $9), ($1, $7, $2, 'attached_to', $9),
         ($1, $8, $2, 'attached_to', $9), ($1, $6, $10, 'attached_to', $9)`,
      [ids.space, ids.task, ids.pr, ids.pr2, ids.commit, ids.artifact, ids.drawing, ids.doc, ids.member, ids.session],
    );
    return ids;
  });

  database.apply(files.slice(cut));
}, 300_000);

afterAll(async () => {
  await database?.destroy();
});

describe('329 — the backfill', () => {
  it('counts tracked PRs (not commits), attached artifacts and drawings, and keeps docs', async () => {
    expect(await counters(fixture.task)).toEqual({ ...zero, docs: 1, prs: 2, artifacts: 1, drawings: 1 });
  });

  it('counts an attachment on its destination, whatever kind that is', async () => {
    expect(await counters(fixture.session)).toEqual({ ...zero, artifacts: 1 });
  });

  it('leaves the peers themselves at zero', async () => {
    expect(await counters(fixture.pr)).toEqual(zero);
    expect(await counters(fixture.artifact)).toEqual(zero);
  });
});

describe('329 — the trigger', () => {
  it('a tracks edge to a PR counts on insert and uncounts on delete; to a commit it moves nothing', async () => {
    await unedge(fixture.task, fixture.pr2, 'tracks');
    expect((await counters(fixture.task)).prs).toBe(1);
    await edge(fixture.task, fixture.pr2, 'tracks');
    expect((await counters(fixture.task)).prs).toBe(2);

    await unedge(fixture.task, fixture.commit, 'tracks');
    expect((await counters(fixture.task)).prs).toBe(2);
  });

  it('an attached artifact or drawing counts on insert and uncounts on delete', async () => {
    await edge(fixture.drawing, fixture.session, 'attached_to');
    expect(await counters(fixture.session)).toEqual({ ...zero, artifacts: 1, drawings: 1 });
    await unedge(fixture.drawing, fixture.session, 'attached_to');
    await unedge(fixture.artifact, fixture.session, 'attached_to');
    expect(await counters(fixture.session)).toEqual(zero);
  });

  it('an UPDATE that moves an attachment nets out on both ends', async () => {
    await asOwner((client) =>
      client.query(
        `update public.edges set dst_id = $3 where src_id = $1 and dst_id = $2 and type = 'attached_to'`,
        [fixture.artifact, fixture.task, fixture.session],
      ),
    );
    expect((await counters(fixture.task)).artifacts).toBe(0);
    expect((await counters(fixture.session)).artifacts).toBe(1);
  });

  it('the docs arm still counts after the rewrite', async () => {
    await unedge(fixture.doc, fixture.task, 'attached_to');
    expect((await counters(fixture.task)).docs).toBe(0);
    await edge(fixture.doc, fixture.task, 'attached_to');
    expect((await counters(fixture.task)).docs).toBe(1);
  });

  it('a produces edge to an artifact counts nothing (option A)', async () => {
    const before = await counters(fixture.task);
    await edge(fixture.task, fixture.artifact, 'produces');
    expect(await counters(fixture.task)).toEqual(before);
  });
});
