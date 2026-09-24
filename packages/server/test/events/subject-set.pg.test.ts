/**
 * THE canonical subject set (migration 208, src/events/subject-set.ts), pinned
 * on both sides:
 *
 *   - TS: every event type the mapper projects (capture arms + passthrough) is
 *     classified — a subject type with its payload keys, or explicitly
 *     subjectless. A new projected type with no decision fails here.
 *   - SQL: `internal.event_subject_ids` agrees with `subjectIdsOf` on every
 *     classified type, subjectless types and unknown types included.
 *   - 208's corrective pass rewrites the `counter.changed` rows 205 indexed as
 *     '{}', and `events.poll ?entity=` (which now reads the same derivation)
 *     finds counter changes — indexed rows and not-yet-backfilled rows alike.
 *
 * The chain is applied in two parts (…207, then 208) so the corrective pass
 * runs against rows 205's trigger actually wrote.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CAPTURED_EVENT_TYPES, RPC_AUTHORED_PASSTHROUGH } from '../../src/events/mapper.js';
import { PgDurableEventLog } from '../../src/events/poll.js';
import { EVENT_SUBJECT_KEYS, SUBJECTLESS_EVENT_TYPES, subjectIdsOf } from '../../src/events/subject-set.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';
import { openDb, type OwnerDb } from './changes-fixture.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const MIGRATION = '208_event_subject_ids_canonical_set.sql';

describe('the canonical subject set — TypeScript side', () => {
  it('classifies EXACTLY the types the mapper projects, each once', () => {
    const projected = [...CAPTURED_EVENT_TYPES, ...RPC_AUTHORED_PASSTHROUGH].sort();
    const classified = [...Object.keys(EVENT_SUBJECT_KEYS), ...SUBJECTLESS_EVENT_TYPES].sort();
    expect(classified).toEqual(projected);
    expect(new Set(classified).size).toBe(classified.length);
  });

  it('decides the two contested types: counter.changed and git.* are subject types', () => {
    expect(EVENT_SUBJECT_KEYS['counter.changed']).toEqual(['entity_id']);
    expect(EVENT_SUBJECT_KEYS['git.pr_state_changed']).toEqual(['prEntityId']);
    expect(EVENT_SUBJECT_KEYS['git.commit_recorded']).toEqual(['commitEntityId']);
    expect(EVENT_SUBJECT_KEYS['git.worktree_status_changed']).toEqual(['worktreeEntityId']);
  });

  it('subjectIdsOf keeps only uuid-shaped values, distinct and sorted', () => {
    const a = randomUUID();
    expect(subjectIdsOf('edge.upsert', { src_id: a, dst_id: a })).toEqual([a]);
    expect(subjectIdsOf('counter.changed', { entity_id: 'not-a-uuid' })).toEqual([]);
    expect(subjectIdsOf('menu.updated', { id: a })).toEqual([]);
    expect(subjectIdsOf('some.unknown_type', { id: a })).toEqual([]);
  });
});

describe.sequential('the canonical subject set — SQL side and 208 (real Postgres)', () => {
  let database: W1ScratchDatabase;
  let db: OwnerDb;
  let spaceId: string;
  let memberId: string;
  let anchorTask: string;
  const identityId = `identity_${randomUUID()}`;
  const claims = () => ({ identityId, nodeAdmin: false, requestId: `req_${randomUUID()}` });

  const sqlSubjects = async (type: string, payload: Record<string, unknown>): Promise<string[]> => {
    const rows = await db.tx(claims(), (q) => q.query<{ ids: string[] }>(
      'select internal.event_subject_ids($1, $2::jsonb)::text[] ids', [type, JSON.stringify(payload)]));
    return rows[0]!.ids;
  };

  const counterRow = async (entityId: string): Promise<string[] | null> => {
    const rows = await db.asOwner((q) => q.query<{ subject_ids: string[] | null }>(
      `insert into public.workspace_events(space_id, seq, event_type, payload)
       values ($1, internal.next_event_seq($1), 'counter.changed', $2::jsonb)
       returning subject_ids::text[] subject_ids`,
      [spaceId, JSON.stringify({ entity_id: entityId, messages: 1 })],
    ));
    return rows[0]!.subject_ids;
  };

  let preIndexed: string;
  let preTarget: string;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('subject_set_208');
    const chain = migrationFiles();
    const at = chain.indexOf(MIGRATION);
    expect(at, `${MIGRATION} is not in the chain`).toBeGreaterThan(0);
    database.apply(chain.slice(0, at));
    db = openDb(database.url);

    await db.rpc(claims(), 'public.upsert_user_profile', ['Subject Set', null, null]);
    const created = await db.rpc<{ space: { id: string } }>(claims(), 'public.create_space', [
      'subject set space', '208 proof', 'private', null, null,
    ]);
    spaceId = created.space.id;
    memberId = (await db.query<{ entity_id: string }>(
      claims(), 'select entity_id from public.members where space_id = $1 and identity_id = $2', [spaceId, identityId],
    ))[0]!.entity_id;
    anchorTask = (await db.rpc<{ entity: { id: string } }>(claims(), 'public.create_task', [
      spaceId, 'subject set anchor', memberId, '', '{}', null, null, 'medium', '[]', null, null, null, null,
      'attached_to', `cmid_${randomUUID()}`,
    ])).entity.id;

    // Written under 205's derivation: a counter row indexed as "about nothing".
    preTarget = randomUUID();
    expect(await counterRow(preTarget)).toEqual([]);
    preIndexed = preTarget;

    database.apply([MIGRATION]);
    // 209 (Forms W1): the entity reads now join `public.forms`.
    database.apply(['209_forms_foundation.sql']);
  }, 300_000);

  afterAll(async () => {
    await db?.end().catch(() => undefined);
    await database?.destroy().catch(() => undefined);
  });

  it('208 corrected the counter.changed rows 205 indexed as {}', async () => {
    const rows = await db.asOwner((q) => q.query<{ subject_ids: string[] }>(
      `select subject_ids::text[] subject_ids from public.workspace_events
        where space_id = $1 and event_type = 'counter.changed' and payload->>'entity_id' = $2`,
      [spaceId, preIndexed],
    ));
    expect(rows.map((r) => r.subject_ids)).toEqual([[preTarget]]);
    // And every indexed row now agrees with the canonical derivation.
    const drift = await db.asOwner((q) => q.query<{ n: string }>(
      `select count(*)::text n from public.workspace_events
        where subject_ids is not null
          and subject_ids is distinct from internal.event_subject_ids(event_type, payload)`,
    ));
    expect(drift[0]!.n).toBe('0');
  });

  it('the live trigger indexes a new counter.changed row by its entity', async () => {
    const id = randomUUID();
    expect(await counterRow(id)).toEqual([id]);
  });

  it('SQL and TypeScript agree on every classified type, subjectless and unknown types included', async () => {
    const allKeys = [...new Set(Object.values(EVENT_SUBJECT_KEYS).flat()), 'id', 'actor_id', 'created_by'];
    const types = [...Object.keys(EVENT_SUBJECT_KEYS), ...SUBJECTLESS_EVENT_TYPES, 'some.unknown_type'];
    for (const type of types) {
      // Every key any type reads, each with its own uuid: a derivation that
      // read the wrong key would pick up a decoy.
      const payload: Record<string, unknown> = {};
      for (const k of allKeys) payload[k] = randomUUID();
      expect(await sqlSubjects(type, payload), type).toEqual(subjectIdsOf(type, payload));
    }
  });

  it('tm8_app can execute the derivation (events.poll uses it for unindexed rows)', async () => {
    const id = randomUUID();
    expect(await sqlSubjects('counter.changed', { entity_id: id })).toEqual([id]);
  });

  it('events.poll ?entity= finds counter changes — indexed rows and not-yet-backfilled rows', async () => {
    const log = new PgDurableEventLog(db);
    const before = Number((await db.asOwner((q) => q.query<{ m: string }>(
      'select max(seq)::text m from public.workspace_events where space_id = $1', [spaceId])))[0]!.m);
    await db.asOwner((q) => q.rpc('public.post_message', [
      anchorTask, 'bumps the anchor counter', memberId, null, '[]', '[]', `cmid_${randomUUID()}`,
    ]), claims());

    const page = await log.since(spaceId, before, 500, claims(), { entityId: anchorTask });
    expect(page.items.map((e) => e.type)).toContain('counter.changed');

    // The same window with every row un-indexed (as below a backfill watermark):
    // the filter computes the same derivation and returns the same page.
    await db.asOwner((q) => q.query(
      'update public.workspace_events set subject_ids = null where space_id = $1 and seq > $2', [spaceId, before]));
    const unindexed = await log.since(spaceId, before, 500, claims(), { entityId: anchorTask });
    expect(unindexed.items.map((e) => e.seq)).toEqual(page.items.map((e) => e.seq));
  });
});
