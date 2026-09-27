/**
 * Launch card v3, lane B, against a REAL PostgreSQL:
 *   · the in-full read in `loadSpawnContext` (kind and readability refusals,
 *     resume's re-read that leaves a gone id out, the derived-task pointer);
 *   · `launch.defaults` serves `inFullBudgetBytes` and `launchCapBytes`;
 *   · `launch.preview` on spawn's own composition: sections, bytes, leftOut
 *     (`unticked` / `jev` / `duplicate`), indexDropped with `stillLinked`, the
 *     refusals spawn would give at 200, and NOTHING written.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { CollabError, type LaunchDefaultsResult, type LaunchPreviewInput, type LaunchPreviewResult } from '@tm8/contract';
import { BYTE_BUDGETS } from '@tm8/prompt';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { DbGraphPort, registerExecutionHandlers } from '../../src/facade/execution-handlers.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { RequestContext } from '../../src/http/types.js';
import { registerLaunchDefaultsHandler } from '../../src/launch/defaults.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.mock('../../src/skills/service.js', () => ({ scanSpaceSkills: vi.fn(async () => ({ scannedAt: null })) }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWNER = 'preview-owner';
const STRANGER = 'preview-stranger';

let database: W1ScratchDatabase;
let db: Db;
let dataDir: string;
const ids: Record<string, string> = {};
type Client = import('pg').PoolClient;

const newId = async (c: Client): Promise<string> => (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
async function entity(c: Client, space: string, kind: string): Promise<string> {
  const id = await newId(c);
  await c.query(
    `insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, $3, 0, $4)`,
    [id, space, kind, ids[`member:${space}`] ?? id],
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
async function doc(c: Client, space: string, title: string, body: string): Promise<string> {
  const id = await entity(c, space, 'doc');
  await c.query(`insert into public.documents(entity_id, title, body) values ($1, $2, $3)`, [id, title, body]);
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
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-launch-preview-'));
  database = await createW1ScratchDatabase('launch_preview');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'Owner'), ($2, 'Stranger')`, [OWNER, STRANGER]);
    const s = ids.space = await space(c, 'Preview', OWNER);
    ids.strangerSpace = await space(c, 'Elsewhere', STRANGER);
    ids.strangerDoc = await doc(c, ids.strangerSpace, 'Not yours', 'secret');

    ids.teammate = await entity(c, s, 'team_member');
    await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity, agent_tool) values ($1, $2, 'Draco', '', 'persona', 'claude-code')`, [ids.teammate, ids[`member:${s}`]]);
    ids.task = await entity(c, s, 'task');
    await c.query(`insert into public.tasks(entity_id, title, description) values ($1, 'Fix login', 'The login form drops the session.')`, [ids.task]);

    ids.mWorking = await memory(c, s, 'working set memory');
    await edge(c, s, ids.teammate, ids.mWorking, 'remembers');
    ids.mTask = await memory(c, s, 'task memory');
    await edge(c, s, ids.task, ids.mTask, 'remembers');

    ids.spec = await doc(c, s, 'Login spec', 'The whole login spec, in full.');
    await edge(c, s, ids.spec, ids.task, 'attached_to');
    ids.design = await doc(c, s, 'Design notes', 'notes');
    await edge(c, s, ids.design, ids.task, 'attached_to');
    ids.huge = await doc(c, s, 'Huge', 'h'.repeat(BYTE_BUDGETS.inFullInjection));
    ids.gone = await doc(c, s, 'Deleted later', 'bye');

    // A non-task subject with no open derived task (spawn would mint one).
    ids.note = await doc(c, s, 'Loose note', 'A loose note to work on.');
    // A non-task subject WITH one, for the loader's pointer.
    ids.source = await doc(c, s, 'Source doc', 'The source text.');
    ids.derived = await entity(c, s, 'task');
    await c.query(`insert into public.tasks(entity_id, title, description) values ($1, 'Work on: Source doc', 'Launched from doc. {copied body}')`, [ids.derived]);
    await edge(c, s, ids.derived, ids.source, 'derived_from');
  });
  await database.query('update public.entities set deleted_at = now() where id = $1', [ids.gone]);
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
  await rm(dataDir, { recursive: true, force: true });
});

const claims = (identity = OWNER): DbClaims => ({ identityId: identity, nodeAdmin: false, requestId: randomUUID() });

function registry(identity = OWNER): HandlerRegistry {
  const r = new HandlerRegistry();
  registerExecutionHandlers(r, {
    db,
    pty: { liveSessionIds: () => [], hasSession: () => false } as never,
    dataDir,
    config: { host: '127.0.0.1', port: 4617 } as never,
    owner: async () => ({ identityId: identity, accountId: 'a', username: 'o', isNodeAdmin: false, isOwner: false }),
  });
  return r;
}

function preview(body: Partial<LaunchPreviewInput>, identity = OWNER): Promise<LaunchPreviewResult> {
  const input = { spaceId: ids.space!, teamMemberId: ids.teammate!, ...body };
  return registry(identity).get('launch.preview')!({
    params: { spaceId: input.spaceId }, query: new URLSearchParams(), body: input, requestId: randomUUID(),
    identity: { kind: 'loopback' }, headers: {}, method: 'POST', path: '/',
  } as unknown as RequestContext) as Promise<LaunchPreviewResult>;
}

async function counts(): Promise<Record<string, string>> {
  return (await database.query<Record<string, string>>(
    `select (select count(*) from public.entities)::text entities, (select count(*) from public.edges)::text edges,
            (select count(*) from public.work_sessions)::text sessions, (select count(*) from public.tasks)::text tasks`,
  ))[0]!;
}

describe('launch.defaults serves the in-full budgets', () => {
  it('inFullBudgetBytes and launchCapBytes', async () => {
    const r = new HandlerRegistry();
    registerLaunchDefaultsHandler(r, { db, config: {}, owner: async () => ({ identityId: OWNER, isNodeAdmin: false }) } as unknown as FacadeDeps);
    const result = await r.get('launch.defaults')!({
      params: { spaceId: ids.space }, query: new URLSearchParams({ teamMemberId: ids.teammate! }), body: undefined,
      requestId: randomUUID(), identity: { kind: 'loopback' }, headers: {}, method: 'GET', path: '/',
    } as unknown as RequestContext) as LaunchDefaultsResult;
    expect(result.inFullBudgetBytes).toBe(BYTE_BUDGETS.inFullInjection);
    expect(result.launchCapBytes).toBe(32_768);
  });
});

describe('loadSpawnContext: the in-full read', () => {
  const load = (input: Record<string, unknown>) => new DbGraphPort(db).loadSpawnContext(claims(), {
    spaceId: ids.space!, teamMemberId: ids.teammate!, ...input,
  });

  it('reads each entity whole, in request order, leaving the subject task out', async () => {
    const context = await load({ taskIds: [ids.task!], inFullIds: [ids.spec!, ids.mTask!, ids.task!] });
    expect(context.inFull?.map((e) => [e.entityId, e.kind])).toEqual([[ids.spec, 'doc'], [ids.mTask, 'memory']]);
    expect(context.inFull?.[0]).toMatchObject({ title: 'Login spec', body: 'The whole login spec, in full.' });
  });

  it('refuses another kind by name (in_full_kind_not_allowed), and an unreadable id as not_found', async () => {
    await expect(load({ inFullIds: [ids.teammate!] })).rejects.toMatchObject({
      code: 'invalid_input', details: { reason: 'in_full_kind_not_allowed', ids: [ids.teammate] },
    });
    for (const id of [ids.strangerDoc!, ids.gone!]) {
      await expect(load({ inFullIds: [id] })).rejects.toMatchObject({ code: 'not_found', details: { ids: [id] } });
    }
  });

  it('a resume re-reads: a gone id is left out and named, not refused', async () => {
    const context = await load({ inFullIds: [ids.spec!, ids.gone!], inFullReplay: true });
    expect(context.inFull?.map((e) => e.entityId)).toEqual([ids.spec]);
    expect(context.inFullUnavailable).toEqual([ids.gone]);
  });

  it('a derived task whose source is sent in full carries a pointer, not the copy', async () => {
    const context = await load({ taskIds: [ids.derived!], inFullIds: [ids.source!] });
    expect(context.tasks[0]?.description).toContain(`Derived from \`${ids.source}\``);
    expect(context.tasks[0]?.description).not.toContain('copied body');
    const plain = await load({ taskIds: [ids.derived!] });
    expect(plain.tasks[0]?.description).toContain('copied body');
  });
});

describe('launch.preview', () => {
  it('reports the sections spawn composes, with in full winning over <linked>, and writes nothing', async () => {
    const before = await counts();
    const result = await preview({ taskIds: [ids.task!], inFullIds: [ids.spec!], promptExtra: 'Mind the cookie.' });
    expect(await counts()).toEqual(before);
    expect(result.refusal).toBeNull();
    expect(result.sections.map((s) => s.key)).toEqual(expect.arrayContaining(['task', 'in_full', 'notes', 'context_index']));
    const keys = result.sections.map((s) => s.key);
    expect(keys).toEqual([...keys].sort((a, b) =>
      ['task', 'in_full', 'notes', 'context_index', 'attachments', 'linked'].indexOf(a)
      - ['task', 'in_full', 'notes', 'context_index', 'attachments', 'linked'].indexOf(b)));
    const inFull = result.sections.find((s) => s.key === 'in_full')!;
    expect(inFull.items).toEqual([expect.objectContaining({ id: ids.spec, kind: 'doc', title: 'Login spec' })]);
    expect(result.inFull.budgetBytes).toBe(BYTE_BUDGETS.inFullInjection);
    expect(result.inFull.bytes).toBeGreaterThan(inFull.bytes);
    expect(result.launchCapBytes).toBe(32_768);
    expect(result.totalBytes).toBeGreaterThan(0);
    expect(result.totalBytes).toBeLessThanOrEqual(32_768);
    // Listed once: not in the index, not in <linked>.
    for (const s of result.sections.filter((x) => x.key !== 'in_full')) {
      expect(s.items.map((i) => i.id)).not.toContain(ids.spec);
    }
    expect(result.leftOut).toContainEqual({ id: ids.spec, kind: 'doc', title: 'Login spec', reason: 'duplicate' });
  });

  it('leftOut: jevRemovedIds marks Jev\'s removals, every other unticked default is unticked', async () => {
    const result = await preview({
      taskIds: [ids.task!], selection: { memoryIds: [] }, jevRemovedIds: [ids.mWorking!, ids.design!],
    });
    expect(result.leftOut).toEqual(expect.arrayContaining([
      { id: ids.mWorking, kind: 'memory', title: expect.any(String), reason: 'jev' },
      { id: ids.mTask, kind: 'memory', title: expect.any(String), reason: 'unticked' },
    ]));
    // A default still selected (the design doc) is not left out at all.
    expect(result.leftOut.map((l) => l.id)).not.toContain(ids.design);
  });

  it('indexDropped: the index fills what is left of the cap; a dropped link stays in <linked> (stillLinked)', async () => {
    // Measure the launch, then leave the index ~500 bytes: notes are spent before it.
    const probe = await preview({ taskIds: [ids.task!], promptExtra: 'x' });
    const sectionBytes = (r: LaunchPreviewResult, key: string) => r.sections.find((s) => s.key === key)?.bytes ?? 0;
    const frame = sectionBytes(probe, 'notes') - 1;
    const rest = probe.totalBytes - sectionBytes(probe, 'context_index') - sectionBytes(probe, 'notes');
    const notes = 'x'.repeat(32_768 - rest - frame - 500);
    const result = await preview({ taskIds: [ids.task!], promptExtra: notes });
    expect(result.refusal).toBeNull();
    expect(result.totalBytes).toBeLessThanOrEqual(32_768);
    expect(result.indexDropped.length).toBeGreaterThan(0);
    // References give way before memories; a dropped task link keeps its id line.
    const dropped = result.indexDropped.find((d) => d.id === ids.design);
    expect(dropped).toMatchObject({ kind: 'doc', title: 'Design notes', stillLinked: true });
    expect(dropped!.bytes).toBeGreaterThan(0);
    expect(result.sections.find((s) => s.key === 'linked')?.items.map((i) => i.id)).toContain(ids.design);
    expect(result.sections.find((s) => s.key === 'context_index')?.items.map((i) => i.id) ?? []).not.toContain(ids.design);
  });

  it('a non-task subject is previewed as the task spawn would mint, with the pointer, and nothing is minted', async () => {
    const before = await counts();
    const result = await preview({ taskIds: [ids.note!], inFullIds: [ids.note!] });
    expect(await counts()).toEqual(before);
    expect(result.refusal).toBeNull();
    expect(result.sections.find((s) => s.key === 'task')!.items[0]?.title).toBe('Work on: Loose note');
    expect(result.sections.find((s) => s.key === 'in_full')!.items.map((i) => i.id)).toEqual([ids.note]);
  });

  it('newTask is previewed as the task spawn would create, nothing is created; beside taskIds it is refused', async () => {
    const before = await counts();
    const result = await preview({ newTask: { title: '  Ship the card  ' } });
    expect(await counts()).toEqual(before);
    expect(result.refusal).toBeNull();
    expect(result.sections.find((s) => s.key === 'task')!.items[0]?.title).toBe('Ship the card');
    expect((await preview({ newTask: { title: 'x' }, taskIds: [ids.task!] })).refusal).toMatchObject({
      code: 'invalid_input', reason: 'new_task_conflict',
    });
  });

  it('answers 200 with spawn\'s refusal: in_full_kind_not_allowed, not_found, in_full_budget, launch_total', async () => {
    expect((await preview({ taskIds: [ids.task!], inFullIds: [ids.teammate!] })).refusal).toMatchObject({
      code: 'invalid_input', reason: 'in_full_kind_not_allowed', details: { ids: [ids.teammate] },
    });
    expect((await preview({ taskIds: [ids.task!], inFullIds: [ids.strangerDoc!] })).refusal).toMatchObject({
      code: 'not_found', details: { ids: [ids.strangerDoc] },
    });
    const overInFull = await preview({ taskIds: [ids.task!], inFullIds: [ids.huge!] });
    expect(overInFull.refusal).toMatchObject({
      code: 'payload_too_large', reason: 'in_full_budget', details: { limitBytes: BYTE_BUDGETS.inFullInjection },
    });
    expect(overInFull.sections.find((s) => s.key === 'in_full')?.items[0]?.id).toBe(ids.huge);
    const overCap = await preview({ taskIds: [ids.task!], promptExtra: 'n'.repeat(33_000) });
    expect(overCap.refusal).toMatchObject({ code: 'payload_too_large', reason: 'launch_total', details: { limitBytes: 32_768 } });
  });

  it('refuses a non-member and a path/body space mismatch as errors, not refusals', async () => {
    await expect(preview({ taskIds: [ids.task!] }, STRANGER)).rejects.toBeInstanceOf(CollabError);
    await expect(registry().get('launch.preview')!({
      params: { spaceId: ids.strangerSpace }, query: new URLSearchParams(),
      body: { spaceId: ids.space, teamMemberId: ids.teammate }, requestId: randomUUID(),
      identity: { kind: 'loopback' }, headers: {}, method: 'POST', path: '/',
    } as unknown as RequestContext)).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
