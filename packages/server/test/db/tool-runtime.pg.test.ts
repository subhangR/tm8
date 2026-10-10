import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolViewSchema, EntitySummarySchema, OPERATIONS } from '@tm8/contract';
import { PtyHostService, type SpawnService } from '@tm8/execution';
import { ToolRuntime } from '../../src/tools/runtime.js';
import { loadTool, loadToolRun } from '../../src/tools/views.js';
import { loadEntitySummariesByIds } from '../../src/facade/entity-read.js';
import { PgEntityProjector } from '../../src/events/projector.js';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60000, hookTimeout: 300000 });
let database: W1ScratchDatabase;
let db: Db;
const space = randomUUID(), owner = randomUUID(), peer = randomUUID(), persona = randomUUID(), parent = randomUUID();
const auth = (identityId = 'tools-owner', authKind = 'browser'): DbClaims => ({ identityId, authKind, sessionSpaceId: space });
const agent: DbClaims = { ...auth('tools-owner', 'agent'), actorId: persona, workSessionId: parent };
const definition = (name: string, secrets = false) => ({ name, description: 'DB fixture', help: 'Usage', runtime: 'bash',
  source: 'printf "%s" "$VALUE"', tm8Access: 'none', timeoutSeconds: 900,
  inputs: [{ name: 'value', type: 'string' }, ...(secrets ? [{ name: 'token_one', type: 'secret' }, { name: 'token_two', type: 'secret' }] : [])] });
async function version(id: string): Promise<number> {
  return (await database.query<{ version: number }>('select version from public.entities where id=$1', [id]))[0]!.version;
}
async function create(name: string, secrets = false, claims = auth()) {
  const result = await db.rpc<{ entity: { id: string } }>(claims, 'create_tool_entity', [space, definition(name, secrets), null, randomUUID()]);
  return result.entity.id;
}
async function run(tool: string, inputs: Record<string, unknown> = {}, keepOpen = false, claims = auth(), expected?: number) {
  const result = await db.rpc<{ entity: { id: string } }>(claims, 'start_tool_session',
    [space, tool, expected ?? await version(tool), inputs, keepOpen, 'tool-test', '/tmp', 100, null, randomUUID()]);
  return result.entity.id;
}
async function credential(tool: string, input: string) {
  const id = randomUUID();
  await db.rpc(auth(), 'create_tool_credential', [id, space, tool, input, `Fixture ${input}`, 'hint', Buffer.alloc(32, 7), Buffer.alloc(12, 8), await version(tool), null, randomUUID()]);
  return id;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('tool_tokens');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    for (const identity of ['tools-owner', 'tools-peer']) {
      await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1)', [identity]);
      await c.query('insert into public.accounts(identity_id,username,display_name) values($1,$1,$1)', [identity]);
    }
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'Tools fixture','tools-owner')", [space]);
    for (const [id, identity, role] of [[owner, 'tools-owner', 'owner'], [peer, 'tools-peer', 'member']]) {
      await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1)", [id, space]);
      await c.query('insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,$4,$3)', [id, space, identity, role]);
    }
    await c.query("select set_config('tm8.identity_id','tools-owner',true),set_config('tm8.auth_kind','browser',true)");
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$3,'team_member',0,$4),($2,$3,'work_session',0,$1)", [persona, parent, space, owner]);
    await c.query("insert into public.team_members(entity_id,owner_member_id,name,role,identity) values($1,$2,'Tool invoker','','persona')", [persona, owner]);
    await c.query("insert into public.work_sessions(entity_id,title,status,share_mode) values($1,'Invoker','running','none')", [parent]);
    await c.query("insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'participates_in',$2)", [space, persona, parent]);
  });
});
afterAll(async () => { await db?.end(); await database?.destroy(); });

async function accessibleTool(access: 'none' | 'read' | 'write') {
 const result = await db.rpc<{entity: {id: string}}>(auth(), 'create_tool_entity',
  [space, { ...definition(`scope-${randomUUID()}`), tm8Access: access }, null, randomUUID()]);
 return result.entity.id;
}
async function mint(session: string, claims = agent, scope = 'write') {
 const hash = createHash('sha256').update(randomUUID()).digest('hex');
 const row = await db.rpc<{id: string; api_scope: string; kind: string}>(claims, 'issue_tool_session_agent_session',
  [session, persona, hash, new Date(Date.now() + 60000).toISOString(), scope]);
 return { hash, row };
}

it('mints only for live agent personas, with the pinned tool/caller cap and canonical linkage', async () => {
 const tool = await accessibleTool('read'), session = await run(tool, {}, true, agent);
 for (const kind of ['browser','cli','link']) await expect(mint(session, { ...agent, authKind: kind })).rejects.toThrow();
 await expect(mint(session, { ...agent, viaLinkId: randomUUID() })).rejects.toThrow();
 await expect(mint(session, { ...agent, actorId: owner })).rejects.toThrow();
 await expect(mint(session, { ...agent, workSessionId: undefined })).rejects.toThrow();
 const { hash, row } = await mint(session);
 expect(row).toMatchObject({ api_scope: 'read', kind: 'agent' });
 expect(row).not.toHaveProperty('token_hash');
 expect(await db.rpc({}, 'resolve_auth_session', [hash])).toMatchObject({ apiScope: 'read', actingAsTeamMemberId: persona, workSessionId: session, identityId: 'tools-owner' });
 expect(await database.query("select id from public.edges where src_id=$1 and dst_id=$2 and type='participates_in'", [persona, session])).toHaveLength(1);
 expect(await database.query("select id from public.edges where src_id=$1 and dst_id=$2 and type='relates_to'", [persona, session])).toHaveLength(0);
 await db.rpc(auth(), 'update_tool_entity', [tool, await version(tool), { ...definition(`scope-${randomUUID()}`), tm8Access: 'write' }, null, randomUUID()]);
 expect((await mint(session)).row.api_scope).toBe('read');
 const writeSession = await run(await accessibleTool('write'), {}, false, agent);
 expect((await mint(writeSession, { ...agent, apiScope: 'read' })).row.api_scope).toBe('read');
 expect((await mint(writeSession)).row.api_scope).toBe('write');
 await expect(mint(await run(await accessibleTool('none'), {}, false, agent))).rejects.toThrow();
 await expect(database.query("update public.auth_sessions set api_scope='write' where id=$1", [row.id])).rejects.toThrow('immutable');
});

it('revokes on tool settlement or PTY end, with an idempotent explicit revoke and live resolve backstop', async () => {
 const session = await run(await accessibleTool('write'), {}, true, agent);
 await db.rpc(agent, 'work_session_transition', [session, 'running']);
 const { hash } = await mint(session);
 await db.rpc(agent, 'record_tool_exit', [session, 7, 'exited', '[redacted]']);
 expect(await db.rpc({}, 'resolve_auth_session', [hash])).toBeNull();
 await db.rpc(agent, 'revoke_agent_auth_session', [session]);
 await db.rpc(agent, 'revoke_agent_auth_session', [session]);
 const runView = await db.tx(agent, q => loadToolRun(q, session));
 expect(runView).toMatchObject({ state: 'exited', exitCode: 7, outputTail: '[redacted]', invoker: { id: persona } });
 expect(runView.startedAt).toBeTruthy(); expect(runView.exitedAt).toBeTruthy();
 const [read] = await db.tx(agent, q => loadEntitySummariesByIds(q, [session], 'tools-owner'));
 const event = await db.tx(agent, q => new PgEntityProjector().entitySummaries(q, [session]));
 for (const summary of [read!, event.get(session)!]) {
  expect(EntitySummarySchema.safeParse(summary).success).toBe(true);
  expect(summary.state).toMatchObject({ sessionKind: 'tool', status: 'running', outcome: 'completed', toolRun: { state: 'exited', exitCode: 7 } });
 }
 const killed = await run(await accessibleTool('write'), {}, false, agent);
 await db.rpc(agent, 'work_session_transition', [killed, 'running']);
 const bearer = await mint(killed);
 await db.rpc(agent, 'work_session_transition', [killed, 'failed', null, 'killed before status']);
 expect(await db.rpc({}, 'resolve_auth_session', [bearer.hash])).toBeNull();
});

it('creates private credentials without default-label collisions and strict-parses real tool projections', async () => {
 const tool = await create('repeat-secret', true), dir = await mkdtemp(join(tmpdir(), 'tool-secret-'));
 const pty = new PtyHostService();
 const runtime = new ToolRuntime({ db, pty, spawnService: { adoptToolSession: vi.fn() } as unknown as SpawnService,
  dataDir: dir, baseUrl: 'http://127.0.0.1:17777', nodeId: 'tool-test' });
 try {
  for (const value of ['first-private-value','second-private-value']) await runtime.createSecret(auth(), {
   toolId: tool, inputName: 'token_one', expectedVersion: await version(tool), clientMutationId: randomUUID(), value });
  const rows = await database.query("select label,visibility from public.space_credentials where provider='tool'");
  expect(rows).toHaveLength(2); expect(new Set(rows.map(r => r.label)).size).toBe(2);
  expect(rows.every(r => r.visibility === 'private')).toBe(true);
  const view = await db.tx(auth(), q => loadTool(q, tool));
  expect(ToolViewSchema.parse(view).secretBindings[0]).toMatchObject({ inputName: 'token_one', keyHint: '••••', boundBy: { id: owner } });
  expect(view.secretBindings[0]!.boundAt).toBeTruthy();
  const [read] = await db.tx(auth(), q => loadEntitySummariesByIds(q, [tool], 'tools-owner'));
  const event = await db.tx(auth(), q => new PgEntityProjector().entitySummaries(q, [tool]));
  for (const summary of [read!, event.get(tool)!]) {
   expect(EntitySummarySchema.safeParse(summary).success).toBe(true);
   const { kind, ...projectedView } = summary.state;
   expect(kind).toBe('tool'); expect(ToolViewSchema.parse(projectedView).secretBindings).toEqual(view.secretBindings);
  }
  expect(JSON.stringify(view)).not.toContain('private-value');
 } finally { await rm(dir, { recursive: true, force: true }); }
 expect(OPERATIONS.some(op => JSON.stringify(op).includes('record_tool_exit'))).toBe(false);
});

it('runs only reviewed stored source, resolves server inputs, and never returns secret values or the bearer', async () => {
 const result = await db.rpc<{entity: {id: string}}>(auth(), 'create_tool_entity', [space, {
  ...definition('runtime-probe'), tm8Access: 'read',
  source: 'printf "%s|%s|%s\\n" "$VALUE" "$KEY" "$TM8_AGENT_TOKEN"; exit 6',
  inputs: [{ name: 'value', type: 'string', required: true, default: 'default-public' }, { name: 'key', type: 'secret', required: true }],
 }, null, randomUUID()]);
 const tool = result.entity.id, dir = await mkdtemp(join(tmpdir(), 'tool-runtime-'));
 const pty = new PtyHostService(), runtime = new ToolRuntime({ db, pty,
  spawnService: { adoptToolSession: vi.fn() } as unknown as SpawnService, dataDir: dir,
  baseUrl: 'http://127.0.0.1:17777', nodeId: 'tool-test' });
 const identity = { identityId: 'tools-owner', authKind: 'agent', actorId: persona, workSessionId: parent } as const;
 let session: string | undefined;
 try {
  await db.rpc(auth(), 'set_tool_config', [tool, await version(tool), 'value', JSON.stringify('configured-public'), false, null, randomUUID()]);
  await runtime.createSecret(auth(), { toolId: tool, expectedVersion: await version(tool), inputName: 'key', value: 'bound-private-value', clientMutationId: randomUUID() });
  const input = { toolId: tool, inputs: { value: 'argument-public' }, keepOpen: true, clientMutationId: randomUUID() };
  const started = await runtime.run(agent, identity, input); session = started.sessionId;
  expect(Object.keys(started).sort()).toEqual(['keepOpen','reused','sessionId','sourceSha256','toolId','toolVersion']);
  expect(JSON.stringify(started)).not.toContain('private-value');
  await vi.waitFor(async () => expect((await db.tx(agent, q => loadToolRun(q, session!))).state).toBe('exited'), { timeout: 10000 });
  const runView = await db.tx(agent, q => loadToolRun(q, session!));
  expect(runView).toMatchObject({ exitCode: 6, inputs: { value: 'argument-public' } });
  expect(runView.outputTail).toContain('argument-public|[credential-redacted]|[credential-redacted]');
  expect(runView.outputTail).not.toContain('bound-private-value'); expect(runView.outputTail).not.toMatch(/tm8s_/);
  expect((await database.query('select revoked_at from public.auth_sessions where work_session_id=$1', [session]))[0]!.revoked_at).toBeTruthy();
  expect((await runtime.run(agent, identity, input)).reused).toBe(true);
  const reviewed = await version(tool);
  const view = await db.tx(agent, q => loadTool(q, tool));
  await db.rpc(auth(), 'update_tool_entity', [tool, reviewed, { ...view.definition, source: 'echo edited' }, null, randomUUID()]);
  const changed = await db.tx(agent, q => loadTool(q, tool));
  expect(changed.sourceChangedSinceViewerLastRun).toMatchObject({ byActor: { id: owner }, fromSha: started.sourceSha256, toSha: changed.sourceSha256 });
  await expect(runtime.run(agent, identity, { ...input, clientMutationId: randomUUID(), expectedVersion: reviewed })).rejects.toThrow();
  await expect(runtime.run(auth(), { identityId: 'tools-owner', authKind: 'browser' }, input)).rejects.toThrow('invoking agent');
 } finally { if (session) pty.kill(session); await rm(dir, { recursive: true, force: true }); }
});
