/**
 * `opRequests.*` (lane L5, owner decision D5, migration 280) through the
 * production registry over a real PostgreSQL scratch database.
 *
 * What must hold:
 *   · an agent files a request for an allow-listed op; it is an `op_request`
 *     entity raised as an open `approve` attention item from its session;
 *   · an op off the allow-list, a body that does not fit the op's schema,
 *     wrong path params, or a requester-supplied clientMutationId are refused
 *     at create;
 *   · an agent can never approve or deny (facade AND SQL);
 *   · a `requester` request is decided only by the human the agent acts for;
 *   · on approve the op runs AS THE APPROVER (the link is the approver's), the
 *     request settles `succeeded` with the op's result, the attention item is
 *     resolved, and the outcome is messaged to the requesting session;
 *   · a repeated approve is the answer, not a second run;
 *   · the approver's own authority still decides: a gate-folder request
 *     approved by a non-admin settles `failed` with the op's refusal;
 *   · deny runs nothing and is messaged too.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { getOperation, type OperationName, type OpRequestView } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import { HandlerRegistry, registerFacadeHandlers } from '../../src/facade/index.js';
import type { OpRequestDecision } from '../../src/facade/handlers/w2/op-requests.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { RequestContext, RequestIdentity } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const HUMAN = 'opreq-human';
const OTHER = 'opreq-other';

let database: W1ScratchDatabase;
let db: Db;
let registry: HandlerRegistry;
const ids: Record<string, string> = {};
type Client = import('pg').PoolClient;

const newId = async (c: Client): Promise<string> => (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;

async function member(c: Client, space: string, identity: string, role: 'owner' | 'member'): Promise<string> {
  const id = await newId(c);
  await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [id, space]);
  await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`, [id, space, identity, role]);
  return id;
}
async function space(c: Client, name: string, identity: string): Promise<string> {
  const id = await newId(c);
  await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, $2, $3)`, [id, name, identity]);
  return id;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('op_requests');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'Human'), ($2, 'Other')`, [HUMAN, OTHER]);
    ids.spaceA = await space(c, 'Requests home', HUMAN);
    ids.spaceB = await space(c, 'Requests target', HUMAN);
    ids.memberA = await member(c, ids.spaceA, HUMAN, 'owner');
    ids.memberB = await member(c, ids.spaceB, HUMAN, 'owner');
    ids.otherA = await member(c, ids.spaceA, OTHER, 'member');
    ids.persona = await newId(c);
    ids.session = await newId(c);
    await c.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $3, 'team_member', $4, 'space'), ($2, $3, 'work_session', $1, 'space')`,
      [ids.persona, ids.session, ids.spaceA, ids.memberA]);
    await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1, $2, 'Asker', 'worker', 'persona')`,
      [ids.persona, ids.memberA]);
    await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1, 'Asker run', 'running', 'none', now())`,
      [ids.session]);
    await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'participates_in', $2)`,
      [ids.spaceA, ids.persona, ids.session]);
  });
  registry = new HandlerRegistry();
  registerFacadeHandlers(registry, {
    db,
    config: { host: '127.0.0.1', port: 0, databaseUrl: database.url } as unknown as ServerConfig,
    owner: async () => ({ identityId: HUMAN, isNodeAdmin: false }) as never,
    spaceLinks: { dataDir: await mkdtemp(join(tmpdir(), 'tm8-opreq-')) },
  });
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

const agent = (): RequestIdentity => ({
  kind: 'bearer', identityId: HUMAN, actorId: ids.persona, authKind: 'agent',
  sessionId: randomUUID(), workSessionId: ids.session, sessionSpaceId: ids.spaceA,
});
const human = (identityId = HUMAN): RequestIdentity => ({
  kind: 'bearer', identityId, authKind: 'browser', sessionId: randomUUID(), nodeAdmin: false,
});

async function call<T>(
  opName: OperationName,
  identity: RequestIdentity,
  params: Record<string, string>,
  body?: Record<string, unknown>,
  query?: Record<string, string>,
): Promise<T> {
  const op = getOperation(opName);
  const ctx: RequestContext = {
    op, opName, params, query: new URLSearchParams(query ?? {}),
    body: body === undefined ? undefined : { clientMutationId: randomUUID(), ...body },
    requestId: randomUUID(), identity, headers: {}, method: op.method, path: op.path,
  };
  return (await registry.get(opName)!(ctx)) as T;
}

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; message: string; details?: Record<string, unknown> }> {
  try {
    await run();
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error('expected a refusal');
}

const request = (op: string, input: Record<string, unknown>, params?: Record<string, string>) =>
  call<OpRequestView>('opRequests.create', agent(), { spaceId: ids.spaceA! },
    { op, input, justification: 'I need this to finish my task', ...(params ? { params } : {}) });

async function sql<R>(text: string, values: unknown[]): Promise<R[]> {
  return database.transaction(async (c) => (await c.query(text, values)).rows as R[]);
}

describe('opRequests.create', () => {
  it('files an op_request entity raised as an approve item from the requesting session', async () => {
    const filed = await request('spaceLinks.add', { targetSpaceId: ids.spaceB, alias: 'bee' });
    ids.linkRequest = filed.id;
    expect(filed).toMatchObject({
      spaceId: ids.spaceA, op: 'spaceLinks.add', label: 'Link a space', status: 'pending',
      approver: 'requester', requestedBy: ids.persona, requestingSessionId: ids.session,
      params: { spaceId: ids.spaceA }, input: { targetSpaceId: ids.spaceB, alias: 'bee' },
      decidedBy: null, result: null, error: null, canDecide: false,
    });
    expect(filed.title).toContain('Link a space: spaceId=');
    const [attention] = await sql<{ status: string; action_type: string; source_session_id: string; origin: string }>(
      `select status, action_type, source_session_id, origin from public.attention_requests where entity_id = $1`, [filed.id]);
    expect(attention).toEqual({ status: 'open', action_type: 'approve', source_session_id: ids.session, origin: 'agent' });
    const entity = await call<{ kind: string; title: string; state: unknown }>('entities.get', human(), { id: filed.id });
    expect(entity.kind).toBe('op_request');
    expect(entity.title).toBe(filed.title);
    expect(entity.state).toEqual({ kind: 'op_request', op: 'spaceLinks.add', status: 'pending' });
  });

  it('refuses an op off the allow-list, a misfit body, wrong params and a requester mutation id', async () => {
    expect(await refusal(() => request('spaces.members.remove', {}, { memberId: ids.otherA! })))
      .toMatchObject({ code: 'invalid_input', details: { reason: 'op_request_not_requestable' } });
    expect(await refusal(() => request('spaceLinks.add', { targetSpaceId: 'not-a-uuid' })))
      .toMatchObject({ code: 'invalid_input' });
    expect(await refusal(() => request('spaceLinks.setSpawn', { allowSpawn: true })))
      .toMatchObject({ code: 'invalid_input', details: { reason: 'op_request_bad_params', missing: ['linkId'] } });
    expect(await refusal(() => request('spaceLinks.add', { targetSpaceId: ids.spaceB }, { spaceId: ids.spaceA!, extra: 'x' })))
      .toMatchObject({ code: 'invalid_input', details: { reason: 'op_request_bad_params', extra: ['extra'] } });
    expect(await refusal(() => request('spaceLinks.add', { targetSpaceId: ids.spaceB, clientMutationId: 'mine' })))
      .toMatchObject({ code: 'invalid_input' });
  });
});

describe('opRequests.approve', () => {
  it('an agent can never approve or deny, at the facade or in SQL', async () => {
    expect(await refusal(() => call('opRequests.approve', agent(), { requestId: ids.linkRequest! }, {})))
      .toMatchObject({ code: 'forbidden', details: { reason: 'op_requests_human_only' } });
    expect(await refusal(() => call('opRequests.deny', agent(), { requestId: ids.linkRequest! }, {})))
      .toMatchObject({ code: 'forbidden' });
    expect(await refusal(() => db.rpc(
      { identityId: HUMAN, actorId: ids.persona, authKind: 'agent', nodeAdmin: false, requestId: randomUUID() },
      'claim_op_request', [ids.linkRequest, null],
    ))).toMatchObject({ code: 'forbidden' });
  });

  it('a requester request is decided only by the human the agent acts for', async () => {
    const seen = await call<OpRequestView>('opRequests.get', human(OTHER), { requestId: ids.linkRequest! });
    expect(seen.canDecide).toBe(false);
    expect(await refusal(() => call('opRequests.approve', human(OTHER), { requestId: ids.linkRequest! }, {})))
      .toMatchObject({ code: 'forbidden', details: { reason: 'op_request_requester_only' } });
    expect((await call<OpRequestView>('opRequests.get', human(), { requestId: ids.linkRequest! })).canDecide).toBe(true);
  });

  it('runs the op as the approver, settles succeeded, resolves attention and messages the session', async () => {
    const decided = await call<OpRequestDecision>('opRequests.approve', human(), { requestId: ids.linkRequest! }, { note: 'go ahead' });
    expect(decided.notified).toBe(true);
    expect(decided.request).toMatchObject({
      status: 'succeeded', decidedBy: ids.memberA, decisionNote: 'go ahead', error: null, canDecide: false,
    });
    const result = decided.request.result as { id: string; targetSpaceId: string; mine: { memberId: string } | null };
    expect(result.targetSpaceId).toBe(ids.spaceB);
    // The link row is the APPROVER's: the op ran as them.
    expect(result.mine?.memberId).toBe(ids.memberA);
    const links = await sql<{ n: number }>(
      `select count(*)::int n from public.space_links where home_space_id = $1 and target_space_id = $2`, [ids.spaceA, ids.spaceB]);
    expect(links[0]!.n).toBe(1);
    const [attention] = await sql<{ status: string; resolved_by: string }>(
      `select status, resolved_by from public.attention_requests where entity_id = $1`, [ids.linkRequest]);
    expect(attention).toEqual({ status: 'resolved', resolved_by: ids.memberA });
    const messages = await sql<{ anchor_id: string; author_id: string; body: string }>(
      `select anchor_id, author_id, body from public.messages where anchor_id in ($1, $2) order by anchor_id`,
      [ids.session, ids.linkRequest]);
    expect(messages.map((m) => m.anchor_id).sort()).toEqual([ids.session, ids.linkRequest].sort());
    for (const message of messages) {
      expect(message.author_id).toBe(ids.memberA);
      expect(message.body).toContain(`Your op request ${ids.linkRequest}`);
      expect(message.body).toContain('APPROVED and ran as the approver');
      expect(message.body).toContain('Note from the approver: go ahead');
    }
    // The session copy is ROUTED to the live session like any human message
    // (this composition has no PTY runtime, so it reports undelivered).
    expect(decided.delivery).toEqual([expect.objectContaining({ targetWorkSessionId: ids.session })]);
  });

  it('a repeated approve is the answer, not a second run or a second message', async () => {
    const again = await call<OpRequestDecision>('opRequests.approve', human(), { requestId: ids.linkRequest! }, {});
    expect(again).toMatchObject({ notified: false, request: { status: 'succeeded' } });
    const messages = await sql<{ n: number }>(`select count(*)::int n from public.messages where anchor_id = $1`, [ids.session]);
    expect(messages[0]!.n).toBe(1);
  });

  it('the approver\'s own authority decides: a non-admin approving a gate folder settles failed', async () => {
    const filed = await request('gate.folders.create', { name: 'opreq', workingDir: '/tmp/opreq-folder' });
    expect(filed.approver).toBe('any_member');
    expect((await call<OpRequestView>('opRequests.get', human(OTHER), { requestId: filed.id })).canDecide).toBe(true);
    const decided = await call<OpRequestDecision>('opRequests.approve', human(OTHER), { requestId: filed.id }, {});
    expect(decided.request.status).toBe('failed');
    expect(decided.request.error?.code).toBe('forbidden');
    expect(decided.request.decidedBy).toBe(ids.otherA);
    const [message] = await sql<{ body: string }>(
      `select body from public.messages where anchor_id = $1 and body like $2`, [ids.session, `%${filed.id}%`]);
    expect(message!.body).toContain('the op FAILED');
  });

  it('a path grant (282) is requestable with no path params; a non-admin approver settles it failed', async () => {
    expect((await refusal(() => request('node.pathGrants.create', { accountId: randomUUID(), rootPath: '/tmp' }, { spaceId: ids.spaceA! }))).code)
      .toBe('invalid_input');
    const filed = await request('node.pathGrants.create', { accountId: randomUUID(), rootPath: '/tmp', note: 'for my repo' });
    expect(filed).toMatchObject({ op: 'node.pathGrants.create', approver: 'any_member', params: {} });
    const decided = await call<OpRequestDecision>('opRequests.approve', human(OTHER), { requestId: filed.id }, {});
    expect(decided.request.status).toBe('failed');
    expect(decided.request.error?.code).toBe('forbidden');
  });
});

describe('opRequests.deny and reads', () => {
  it('deny runs nothing, resolves attention and is messaged; approve after deny runs nothing', async () => {
    const filed = await request('spaceLinks.add', { targetSpaceId: ids.spaceA });
    const denied = await call<OpRequestDecision>('opRequests.deny', human(), { requestId: filed.id }, { note: 'not now' });
    expect(denied).toMatchObject({ notified: true, request: { status: 'denied', decisionNote: 'not now', result: null } });
    const [attention] = await sql<{ status: string }>(`select status from public.attention_requests where entity_id = $1`, [filed.id]);
    expect(attention!.status).toBe('resolved');
    const after = await call<OpRequestDecision>('opRequests.approve', human(), { requestId: filed.id }, {});
    expect(after.request.status).toBe('denied');
    const [message] = await sql<{ body: string }>(
      `select body from public.messages where anchor_id = $1 and body like $2`, [ids.session, `%${filed.id}%`]);
    expect(message!.body).toContain('was DENIED. Nothing ran.');
  });

  it('list pages the space\'s requests newest first, filtered by status', async () => {
    const all = await call<OpRequestView[]>('opRequests.list', agent(), { spaceId: ids.spaceA! });
    expect(all.length).toBe(4);
    expect(all.map((r) => r.status)).toEqual(['denied', 'failed', 'failed', 'succeeded']);
    const denied = await call<OpRequestView[]>('opRequests.list', agent(), { spaceId: ids.spaceA! }, undefined, { status: 'denied' });
    expect(denied.map((r) => r.status)).toEqual(['denied']);
    expect(await refusal(() => call('opRequests.list', agent(), { spaceId: ids.spaceA! }, undefined, { status: 'nope' })))
      .toMatchObject({ code: 'invalid_input' });
  });

  it('a generic delete of the request entity is refused', async () => {
    expect(await refusal(() => call('entities.delete', human(), { id: ids.linkRequest! }, { expectedVersion: 1 })))
      .toMatchObject({ code: 'forbidden' });
  });
});
