import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
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
  database = await createW1ScratchDatabase('tools');
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
    await c.query("insert into public.work_sessions(entity_id,title,status,share_mode) values($1,'Invoker','spawning','none')", [parent]);
    await c.query("insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'participates_in',$2)", [space, persona, parent]);
  });
});
afterAll(async () => { await db?.end(); await database?.destroy(); });

it('creates and snapshots definitions/config through versioned RPCs with strict SQL validation and RLS', async () => {
  const id = await create('snapshot-tool');
  await db.rpc(auth(), 'set_tool_config', [id, await version(id), 'value', JSON.stringify('configured'), false, null, randomUUID()]);
  const [snapshot] = await database.query('select snapshot from public.entity_versions where entity_id=$1 order by version desc limit 1', [id]);
  expect(snapshot!.snapshot.content.definition).toMatchObject(definition('snapshot-tool'));
  expect(snapshot!.snapshot.content.config).toEqual({ value: 'configured' });
  await expect(db.rpc(auth(), 'update_tool_entity', [id, await version(id), { ...definition('snapshot-tool'), command: 'bad' }, null, randomUUID()])).rejects.toThrow();
  for (const env of ['PATH', 'SHELL', 'BASH_ENV', 'LD_PRELOAD', 'PYTHONPATH', 'HOME', 'TERM']) {
    await expect(db.rpc(auth(), 'create_tool_entity', [space, { ...definition('bad-env'), inputs: [{ name: 'value', type: 'string', env }] }, null, randomUUID()])).rejects.toThrow();
  }
  await expect(db.rpc({ ...auth(), sessionSpaceId: randomUUID() }, 'set_tool_config', [id, await version(id), 'value', JSON.stringify('bad'), false, null, randomUUID()])).rejects.toThrow();
  await expect(database.transaction(async c => { await c.query('set local role tm8_app'); await c.query('insert into public.tools(entity_id,space_id,title,definition) values($1,$2,$3,$4)', [randomUUID(), space, 'forbidden', definition('forbidden')]); })).rejects.toThrow();
});

it('mints runnable none/tool sessions, pins hash and parent, and registers executes', async () => {
  const tool = await create('agent-run', false, agent);
  const session = await run(tool, { value: 'hello' }, true, agent);
  const [row] = await database.query('select ws.*,e.parent_id from public.work_sessions ws join public.entities e on e.id=ws.entity_id where e.id=$1', [session]);
  expect(row).toMatchObject({ session_kind: 'tool', credential_binding: 'none', credential_none_reason: 'tool', parent_id: parent,
    tool_source_sha256: createHash('sha256').update(definition('agent-run').source).digest('hex'), share_mode: 'none' });
  await db.rpc(agent, 'work_session_transition', [session, 'running']);
  expect(await database.query("select id from public.edges where src_id=$1 and dst_id=$2 and type='executes'", [session, tool])).toHaveLength(1);
  expect(await database.query("select id from public.edges where src_id=$1 and type='runs'", [session])).toHaveLength(0);
});

it('records two credentials and runs_on edges; agents use their owner account and edits preserve bindings', async () => {
  const tool = await create('bound-run', true);
  const one = await credential(tool, 'token_one'), two = await credential(tool, 'token_two');
  const inputs = { token_one: { secret: one }, token_two: { secret: two } };
  await expect(run(tool, inputs, false, auth('tools-peer'))).rejects.toThrow();
  const resolved = await db.rpc<{ credentialId: string }>(agent, 'read_tool_credential', [space, tool, 'token_one', one]);
  expect(resolved.credentialId).toBe(one);
  const session = await run(tool, inputs, true, agent);
  expect(await database.query('select provider from public.session_space_credentials where work_session_id=$1', [session])).toHaveLength(2);
  expect(await database.query("select id from public.edges where src_id=$1 and type='runs_on'", [session])).toHaveLength(2);
  expect((await database.query('select credential_binding from public.work_sessions where entity_id=$1', [session]))[0]!.credential_binding).toBe('bound');
  await db.rpc(agent, 'work_session_transition', [session, 'running']);
  await db.rpc(agent, 'update_tool_entity', [tool, await version(tool), { ...definition('bound-run', true), source: 'echo edited' }, null, randomUUID()]);
  expect(await database.query('select credential_id from public.tool_secret_bindings where tool_id=$1', [tool])).toHaveLength(2);
  await expect(db.rpc(agent, 'create_tool_credential', [randomUUID(), space, tool, 'token_one', 'bad', null, Buffer.alloc(32), Buffer.alloc(12), await version(tool), null, randomUUID()])).rejects.toThrow();
  await expect(db.rpc({ ...agent, viaLinkId: randomUUID() }, 'read_tool_credential', [space, tool, 'token_one', one])).rejects.toThrow();
  await expect(db.rpc(auth('tools-owner', 'link'), 'read_tool_credential', [space, tool, 'token_one', one])).rejects.toThrow();
  await expect(db.rpc(auth(), 'read_space_credential_for_spawn', [space, 'tool', one])).rejects.toThrow('server-only');
  await expect(db.rpc(auth(), 'read_space_service_key', [space, 'tool'])).rejects.toThrow();
  await expect(db.rpc(auth(), 'read_tool_credential', [space, await create('unrelated-tool', true), 'token_one', one])).rejects.toThrow();
  await expect(db.rpc(auth(), 'repoint_session_space_credentials', [session])).rejects.toThrow();
  await expect(db.rpc(auth(), 'repoint_session_space_credentials', [session, ['tool']])).rejects.toThrow();
  const [snapshot] = await database.query('select snapshot from public.entity_versions where entity_id=$1 order by version desc limit 1', [tool]);
  expect(JSON.stringify(snapshot!.snapshot)).not.toContain('ciphertext');
  expect(snapshot!.snapshot.content.secretBindings).toHaveLength(2);
  // Pairing is enforced even for writers other than the recorder.
  for (const [target, provider, credentialId] of [[parent, 'tool', one], [session, 'github', one]]) {
    await expect(database.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query('insert into public.session_space_credentials(work_session_id,provider,space_credential_id,space_id,launcher_account_id) values($1,$2,$3,$4,(select id from public.accounts where identity_id=$5))', [target, provider, credentialId, space, 'tools-owner']);
    })).rejects.toThrow('exclusively');
  }
  // Explicit sharing enables a peer launch and records that peer as launcher.
  await db.rpc(auth(), 'share_space_credential', [one, peer]);
  const peerRun = await run(tool, { token_one: { secret: one } }, false, auth('tools-peer'));
  expect((await database.query('select launcher_account_id from public.session_space_credentials where work_session_id=$1', [peerRun]))[0]!.launcher_account_id)
    .toBe((await database.query("select id from public.accounts where identity_id='tools-peer'"))[0]!.id);
});

it('settles exit outcomes independently of PTY state, excludes runs from counts and idle auto-close', async () => {
  const tool = await create('exit-runs');
  for (const [state, code, outcome] of [['exited', 0, 'completed'], ['exited', 3, 'completed'], ['timed_out', 124, 'stopped'], ['killed', null, 'stopped']] as const) {
    const session = await run(tool, {}, true);
    await db.rpc(auth(), 'work_session_transition', [session, 'running']);
    await db.rpc(auth(), 'record_tool_exit', [session, code, state, 'redacted tail']);
    const [row] = await database.query('select status,outcome,outcome_source,tool_exit_code,tool_state from public.work_sessions where entity_id=$1', [session]);
    expect(row).toMatchObject({ status: 'running', outcome, outcome_source: 'self', tool_exit_code: code, tool_state: state });
    await db.rpc(auth(), 'record_tool_exit', [session, 99, 'exited', 'duplicate']);
    expect((await database.query('select tool_exit_code from public.work_sessions where entity_id=$1', [session]))[0]!.tool_exit_code).toBe(code);
    // Age the clocks under the existing writer to prove the idle auto-close exclusion.
    await database.transaction(async c => {
      await c.query("select set_config('tm8.work_session_outcome','on',true)");
      await c.query("update public.work_sessions set outcome_at=now()-interval '2 days' where entity_id=$1", [session]);
      await c.query("update public.entities set activity_at=now()-interval '2 days' where id=$1", [session]);
    });
    expect(await db.rpc(auth(), 'completed_sessions_to_close', ['tool-test'])).toEqual([]);
  }
  const counts = await db.rpc<Array<{ kind: string; total: number }>>(auth(), 'space_kind_counts', [space]);
  expect(counts.find(c => c.kind === 'work_session')?.total).toBe(1); // Only the invoking agent fixture.
});

it('accepts config-only version advances, refuses changed source, and frees deleted tool names', async () => {
  const tool = await create('version-pin');
  const before = await version(tool);
  await db.rpc(auth(), 'set_tool_config', [tool, before, 'value', JSON.stringify('new'), false, null, randomUUID()]);
  const session = await run(tool, { value: 'new' }, false, auth(), before);
  expect((await database.query('select tool_version from public.work_sessions where entity_id=$1', [session]))[0]!.tool_version).toBe(await version(tool));
  await db.rpc(auth(), 'update_tool_entity', [tool, await version(tool), { ...definition('version-pin'), source: 'echo changed' }, null, randomUUID()]);
  await expect(run(tool, {}, false, auth(), before)).rejects.toThrow('source changed');
  for (const [index, patch] of [
    { inputs: [{ name: 'value', type: 'string', required: true }] },
    { tm8Access: 'write' }, { timeoutSeconds: 1 }, { runtime: 'python' },
  ].entries()) {
    const name = `execution-revision-${index}`;
    const changed = await create(name);
    const prior = await version(changed);
    await db.rpc(auth(), 'update_tool_entity', [changed, prior, { ...definition(name), ...patch }, null, randomUUID()]);
    await expect(run(changed, { value: 'resolved' }, false, auth(), prior)).rejects.toThrow('execution settings changed');
  }
  const original = await create('reusable-name');
  await expect(create('reusable-name')).rejects.toThrow();
  await database.query('update public.entities set deleted_at=now() where id=$1', [original]);
  const replacement = await create('reusable-name');
  expect(replacement).not.toBe(original);
  await expect(database.query('update public.entities set deleted_at=null where id=$1', [original])).rejects.toThrow('already has this name');
});
