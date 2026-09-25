/**
 * `launch.defaults` against a REAL PostgreSQL (design 01a0d348 §5.1, I9).
 *
 * The handler is registered as the facade registers it and runs as `tm8_app`
 * under the caller's claims. What must hold:
 *   · each group is spawn's defaults: the teammate's and the task's
 *     `remembers` minus superseded; the task's equips then the persona's (and
 *     its ancestors'); the task's reference-kind links and attachments;
 *   · PARITY: removing every default at spawn records EXACTLY these ids as
 *     `not-selected` — the sheet pre-ticks what spawn would load;
 *   · a non-task subject resolves through its one open derived task;
 *   · lenient: an unknown or malformed teammate or subject gives empty groups
 *     and a warning, never a refusal; only a non-member is refused;
 *   · header text is `whenToUse` ?? `summary`, with its source.
 */
import { randomUUID } from 'node:crypto';

import type { LaunchDefaultsResult } from '@tm8/contract';
import { composeManifest, resolveLaunchConfig, type SpawnContext } from '@tm8/execution';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { DbGraphPort } from '../../src/facade/execution-handlers.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { RequestContext } from '../../src/http/types.js';
import { registerLaunchDefaultsHandler } from '../../src/launch/defaults.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

// The pre-spawn scan refreshes filesystem references; not under test here.
vi.mock('../../src/skills/service.js', () => ({ scanSpaceSkills: vi.fn(async () => ({ scannedAt: null })) }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWNER = 'defaults-owner';
const STRANGER = 'defaults-stranger';

let database: W1ScratchDatabase;
let db: Db;
const ids: Record<string, string> = {};
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
  const props = type === 'supersedes' ? { reason: 'measured again' } : {};
  await c.query(
    `insert into public.edges(space_id, src_id, dst_id, type, props, created_by) values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [space, src, dst, type, JSON.stringify(props), ids[`member:${space}`]],
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
async function teammate(c: Client, space: string, name: string, parent: string | null = null): Promise<string> {
  const id = await entity(c, space, 'team_member', parent);
  await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1, $2, $3, '', 'persona')`, [id, ids[`member:${space}`], name]);
  return id;
}
async function space(c: Client, name: string, identity: string): Promise<string> {
  const id = await newId(c);
  await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, $2, $3)`, [id, name, identity]);
  const member = await newId(c);
  await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, id]);
  await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'owner', $3)`, [member, id, identity]);
  ids[`member:${id}`] = member;
  return id;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('launch_defaults');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'Owner'), ($2, 'Stranger')`, [OWNER, STRANGER]);
    const s = ids.space = await space(c, 'Defaults', OWNER);
    ids.strangerSpace = await space(c, 'Elsewhere', STRANGER);

    ids.parent = await teammate(c, s, 'Lead');
    ids.teammate = await teammate(c, s, 'Draco', ids.parent);
    ids.task = await entity(c, s, 'task');
    await c.query(`insert into public.tasks(entity_id, title) values ($1, 'Fix login')`, [ids.task]);

    ids.mWorking = await memory(c, s, 'working set memory');
    await edge(c, s, ids.teammate, ids.mWorking, 'remembers');
    ids.mTask = await memory(c, s, 'task memory');
    await edge(c, s, ids.task, ids.mTask, 'remembers');
    ids.mOld = await memory(c, s, 'stale claim');
    await edge(c, s, ids.teammate, ids.mOld, 'remembers');
    ids.mNew = await memory(c, s, 'current claim');
    await edge(c, s, ids.mNew, ids.mOld, 'supersedes');
    ids.mSpace = await memory(c, s, 'space memory, nobody remembers it');

    ids.sEquipped = await skill(c, s, 'deploy-runbook');
    await edge(c, s, ids.teammate, ids.sEquipped, 'equips');
    ids.sInherited = await skill(c, s, 'design-review');
    await edge(c, s, ids.parent, ids.sInherited, 'equips');
    ids.sTask = await skill(c, s, 'task-skill');
    await edge(c, s, ids.task, ids.sTask, 'equips');
    await edge(c, s, ids.task, ids.sEquipped, 'equips'); // the persona has it too: listed once, as the teammate's

    ids.doc = await entity(c, s, 'doc');
    await c.query(`insert into public.documents(entity_id, title) values ($1, 'Design notes')`, [ids.doc]);
    await edge(c, s, ids.doc, ids.task, 'attached_to');
    ids.linkedTask = await entity(c, s, 'task');
    await c.query(`insert into public.tasks(entity_id, title) values ($1, 'Upstream bug')`, [ids.linkedTask]);
    await edge(c, s, ids.task, ids.linkedTask, 'relates_to');
    await edge(c, s, ids.task, ids.parent, 'relates_to'); // a teammate: not a reference kind

    // A non-task subject with one open derived task.
    ids.note = await entity(c, s, 'doc');
    await c.query(`insert into public.documents(entity_id, title) values ($1, 'Loose note')`, [ids.note]);
    ids.derived = await entity(c, s, 'task');
    await c.query(`insert into public.tasks(entity_id, title) values ($1, 'Work on: Loose note')`, [ids.derived]);
    await edge(c, s, ids.derived, ids.note, 'derived_from');
    await edge(c, s, ids.derived, ids.mSpace, 'remembers');
  });
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

function call(query: Record<string, string>, identity = OWNER, spaceId = ids.space!): Promise<LaunchDefaultsResult> {
  const registry = new HandlerRegistry();
  registerLaunchDefaultsHandler(registry, { db, config: {}, owner: async () => ({ identityId: identity, isNodeAdmin: false }) } as unknown as FacadeDeps);
  return registry.get('launch.defaults')!({
    params: { spaceId }, query: new URLSearchParams(query), body: undefined, requestId: randomUUID(),
    identity: { kind: 'loopback' }, headers: {}, method: 'GET', path: '/',
  } as unknown as RequestContext) as Promise<LaunchDefaultsResult>;
}
const idsOf = (group: LaunchDefaultsResult['memories']) => group.items.map((item) => item.entityId);

describe('launch.defaults — spawn’s defaults, per group', () => {
  it('memories: the teammate’s and the task’s remembers, minus superseded, with where each came from', async () => {
    const result = await call({ teamMemberId: ids.teammate!, subjectId: ids.task! });
    expect(result.memories.items.map((i) => [i.entityId, i.via])).toEqual([[ids.mWorking, 'teammate'], [ids.mTask, 'task']]);
    expect(result.memories.total).toBe(2);
    expect(result.taskId).toBe(ids.task);
    expect(result.warnings).toEqual([]);
  });

  it('skills: the task’s equips the persona lacks, then the persona’s and its ancestors’', async () => {
    const result = await call({ teamMemberId: ids.teammate!, subjectId: ids.task! });
    expect(result.skills.items.map((i) => [i.entityId, i.via, i.title])).toEqual([
      [ids.sTask, 'task', 'task-skill'],
      [ids.sEquipped, 'teammate', 'deploy-runbook'],
      [ids.sInherited, 'inherited', 'design-review'],
    ]);
    // A skill's native header text is its description.
    expect(result.skills.items[0]).toMatchObject({ headerText: 'task-skill help', headerSource: 'native' });
  });

  it('references: the task’s reference-kind links and attachments, never a teammate', async () => {
    const result = await call({ teamMemberId: ids.teammate!, subjectId: ids.task! });
    expect(result.references.items.map((i) => [i.entityId, i.kind, i.via, i.title])).toEqual([
      [ids.doc, 'doc', 'linked', 'Design notes'],
      [ids.linkedTask, 'task', 'linked', 'Upstream bug'],
    ]);
  });

  it('PARITY: a spawn that removes every default records EXACTLY these ids as not-selected', async () => {
    const result = await call({ teamMemberId: ids.teammate!, subjectId: ids.task! });
    const port = new DbGraphPort(db);
    const claims: DbClaims = { identityId: OWNER, nodeAdmin: false, requestId: randomUUID() };
    const context: SpawnContext = await port.loadSpawnContext(claims, {
      spaceId: ids.space!, teamMemberId: ids.teammate!, taskIds: [ids.task!],
      selection: { memoryIds: [], skillIds: [], referenceIds: [] },
    });
    const request = { spaceId: ids.space!, teamMemberId: ids.teammate! };
    const manifest = composeManifest({
      sessionId: 'session', request, context, launch: resolveLaunchConfig(request, context, {}),
      workdir: { mode: 'project', path: '/repo' }, command: 'test', baseUrl: 'http://localhost',
    });
    const dropped = (group: string) => (manifest.context?.dropped ?? [])
      .filter((d) => d.group === group && d.reason === 'not-selected').map((d) => d.entityId);
    expect(dropped('memories')).toEqual(idsOf(result.memories));
    expect(dropped('references')).toEqual(idsOf(result.references));
    expect((context.skippedSkills ?? []).filter((s) => s.reason === 'not-selected').map((s) => s.entityId))
      .toEqual(idsOf(result.skills));
  });

  it('a non-task subject resolves through its one open derived task, and writes nothing', async () => {
    const edges = async () => Number((await database.query<{ n: string }>('select count(*)::text n from public.edges'))[0]!.n);
    const before = await edges();
    const result = await call({ teamMemberId: ids.teammate!, subjectId: ids.note! });
    expect(result.taskId).toBe(ids.derived);
    expect(idsOf(result.memories)).toContain(ids.mSpace);
    expect(await edges()).toBe(before);
  });
});

describe('launch.defaults is lenient', () => {
  it('an unknown teammate: the task’s defaults still come, and a warning says why the rest do not', async () => {
    const result = await call({ teamMemberId: randomUUID(), subjectId: ids.task! });
    expect(idsOf(result.memories)).toEqual([ids.mTask]);
    // Both are the task's now (no persona to own one), in the task loader's name order.
    expect(idsOf(result.skills)).toEqual([ids.sEquipped, ids.sTask]);
    expect(result.warnings).toEqual([expect.stringMatching(/not a live teammate/)]);
  });

  it('a malformed or missing teammate and subject: empty groups and warnings, never a 4xx', async () => {
    const result = await call({ teamMemberId: 'not-an-id', subjectId: 'nope' });
    expect(result.memories).toEqual({ items: [], total: 0 });
    expect(result.skills).toEqual({ items: [], total: 0 });
    expect(result.references).toEqual({ items: [], total: 0 });
    expect(result.warnings).toHaveLength(2);
    const bare = await call({});
    expect(bare.warnings).toEqual([expect.stringMatching(/No teamMemberId/)]);
  });

  it('a subject in another space is unreadable: no task defaults, a warning', async () => {
    const result = await call({ teamMemberId: ids.teammate!, subjectId: ids.strangerSpace! });
    expect(result.taskId).toBeNull();
    expect(idsOf(result.memories)).toEqual([ids.mWorking]);
    expect(result.warnings).toEqual([expect.stringMatching(/not a live entity/)]);
  });

  it('only authorization refuses: a non-member of the space is forbidden', async () => {
    await expect(call({ teamMemberId: ids.teammate! }, STRANGER)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
