/**
 * 408 against a real Postgres: LABELS (BRIDGE-ENTITY-DESIGN §3.8, D27).
 *
 * Pinned here (§7.3 item 14 and the B0b acceptance):
 *   - every space has `bug`: one seeded on its owner's arrival and one born
 *     through `create_space`;
 *   - `entities.labels` refuses an unknown id and a label from another space;
 *   - `set_entity_labels` adds and removes under expectedVersion, bumps the
 *     version once, and refuses a stale one;
 *   - archiving `bug` keeps it on the entities that carry it, hides it from the
 *     unarchived list, refuses adding it again, and a label is never deleted;
 *   - names are unique per space, case-insensitively, archived included;
 *   - a label filter is served by `entities_labels_gin` (EXPLAIN);
 *   - 408's internal.entity_content keeps every arm 395 had (bridge) beside label.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  otherSpaceId: string;
  otherMemberId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

let unique = 0;
function cmid(label: string): string {
  unique += 1;
  return `labels-397-${label}-${unique}`;
}

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

async function asApp<T>(fn: (q: Q) => Promise<T>, identityId = fixture.identityId): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-397',true)`,
      [identityId],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

async function seedSpace(db: W1ScratchDatabase, identityId: string, name: string): Promise<{ spaceId: string; memberId: string }> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (await client.query<{ spaceId: string; memberId: string }>(
      `select internal.new_id()::text "spaceId", internal.new_id()::text "memberId"`)).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,$2) on conflict do nothing`,
      [identityId, name]);
    await client.query(`insert into public.spaces(id,name,created_by_identity) values($1,$2,$3)`,
      [ids.spaceId, name, identityId]);
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values($1,$2,'member',null,0,$1)`,
      [ids.memberId, ids.spaceId]);
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,'owner',$4)`,
      [ids.memberId, ids.spaceId, identityId, name]);
    return ids;
  });
}

async function labelId(spaceId: string, name: string): Promise<string> {
  const rows = await database.query<{ id: string }>(
    `select entity_id::text id from public.labels where space_id = $1 and lower(name) = lower($2)`, [spaceId, name]);
  return rows[0]!.id;
}

async function createStory(title: string): Promise<string> {
  const rows = await asApp((q) =>
    q(`select public.create_story_entity($1,$2,null,'',null,null,$3) r`, [fixture.spaceId, title, cmid('story')]));
  return (rows[0]!.r as { entity: { id: string } }).entity.id;
}

async function envelope(id: string): Promise<{ version: number; labels: string[] }> {
  const rows = await database.query<{ version: number; labels: string[] }>(
    `select version, labels::text[] labels from public.entities where id = $1`, [id]);
  return rows[0]!;
}

async function setLabels(id: string, version: number | null, add: string[], remove: string[] = []): Promise<void> {
  await asApp((q) => q(`select public.set_entity_labels($1,$2,null,$3::uuid[],$4::uuid[],$5)`,
    [id, version, add, remove, cmid('set')]));
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('labels-397');
  database.apply(migrationFiles());
  const mine = await seedSpace(database, 'labels-397-owner', 'Labels');
  const other = await seedSpace(database, 'labels-397-other', 'Elsewhere');
  fixture = {
    identityId: 'labels-397-owner', spaceId: mine.spaceId, memberId: mine.memberId,
    otherSpaceId: other.spaceId, otherMemberId: other.memberId,
  };
});

afterAll(async () => {
  await database?.destroy();
}, 30_000);

describe('408 labels', () => {
  it('seeds bug in a space on its owner’s arrival, and in a space born through create_space', async () => {
    const seeded = await database.query<{ name: string; colour: string; archived_at: unknown; created_by: string }>(
      `select l.name, l.colour, l.archived_at, e.created_by::text created_by
         from public.labels l join public.entities e on e.id = l.entity_id where l.space_id = $1`, [fixture.spaceId]);
    expect(seeded).toEqual([{ name: 'bug', colour: '#d73a4a', archived_at: null, created_by: fixture.memberId }]);

    const born = await asApp((q) => q(`select public.create_space('Born after 408') r`), 'labels-397-newcomer');
    const spaceId = ((born[0]!.r as { space: { id: string } }).space.id);
    const names = await database.query<{ name: string }>(`select name from public.labels where space_id = $1`, [spaceId]);
    expect(names.map((r) => r.name)).toEqual(['bug']);
  });

  it('refuses an unknown label id and a label from another space', async () => {
    const story = await createStory('Unknown and foreign');
    const { version } = await envelope(story);
    await expect(setLabels(story, version, ['00000000-0000-4000-8000-000000000000']))
      .rejects.toMatchObject({ code: '22023' });
    const foreign = await labelId(fixture.otherSpaceId, 'bug');
    await expect(setLabels(story, version, [foreign])).rejects.toMatchObject({ code: '22023' });
    // The trigger holds even past the door, for the graph owner itself.
    await expect(database.query(`update public.entities set labels = array[$1::uuid] where id = $2`, [foreign, story]))
      .rejects.toMatchObject({ code: '22023' });
    expect(await envelope(story)).toEqual({ version, labels: [] });
  });

  it('adds and removes under expectedVersion, one version per change, stale refused', async () => {
    const bug = await labelId(fixture.spaceId, 'bug');
    const story = await createStory('Labelled');
    const v1 = (await envelope(story)).version;
    await setLabels(story, v1, [bug, bug]);
    expect(await envelope(story)).toEqual({ version: v1 + 1, labels: [bug] });
    // A no-op is not a version.
    await setLabels(story, v1 + 1, [bug]);
    expect((await envelope(story)).version).toBe(v1 + 1);
    await expect(setLabels(story, v1, [], [bug])).rejects.toMatchObject({ code: '40001' });
    await setLabels(story, v1 + 1, [], [bug]);
    expect(await envelope(story)).toEqual({ version: v1 + 2, labels: [] });
    // NULL expectedVersion is only for an entity born in the same transaction.
    await expect(setLabels(story, null, [bug])).rejects.toMatchObject({ code: '22023' });
  });

  it('a labels-only change always bumps, even after an updated_at touch in the same transaction', async () => {
    const bug = await labelId(fixture.spaceId, 'bug');
    const story = await createStory('Touched first');
    const v = (await envelope(story)).version;
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query('update public.entities set updated_at = now(), activity_at = now() where id = $1', [story]);
      await client.query('set local role tm8_app');
      await client.query(
        `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
                set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-397',true)`,
        [fixture.identityId]);
      await client.query(`select public.set_entity_labels($1,$2,null,array[$3::uuid],'{}',$4)`, [story, v, bug, cmid('touch')]);
    });
    expect(await envelope(story)).toEqual({ version: v + 1, labels: [bug] });
  });

  it('folds labels into the version a body edit made in the same transaction, and nothing else', async () => {
    const bug = await labelId(fixture.spaceId, 'bug');
    const story = await createStory('Title and labels');
    const v = (await envelope(story)).version;
    // One command: the body edit, then the labels with the version the caller sent.
    await asApp(async (q) => {
      await q(`select public.update_story_entity($1,$2,null,'Renamed',null,$3,null)`, [story, v, cmid('title')]);
      await q(`select public.set_entity_labels($1,$2,null,array[$3::uuid],'{}',$4)`, [story, v, bug, cmid('fold')]);
    });
    expect(await envelope(story)).toEqual({ version: v + 1, labels: [bug] });
    // Someone else's edit, then a labels write still holding v + 1 - 1: stale.
    await asApp((q) => q(`select public.update_story_entity($1,$2,null,'Renamed again',null,$3,null)`, [story, v + 1, cmid('other')]));
    await expect(setLabels(story, v + 1, [], [bug])).rejects.toMatchObject({ code: '40001' });
    expect(await envelope(story)).toEqual({ version: v + 2, labels: [bug] });
  });

  it('labels an entity at birth without a new version', async () => {
    const bug = await labelId(fixture.spaceId, 'bug');
    const id = await asApp(async (q) => {
      const r = (await q(`select public.create_story_entity($1,'Born labelled',null,'',null,null,$2) r`,
        [fixture.spaceId, cmid('born')]))[0]!.r as { entity: { id: string } };
      await q(`select public.set_entity_labels($1,null,null,array[$2::uuid],'{}',$3)`, [r.entity.id, bug, cmid('born-labels')]);
      return r.entity.id;
    });
    expect(await envelope(id)).toEqual({ version: 1, labels: [bug] });
  });

  it('archiving bug keeps it where it is, hides it, refuses adding it, and never deletes it', async () => {
    const story = await createStory('Archived label');
    const label = await asApp(async (q) => {
      const r = (await q(`select public.create_label($1,'Regression','D73A4A','',null,$2) r`,
        [fixture.spaceId, cmid('create')]))[0]!.r as { entity: { id: string } };
      return r.entity.id;
    });
    expect((await database.query<{ colour: string }>(`select colour from public.labels where entity_id = $1`, [label]))[0]!.colour)
      .toBe('#d73a4a');
    await setLabels(story, (await envelope(story)).version, [label]);
    const labelVersion = (await envelope(label)).version;
    await asApp((q) => q(`select public.archive_label($1,$2,null,$3)`, [label, labelVersion, cmid('archive')]));

    expect((await envelope(story)).labels).toEqual([label]);
    const listed = await asApp((q) => q(
      `select l.name from public.labels l join public.entities e on e.id = l.entity_id
        where e.space_id = $1 and l.archived_at is null order by l.name`, [fixture.spaceId]));
    expect(listed.map((r) => r.name)).toEqual(['bug']);

    const other = await createStory('Cannot take archived');
    await expect(setLabels(other, (await envelope(other)).version, [label])).rejects.toMatchObject({ code: '22023' });
    // Removing an archived label is always allowed.
    await setLabels(story, (await envelope(story)).version, [], [label]);
    expect((await envelope(story)).labels).toEqual([]);

    await expect(asApp((q) => q(`update public.entities set deleted_at = now() where id = $1`, [label])))
      .rejects.toThrow();
    await expect(database.query(`update public.entities set deleted_at = now() where id = $1`, [label]))
      .rejects.toThrow(/archived, not deleted/);
  });

  it('keeps names unique per space, case-insensitively, archived labels included', async () => {
    await expect(asApp((q) => q(`select public.create_label($1,'BUG',null,'',null,$2)`, [fixture.spaceId, cmid('dup')])))
      .rejects.toMatchObject({ code: '23505' });
    await expect(asApp((q) => q(`select public.create_label($1,'regression',null,'',null,$2)`, [fixture.spaceId, cmid('dup')])))
      .rejects.toThrow(/archived label named Regression/);
    // The other space has its own `bug`: uniqueness is per space.
    expect(await labelId(fixture.otherSpaceId, 'bug')).not.toBe(await labelId(fixture.spaceId, 'bug'));
  });

  it('keeps every earlier entity_content arm: bridge (395) beside label (408)', async () => {
    // 408 REPLACES internal.entity_content. A body copied from an older definer
    // drops the arms added since, silently: that kind's content becomes '{}'.
    const rows = await database.query<{ def: string }>(
      `select pg_get_functiondef('internal.entity_content(uuid)'::regprocedure) def`);
    const arms = [...rows[0]!.def.matchAll(/when '([a-z_]+)' then/g)].map((m) => m[1]);
    // The 34 arms of 395's body (the latest definer before 408), plus label.
    const ARMS_395 = [
      'artifact', 'bridge', 'channel', 'chat', 'collection', 'commit', 'container', 'craft',
      'credential', 'doc', 'drawing', 'file', 'form', 'graph', 'interaction_profile', 'loop',
      'mcp_server', 'member', 'memory', 'message', 'project', 'pull_request', 'server', 'skill',
      'space_link', 'spell', 'story', 'style', 'task', 'team_member', 'tool', 'voice_channel',
      'work_session', 'worktree',
    ];
    expect(arms).toEqual(expect.arrayContaining([...ARMS_395, 'label']));
    const bug = await labelId(fixture.spaceId, 'bug');
    const content = await database.query<{ c: Record<string, unknown> }>(
      `select internal.entity_content($1::uuid) c`, [bug]);
    expect(content[0]!.c).toMatchObject({ name: 'bug' });
  });

  it('serves a label filter from entities_labels_gin', async () => {
    // A realistic shape: a space of thousands of entities, a few of them bugs.
    // On a near-empty space the space index is cheaper and the planner is right
    // to take it; the GIN index is what keeps the filter cheap as a space grows.
    const bug = await labelId(fixture.spaceId, 'bug');
    const plans = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.entities(space_id, kind, position, created_by, labels)
         select $1, 'doc', g, $2, case when g % 500 = 0 then array[$3::uuid] else '{}' end
           from generate_series(1, 6000) g`,
        [fixture.spaceId, fixture.memberId, bug]);
      await client.query('analyze public.entities');
      const out: string[] = [];
      for (const op of ['@>', '&&']) {
        const rows = (await client.query<{ 'QUERY PLAN': string }>(
          `explain select e.id from public.entities e
            where e.space_id = $1 and e.deleted_at is null and e.labels ${op} array[$2::uuid]`,
          [fixture.spaceId, bug])).rows;
        out.push(rows.map((r) => r['QUERY PLAN']).join('\n'));
      }
      await client.query('rollback');
      await client.query('begin');
      return out;
    });
    for (const plan of plans) expect(plan).toContain('entities_labels_gin');
  });
});
