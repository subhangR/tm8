/**
 * 288 against a real Postgres: A STORY'S STATUS IS SETTABLE, BY HAND.
 *
 * Before 288 `update_story_entity` wrote title and description only, so every
 * story stayed at its birth `to_do` (issues #6, #8). The door now takes
 * `p_status` — a category or a state name of the story's workflow — and the
 * move goes through 149's status trigger like every other writer.
 *
 * Pinned here: the move lands and is a new version; the ruled algebra still
 * refuses an illegal move; a rename does not touch the status; an unknown
 * status is refused; and status is MANUAL — putting finished work in a story
 * does not move it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

let unique = 0;
function cmid(label: string): string {
  unique += 1;
  return `story-status-288-${label}-${unique}`;
}

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

async function asApp<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-288',true)`,
      [fixture.identityId],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (
      await client.query<Fixture>(
        `select 'story-status-288-owner'::text "identityId",
                internal.new_id()::text "spaceId",
                internal.new_id()::text "memberId"`,
      )
    ).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Story owner')`,
      [f.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Stories',$2)`,
      [f.spaceId, f.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'member',null,0,$1)`,
      [f.memberId, f.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Story owner')`,
      [f.memberId, f.spaceId, f.identityId],
    );
    return f;
  });
}

async function createStory(title: string): Promise<string> {
  const rows = await asApp((q) =>
    q(`select public.create_story_entity($1,$2,null,'',null,null,$3) r`, [fixture.spaceId, title, cmid('create')]),
  );
  return ((rows[0]!.r as { entity: { id: string } }).entity.id);
}

interface Row {
  status_category: string;
  status_name: string;
  version: number;
  title: string;
}

async function rowOf(id: string): Promise<Row> {
  const rows = await database.query<Row>(
    `select e.status_category, s.name status_name, e.version, st.title
       from public.entities e
       join public.workflow_states s on s.id = e.status_id
       join public.stories st on st.entity_id = e.id
      where e.id = $1`,
    [id],
  );
  return rows[0]!;
}

async function patch(id: string, opts: { title?: string; status?: string }): Promise<void> {
  const { version } = await rowOf(id);
  await asApp((q) =>
    q(`select public.update_story_entity($1,$2,null,$3,null,$4,$5)`,
      [id, version, opts.title ?? null, cmid('patch'), opts.status ?? null]),
  );
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('story-status-288');
  database.apply(migrationFiles());
  fixture = await seed(database);
});

afterAll(async () => {
  await database?.destroy();
}, 30_000);

describe('288: a story status is set through update_story_entity', () => {
  it('is born to_do and moves by category, each move a new version', async () => {
    const id = await createStory('Chapter one');
    const born = await rowOf(id);
    expect(born.status_category).toBe('to_do');

    await patch(id, { status: 'in_progress' });
    const working = await rowOf(id);
    expect(working.status_category).toBe('in_progress');
    expect(working.version).toBe(born.version + 1);

    await patch(id, { status: 'done' });
    expect((await rowOf(id)).status_category).toBe('done');
  });

  it('accepts a state name of the story workflow, case-insensitively', async () => {
    const id = await createStory('Chapter two');
    await patch(id, { status: 'In Progress' });
    expect((await rowOf(id)).status_category).toBe('in_progress');
  });

  it('bumps the version exactly once when a rename and a move land together', async () => {
    const id = await createStory('Chapter three');
    const before = await rowOf(id);
    await patch(id, { title: 'Chapter 3', status: 'in_progress' });
    const after = await rowOf(id);
    expect(after.title).toBe('Chapter 3');
    expect(after.status_category).toBe('in_progress');
    expect(after.version).toBe(before.version + 1);
  });

  it('a rename alone leaves the status where it was', async () => {
    const id = await createStory('Chapter four');
    await patch(id, { status: 'in_progress' });
    await patch(id, { title: 'Chapter four, renamed' });
    expect((await rowOf(id)).status_category).toBe('in_progress');
  });

  it('the ruled algebra still applies: done -> in_progress is refused', async () => {
    const id = await createStory('Chapter five');
    await patch(id, { status: 'done' });
    await expect(patch(id, { status: 'in_progress' })).rejects.toThrow(/not allowed/);
    expect((await rowOf(id)).status_category).toBe('done');
    // Reopening goes through to_do.
    await patch(id, { status: 'to_do' });
    await patch(id, { status: 'in_progress' });
    expect((await rowOf(id)).status_category).toBe('in_progress');
  });

  it('refuses an unknown status, naming the allowed values', async () => {
    const id = await createStory('Chapter six');
    await expect(patch(id, { status: 'shipped' })).rejects.toThrow(/unknown story status shipped: use to_do, in_progress, done, cancelled/);
    expect((await rowOf(id)).status_category).toBe('to_do');
  });

  it('is MANUAL: putting finished work in a story does not move its status', async () => {
    const id = await createStory('Chapter seven');
    const task = await asApp(async (q) => {
      const r = await q(`select public.create_task($1,'Finished thing') r`, [fixture.spaceId]);
      return (r[0]!.r as { entity: { id: string } }).entity.id;
    });
    await asApp((q) => q(`select public.set_collection_item($1,$2,null,null,$3)`, [id, task, cmid('add')]));
    await database.query(
      `update public.entities set status_id = internal.workflow_state_for_category($1,'done') where id = $1`,
      [task],
    );
    expect((await rowOf(id)).status_category).toBe('to_do');
  });
});
