/**
 * Exact selection at spawn, against a REAL PostgreSQL (design 01a0cb80 §5.2).
 *
 * The REAL `DbGraphPort.loadSpawnContext` runs as `tm8_app` under the
 * caller's claims. With `selection`:
 *   · the memories are EXACTLY `selection.memoryIds`, in that order — no
 *     working set, no task `remembers` set, no legacy jsonb remainder;
 *   · the skills are EXACTLY `selection.skillIds` — an unequipped one is read
 *     for this session only and NO edge is written;
 *   · equipped skills left out are audited `not-selected`;
 *   · an id that is not a live memory/skill of this space refuses by name.
 * Without it, the load is what it always was. And `linkSession` ties an Ask
 * Jev run to the session it launched, once, in its own space only.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { composeManifest, resolveLaunchConfig, type SpawnContext } from '@tm8/execution';

import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { DbGraphPort } from '../../src/facade/execution-handlers.js';
import { linkSession, upsertRun } from '../../src/jev/store.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

// The pre-spawn scan refreshes filesystem references from real home
// directories; it is not what is under test and must not touch this machine.
vi.mock('../../src/skills/service.js', () => ({ scanSpaceSkills: vi.fn(async () => ({ scannedAt: null })) }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const IDENTITY = 'selection-owner';
let database: W1ScratchDatabase;
let db: Db;
let port: DbGraphPort;
const ids: Record<string, string> = {};
const claims = (): DbClaims => ({ identityId: IDENTITY, nodeAdmin: false, requestId: randomUUID() });

type Client = import('pg').PoolClient;
const newId = async (c: Client): Promise<string> => (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;

async function entity(c: Client, space: string, kind: string, parent: string | null = null): Promise<string> {
  const id = await newId(c);
  await c.query(
    `insert into public.entities(id, space_id, kind, parent_id, position, created_by) values ($1, $2, $3, $4, 0, $5)`,
    [id, space, kind, parent, ids[`member:${space}`] ?? id],
  );
  return id;
}
async function edge(c: Client, space: string, src: string, dst: string, type: string): Promise<void> {
  await c.query(
    `insert into public.edges(space_id, src_id, dst_id, type, props, created_by) values ($1, $2, $3, $4, '{}'::jsonb, $5)`,
    [space, src, dst, type, ids[`member:${space}`]],
  );
}
async function memory(c: Client, space: string, statement: string): Promise<string> {
  const id = await entity(c, space, 'memory');
  await c.query(
    `insert into public.memories(entity_id, statement, mechanism, subject_scope, does_not_establish) values ($1, $2, 'seed', 'scratch', 'runtime')`,
    [id, statement],
  );
  return id;
}
async function skill(c: Client, space: string, name: string): Promise<string> {
  const id = await entity(c, space, 'skill');
  await c.query(`insert into public.skills(entity_id, space_id, name, description) values ($1, $2, $3, $4)`, [id, space, name, `${name} help`]);
  return id;
}
async function space(c: Client, name: string): Promise<string> {
  const id = await newId(c);
  await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, $2, $3)`, [id, name, IDENTITY]);
  const member = await newId(c);
  await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, id]);
  await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'owner', 'Owner')`, [member, id, IDENTITY]);
  ids[`member:${id}`] = member;
  return id;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('spawn_selection');
  database.apply(migrationFiles());
  db = createDb(database.url);
  port = new DbGraphPort(db);
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'Owner')`, [IDENTITY]);
    const s = ids.space = await space(c, 'Selection');
    ids.otherSpace = await space(c, 'Other');
    ids.parent = await entity(c, s, 'team_member');
    await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1, $2, 'Lead', '', 'lead')`, [ids.parent, ids[`member:${s}`]]);
    ids.teammate = await entity(c, s, 'team_member', ids.parent);
    await c.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity, memories) values ($1, $2, 'Draco', 'PTY', 'persona', '["legacy jsonb note"]'::jsonb)`,
      [ids.teammate, ids[`member:${s}`]],
    );
    ids.task = await entity(c, s, 'task');
    await c.query(`insert into public.tasks(entity_id, title) values ($1, 'Fix login')`, [ids.task]);

    ids.mWorking = await memory(c, s, 'working set memory');
    await edge(c, s, ids.teammate, ids.mWorking, 'remembers');
    ids.mTask = await memory(c, s, 'task memory');
    await edge(c, s, ids.task, ids.mTask, 'remembers');
    ids.mA = await memory(c, s, 'selected A');
    ids.mB = await memory(c, s, 'selected B');
    ids.mDeleted = await memory(c, s, 'deleted memory');
    await c.query(`update public.entities set deleted_at = now() where id = $1`, [ids.mDeleted]);

    ids.sEquipped = await skill(c, s, 'deploy-runbook');
    await edge(c, s, ids.teammate, ids.sEquipped, 'equips');
    ids.sInherited = await skill(c, s, 'design-review');
    await edge(c, s, ids.parent, ids.sInherited, 'equips');
    ids.sFree = await skill(c, s, 'figma-connector');
    ids.sElsewhere = await skill(c, ids.otherSpace, 'foreign-skill');

    ids.session = await entity(c, s, 'work_session');
    await c.query(`insert into public.work_sessions(entity_id) values ($1)`, [ids.session]);
    ids.session2 = await entity(c, s, 'work_session');
    await c.query(`insert into public.work_sessions(entity_id) values ($1)`, [ids.session2]);
  });
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

const load = (extra: Record<string, unknown> = {}) => port.loadSpawnContext(claims(), {
  spaceId: ids.space!, teamMemberId: ids.teammate!, taskIds: [ids.task!], ...extra,
});
const equipEdges = async () => Number((await database.query<{ n: string }>(
  `select count(*)::text n from public.edges where type = 'equips'`,
))[0]!.n);

function manifestOf(context: SpawnContext) {
  const request = { spaceId: ids.space!, teamMemberId: ids.teammate! };
  return composeManifest({
    sessionId: 'session', request, context, launch: resolveLaunchConfig(request, context, {}),
    workdir: { mode: 'project', path: '/repo' }, command: 'test', baseUrl: 'http://localhost',
  });
}

describe('with selection', () => {
  it('memories are EXACTLY the selected ones, in the selected order', async () => {
    const context = await load({ selection: { memoryIds: [ids.mB, ids.mA], skillIds: [] } });
    expect(context.teamMember.memories).toEqual(['selected B', 'selected A']);
  });

  it('skills are EXACTLY the selected ones; an unequipped one rides this session with no edge written', async () => {
    const before = await equipEdges();
    const context = await load({ selection: { memoryIds: [], skillIds: [ids.sFree, ids.sEquipped] } });
    expect(context.skillEquips?.map((s) => s.entityId)).toEqual([ids.sFree, ids.sEquipped]);
    expect(await equipEdges()).toBe(before);
    const manifest = manifestOf(context);
    expect(manifest.skills.map((s) => s.entityId)).toEqual([ids.sFree, ids.sEquipped]);
  });

  it('equipped skills left out are audited as not-selected', async () => {
    const context = await load({ selection: { memoryIds: [], skillIds: [ids.sFree] } });
    expect(context.skippedSkills?.map((s) => [s.entityId, s.reason]).sort()).toEqual(
      [[ids.sEquipped, 'not-selected'], [ids.sInherited, 'not-selected']].sort(),
    );
    const audit = manifestOf(context).effectiveSkills!;
    expect(audit.skipped.filter((s) => s.reason === 'not-selected').map((s) => s.name).sort()).toEqual(['deploy-runbook', 'design-review']);
    expect(audit.indexed.map((s) => s.entityId)).toEqual([ids.sFree]);
  });

  it('refuses ids that are not live memories/skills of this space — by name, all of them', async () => {
    const unknown = randomUUID();
    const refusal = load({
      selection: { memoryIds: [ids.mA, ids.task, ids.mDeleted, unknown], skillIds: [ids.sElsewhere, ids.mB] },
    });
    await expect(refusal).rejects.toMatchObject({ code: 'invalid_input' });
    const message = String((await refusal.catch((e: Error) => e)).message);
    for (const bad of [ids.task, ids.mDeleted, unknown, ids.sElsewhere, ids.mB]) expect(message).toContain(bad);
    expect(message).not.toContain(ids.mA);
  });
});

describe('without selection', () => {
  it('is the load it always was: working set, task set, legacy remainder, equipped skills, no not-selected audit', async () => {
    const context = await load();
    expect(context.teamMember.memories).toEqual(['working set memory', 'task memory', 'legacy jsonb note']);
    expect(context.skillEquips?.map((s) => s.entityId)).toEqual([ids.sEquipped, ids.sInherited]);
    expect('skippedSkills' in context).toBe(false);
  });
});

describe('linkSession', () => {
  it('ties the run to the session it launched — once, in its own space only', async () => {
    const runId = randomUUID();
    await db.tx(claims(), (q) => upsertRun(q, { runId, spaceId: ids.space!, subjectId: ids.task!, suggestions: {} }));
    const sessionOf = async () => (await database.query<{ session_id: string | null }>(
      'select session_id::text from public.jev_runs where id = $1', [runId],
    ))[0]!.session_id;

    expect(await db.tx(claims(), (q) => linkSession(q, runId, ids.session!, ids.otherSpace!))).toBe(false);
    expect(await sessionOf()).toBeNull();
    expect(await db.tx(claims(), (q) => linkSession(q, runId, ids.session!, ids.space!))).toBe(true);
    expect(await sessionOf()).toBe(ids.session);
    // A second launch never moves a run's attribution.
    expect(await db.tx(claims(), (q) => linkSession(q, runId, ids.session2!, ids.space!))).toBe(false);
    expect(await sessionOf()).toBe(ids.session);
    // An unknown run is a quiet false, for the caller to log.
    expect(await db.tx(claims(), (q) => linkSession(q, randomUUID(), ids.session!, ids.space!))).toBe(false);
  });
});
