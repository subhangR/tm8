import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { WorkspaceEventSchema } from '@tm8/contract';

const A = 'seen-member-a';
const B = 'seen-member-b';
const space = randomUUID();
const otherSpace = randomUUID();
const member = randomUUID();
const otherMember = randomUUID();
const sameUserOtherSpace = randomUUID();
const old = randomUUID();

describe.sequential('per-member permanent seen entities (Postgres)', () => {
  let db: W1ScratchDatabase;
  const as = <T>(identity: string, sql: string, args: unknown[] = [], auth = 'browser', pin = '') =>
    db.transaction(async (q) => {
      await q.query('set local role tm8_app');
      await q.query(`select set_config('tm8.identity_id', $1, true),
        set_config('tm8.auth_kind', $2, true), set_config('tm8.session_space_id', $3, true)`, [identity, auth, pin]);
      return (await q.query(sql, args)).rows as T[];
    });
  const docs = async (identity = A, spaceId = space) =>
    (await as<{ total: number; unseen: number }>(identity,
      "select total, unseen from public.space_kind_counts($1) where kind = 'doc'", [spaceId]))[0];
  const add = async (options: { space?: string; parent?: string; visibility?: string } = {}) => {
    const id = randomUUID();
    await db.query(`insert into public.entities(id, space_id, kind, created_by, parent_id, visibility)
      values ($1, $2, 'doc', $3, $4, $5)`,
    [id, options.space ?? space, options.space ? sameUserOtherSpace : member,
      options.parent ?? null, options.visibility ?? 'space']);
    return id;
  };
  const mark = async (id: string, identity = A, mutation = randomUUID(), auth = 'browser') =>
    (await as<{ result: { entityId: string; seenAt: string } }>(identity,
      'select public.mark_entity_seen($1, $2) result', [id, mutation], auth))[0]!.result;

  beforeAll(async () => {
    db = await createW1ScratchDatabase('seen_entities');
    const files = migrationFiles();
    const migration = '313_seen_entities.sql';
    db.apply(files.slice(0, files.indexOf(migration)));
    await db.transaction(async (q) => {
      await q.query('set local role tm8_graph_owner');
      await q.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'A'), ($2, 'B')`, [A, B]);
      await q.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Seen A', $3), ($2, 'Seen B', $3)`, [space, otherSpace, A]);
      await q.query(`insert into public.entities(id, space_id, kind, created_by) values
        ($1, $4, 'member', $1), ($2, $4, 'member', $2), ($3, $5, 'member', $3)`,
      [member, otherMember, sameUserOtherSpace, space, otherSpace]);
      await q.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values
        ($1, $4, $6, 'owner', 'A'), ($2, $4, $7, 'member', 'B'), ($3, $5, $6, 'owner', 'A')`,
      [member, otherMember, sameUserOtherSpace, space, otherSpace, A, B]);
      await q.query(`insert into public.entities(id, space_id, kind, created_by, created_at)
        values ($1, $2, 'doc', $3, now() - interval '1 day')`, [old, space, member]);
    });
    db.apply([migration]);
  }, 180_000);
  afterAll(async () => { await db?.destroy(); }, 30_000);

  it('starts pre-rollout entities seen and counts new roots and children across the space', async () => {
    expect(await docs()).toEqual({ total: 1, unseen: 0 });
    const parent = await add();
    await add({ parent });
    expect(await docs()).toEqual({ total: 3, unseen: 2 });
  });

  it('isolates users/spaces, persists the first click and emits one private event', async () => {
    const id = await add();
    const other = await add({ space: otherSpace });
    const beforeA = (await docs())!.unseen;
    const beforeB = (await docs(B))!.unseen;
    const first = await mark(id);
    expect(await mark(id)).toEqual(first);
    expect((await docs())!.unseen).toBe(beforeA - 1);
    expect((await docs(B))!.unseen).toBe(beforeB);
    expect((await docs(A, otherSpace))!.unseen).toBe(1);
    expect(await as(B, 'select * from public.entity_seen')).toEqual([]);
    const events = await db.query<{ recipient_member_id: string; payload: object }>(
      "select recipient_member_id, payload from public.workspace_events where event_type = 'entity.seen' and payload->>'entityId' = $1", [id]);
    expect(events).toHaveLength(1);
    expect(events[0]!.recipient_member_id).toBe(member);
    expect(WorkspaceEventSchema.safeParse({ ...events[0]!.payload, spaceId: space, seq: 1,
      occurredAt: first.seenAt, schemaVersion: 1 }).success).toBe(true);
    expect(await as(B, "select id from public.workspace_events where event_type = 'entity.seen'")).toEqual([]);
    await mark(other);
    expect((await docs(A, otherSpace))!.unseen).toBe(0);
  });

  it('never resets on edits and never treats message reads as list clicks', async () => {
    const id = await add();
    const before = (await docs())!.unseen;
    await as(A, 'select public.mark_read($1, $2)', [id, randomUUID()]);
    expect((await docs())!.unseen).toBe(before);
    await mark(id);
    await db.query("update public.entities set activity_at = now() + interval '1 minute', updated_at = now() where id = $1", [id]);
    expect((await docs())!.unseen).toBe(before - 1);
    await db.query("update public.entities set activity_at = now() + interval '1 minute' where id = $1", [old]);
    expect((await docs())!.unseen).toBe(before - 1);
  });

  it('excludes archives and restricted entities and denies unauthorized markers', async () => {
    const before = (await docs())!;
    const hidden = await add({ visibility: 'restricted' });
    const archived = await add();
    await db.query('update public.entities set deleted_at = now() where id = $1', [archived]);
    expect(await docs()).toEqual(before);
    await expect(mark(hidden)).rejects.toMatchObject({ code: 'P0002' });
    await expect(mark(archived)).rejects.toMatchObject({ code: 'P0002' });
    await expect(mark(old, 'outsider')).rejects.toMatchObject({ code: 'P0002' });
    await expect(mark(old, A, randomUUID(), 'agent')).rejects.toMatchObject({ code: '42501' });
    expect(await as('outsider', 'select * from public.space_kind_counts($1)', [space])).toEqual([]);
    expect(await as(A, 'select * from public.space_kind_counts($1)', [otherSpace], 'browser', space)).toEqual([]);
    await expect(as(A, 'select public.mark_entity_seen($1, $2)', [old, randomUUID()], 'browser', otherSpace))
      .rejects.toMatchObject({ code: 'P0002' });
    await expect(as(A, 'insert into public.entity_seen(member_id, entity_id) values ($1, $2)', [otherMember, old]))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('binds replay to the user and entity and indexes its subject', async () => {
    const id = await add();
    const mutation = randomUUID();
    const result = await mark(id, A, mutation);
    expect(await mark(id, A, mutation)).toEqual(result);
    await expect(mark(old, A, mutation)).rejects.toMatchObject({ code: '23514' });
    await expect(mark(id, B, mutation)).rejects.toMatchObject({ code: '23514' });
    expect(await db.query("select internal.event_subject_ids('entity.seen', jsonb_build_object('entityId', $1::text)) ids", [id]))
      .toEqual([{ ids: [id] }]);
  });
});
