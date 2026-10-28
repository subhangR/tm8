/**
 * Scheduled tool runs (migration 379, docs/features/tools/SCHEDULED-RUNS.md):
 * the production composition on a throwaway database, real PTYs, the run token
 * resolved by production auth. Firing claims come from the real
 * `createLoopExecutorPort.claimsForLoop`.
 *
 * Reviewer checks, one `it` each where they are SQL facts:
 *  (1) the mint admits only no-bearer claims whose authority is a MARKED
 *      triggered_by edge written by the spawn writer in the run's transaction;
 *  (2) kind 'agent' token acting as the loop persona, revoked on every exit path;
 *  (3) p_tool_version is never null for a firing;
 *  (4) two firings are two runs, a retry of one is a replay;
 *  (5) tm8Access none mints nothing;
 *  (6) no path produces a human-kind (or persona-less) token;
 *  plus: a bound secret is used only when the firing account may use it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { DbClaims } from '../../src/db/types.js';
import { createLoopExecutorPort } from '../../src/facade/execution-handlers.js';
import type { DueLoop } from '../../src/scheduler/jobs/loops.js';
import { ToolRuntime } from '../../src/tools/runtime.js';
import { addSpaceMember, claimsFor, ownerOfSpace, startWsE2eNode, type WsE2eNode } from '../events/ws-e2e-harness.js';

vi.setConfig({ testTimeout: 60000, hookTimeout: 300000 });
let node: WsE2eNode, runtime: ToolRuntime, firingClaims: (identityId: string, loop: string) => DbClaims;
let spaceId: string, otherSpaceId: string;
let owner: { identityId: string; memberId: string }, peer: { identityId: string; memberId: string };
const persona = randomUUID(), otherPersona = randomUUID();
let loop: string, otherLoop: string, personaLessLoop: string, farLoop: string;
const cmid = () => randomUUID();
const tokenHash = () => createHash('sha256').update(randomUUID()).digest('hex');

async function createTool(name: string, tm8Access: 'none' | 'read' | 'write', source = 'exit 0', inputs: unknown[] = []) {
  const result = await node.rpcDb.rpc<{ entity: { id: string } }>(claimsFor(owner.identityId), 'create_tool_entity',
    [spaceId, { name, description: 'Scheduled fixture', help: '', runtime: 'bash', source, tm8Access, timeoutSeconds: 30, inputs }, null, cmid()]);
  return result.entity.id;
}
async function createLoop(space: string, title: string, teamMemberId: string | null, identityId = owner.identityId) {
  const result = await node.rpcDb.rpc<{ entity: { id: string } }>(claimsFor(identityId), 'create_loop',
    [space, title, null, 'every 1d', teamMemberId, null, '', '{}', false, null, null, null, cmid()]);
  return result.entity.id;
}
async function versionOf(id: string) {
  return (await node.database.query<{ version: number }>('select version from public.entities where id=$1', [id]))[0]!.version;
}
async function runCount(tool: string) {
  return (await node.database.query<{ n: number }>('select count(*)::int n from public.work_sessions where tool_id=$1', [tool]))[0]!.n;
}
async function provenanceEdge(run: string, to: string) {
  return (await node.database.query<{ props: { provenance?: boolean; firedAt?: string }; created_by: string }>(
    "select props,created_by from public.edges where src_id=$1 and dst_id=$2 and type='triggered_by'", [run, to]))[0];
}
async function tokensOf(run: string) {
  return node.database.query<{ id: string; kind: string; api_scope: string; acting_as_team_member_id: string | null; space_id: string;
    label: string; parent_session_id: string | null; revoked_at: unknown; within_timeout: boolean }>(
    `select s.id,s.kind,s.api_scope,s.acting_as_team_member_id,s.space_id,s.label,s.parent_session_id,s.revoked_at,
       s.expires_at<=now()+interval '91 seconds' within_timeout from public.auth_sessions s where s.work_session_id=$1 order by s.created_at`, [run]);
}
/**
 * The SQL doors are called through the PRODUCTION Db, the one `runScheduled`
 * uses: it binds all eight claims (auth kind, link, work session included) and
 * translates SQLSTATEs to contract codes. The harness's `rpcDb` binds four
 * claims and throws raw pg errors, so a bearer refusal is invisible through it.
 */
const door = () => node.production.db!;
async function resolve(hash: string) {
  return node.rpcDb.rpc<Record<string, unknown> | null>({}, 'resolve_auth_session', [hash]);
}

beforeAll(async () => {
  node = await startWsE2eNode('scheduled_tools');
  const space = async (name: string) => {
    const created = await node.request<{ space: { id: string } }>('POST', '/v2/spaces', { name, clientMutationId: cmid() });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    return created.data!.space.id;
  };
  spaceId = await space('Scheduled tools'); otherSpaceId = await space('Elsewhere');
  owner = await ownerOfSpace(node.database, spaceId);
  peer = await addSpaceMember(node.rpcDb, spaceId, owner.identityId, 'Loop peer');
  await node.database.transaction(async q => {
    await q.query('set local role tm8_graph_owner');
    await q.query("select set_config('tm8.identity_id',$1,true),set_config('tm8.auth_kind','browser',true)", [owner.identityId]);
    for (const [id, name] of [[persona, 'Loop runner'], [otherPersona, 'Bystander']] as const) {
      await q.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'team_member',0,$3)", [id, spaceId, owner.memberId]);
      await q.query("insert into public.team_members(entity_id,owner_member_id,name,role,identity) values($1,$2,$3,'','persona')", [id, owner.memberId, name]);
    }
  });
  loop = await createLoop(spaceId, 'Nightly check', persona);
  otherLoop = await createLoop(spaceId, 'Other loop', persona);
  personaLessLoop = await createLoop(spaceId, 'Dispatcher loop', null);
  farLoop = await createLoop(otherSpaceId, 'Far loop', null);
  const execution = node.production.execution!;
  // The production pieces; baseUrl is the bound port (the harness boots on :0).
  runtime = new ToolRuntime({ db: node.production.db!, pty: execution.pty, spawnService: execution.spawnService,
    dataDir: node.dataDir, baseUrl: node.baseUrl, nodeId: 'scheduled-e2e' });
  const port = createLoopExecutorPort({ db: node.production.db!, pty: execution.pty, spawnService: execution.spawnService,
    resolveOwner: async () => { throw new Error('the due read is not under test'); }, tools: runtime });
  firingClaims = (identityId, loopId) => port.claimsForLoop({ entityId: loopId, spaceId, title: '', schedule: 'every 1d',
    teamMemberId: persona, subjectId: null, prompt: '', config: null, version: 1, actAsIdentity: identityId } satisfies DueLoop, identityId);
});
afterAll(async () => { await node?.close(); });

describe('379: start_tool_session with a loop', () => {
  const opened: Array<[string, DbClaims]> = [];
  async function start(claims: DbClaims, tool: string, loopId: string | null, opts: { version?: number | null; keepOpen?: boolean; cmid?: string } = {}) {
    const result = await door().rpc<{ entity: { id: string }; __tm8_replayed: boolean }>(claims, 'start_tool_session',
      [spaceId, tool, opts.version === undefined ? await versionOf(tool) : opts.version, {}, opts.keepOpen ?? false,
        'scheduled-db', '/tmp', 100, null, opts.cmid ?? cmid(), loopId]);
    opened.push([result.entity.id, claims]);
    return result;
  }
  // Release the member's tool-session slots: these runs never get a PTY.
  afterAll(async () => { for (const [id, claims] of opened) await door().rpc(claims, 'work_session_transition', [id, 'failed', null, 'test cleanup']); });

  it('writes the run and its provenance-marked triggered_by edge in one call, as the firing member, at top level', async () => {
    const tool = await createTool('db-edge', 'read'), firing = firingClaims(owner.identityId, loop);
    expect(firing).toEqual({ identityId: owner.identityId, nodeAdmin: false, requestId: `loop-executor:${loop}` });
    const run = (await start(firing, tool, loop)).entity.id;
    const [row] = await node.database.query<{ created_by: string; parent_id: string | null; tool_keep_open: boolean; tool_version: number }>(
      'select e.created_by,e.parent_id,w.tool_keep_open,w.tool_version from public.entities e join public.work_sessions w on w.entity_id=e.id where e.id=$1', [run]);
    expect(row).toEqual({ created_by: owner.memberId, parent_id: null, tool_keep_open: false, tool_version: await versionOf(tool) });
    expect(await node.database.query("select 1 from public.edges where src_id=$1 and dst_id=$2 and type='executes'", [run, tool])).toHaveLength(1);
    const edge = await provenanceEdge(run, loop);
    expect(edge?.props.provenance).toBe(true);
    expect(edge?.props.firedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(edge?.created_by).toBe(owner.memberId);
  });

  it('refuses a bearer, a link or a work-session claim before writing anything', async () => {
    const tool = await createTool('db-bearer', 'read'), firing = firingClaims(owner.identityId, loop);
    for (const extra of [{ authKind: 'browser' }, { authKind: 'cli' }, { authKind: 'agent' }, { viaLinkId: randomUUID() }, { workSessionId: randomUUID() }]) {
      await expect(start({ ...firing, ...extra }, tool, loop), JSON.stringify(extra)).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(await runCount(tool)).toBe(0);
  });

  it('(3) refuses a null version, keep-open, a loop in another space and a deleted loop', async () => {
    const tool = await createTool('db-shape', 'none'), firing = firingClaims(owner.identityId, loop);
    await expect(start(firing, tool, loop, { version: null })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('pins the tool version') });
    await expect(start(firing, tool, loop, { keepOpen: true })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('never keeps its shell open') });
    await expect(start(firing, tool, farLoop)).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('another space') });
    const doomed = await createLoop(spaceId, 'Deleted loop', persona);
    await node.database.query('update public.entities set deleted_at=now() where id=$1', [doomed]);
    await expect(start(firing, tool, doomed)).rejects.toMatchObject({ code: 'not_found' });
    expect(await runCount(tool)).toBe(0);
  });

  it('(4) replays a retry of one firing, starts a second run for a second firing, and never replays another loop\'s firing', async () => {
    const tool = await createTool('db-replay', 'none'), firing = firingClaims(owner.identityId, loop), key = `tool-fire:${loop}:2026-10-28T19:00:00.000Z`;
    const first = await start(firing, tool, loop, { cmid: key });
    const retry = await start(firing, tool, loop, { cmid: key });
    expect([first.__tm8_replayed, retry.__tm8_replayed, retry.entity.id]).toEqual([false, true, first.entity.id]);
    const second = await start(firing, tool, loop, { cmid: `tool-fire:${loop}:2026-10-28T19:05:00.000Z` });
    expect(second.entity.id).not.toBe(first.entity.id);
    await expect(start(firing, tool, otherLoop, { cmid: key })).rejects.toMatchObject({ code: 'invariant_violation', message: expect.stringContaining('did not fire') });
    expect(await runCount(tool)).toBe(2);
    expect(await node.database.query("select 1 from public.edges where dst_id=$1 and type='triggered_by'", [loop])).not.toHaveLength(0);
  });
});

describe('379: issue_tool_session_loop_session', () => {
  const opened: Array<[string, DbClaims]> = [];
  async function start(claims: DbClaims, tool: string, loopId: string | null) {
    const result = await door().rpc<{ entity: { id: string } }>(claims, 'start_tool_session',
      [spaceId, tool, await versionOf(tool), {}, false, 'scheduled-db', '/tmp', 100, null, cmid(), loopId]);
    opened.push([result.entity.id, claims]);
    return result.entity.id;
  }
  async function mint(claims: DbClaims, run: string, loopId: string, teamMember: string | null, scope = 'write') {
    const hash = tokenHash();
    const row = await door().rpc<{ id: string; kind: string; api_scope: string }>(claims, 'issue_tool_session_loop_session',
      [run, loopId, teamMember, hash, new Date(Date.now() + 3600_000).toISOString(), scope]);
    return { hash, row };
  }
  afterAll(async () => { for (const [id, claims] of opened) await door().rpc(claims, 'work_session_transition', [id, 'failed', null, 'test cleanup']); });

  it('(2)(6) mints a kind-agent token acting as the loop persona, pinned to the run, scope read when the tool reads', async () => {
    const firing = firingClaims(owner.identityId, loop), run = await start(firing, await createTool('mint-read', 'read'), loop);
    const participation = () => node.database.query("select 1 from public.edges where src_id=$1 and dst_id=$2 and type='participates_in'", [persona, run]);
    expect(await participation()).toHaveLength(0); // only a minted token adds the persona
    const { hash } = await mint(firing, run, loop, persona, 'write');
    expect(await tokensOf(run)).toEqual([{ id: expect.any(String), kind: 'agent', api_scope: 'read', acting_as_team_member_id: persona,
      space_id: spaceId, label: `tool-loop:${run}`, parent_session_id: null, revoked_at: null, within_timeout: true }]);
    expect(await resolve(hash)).toMatchObject({ kind: 'agent', actingAsTeamMemberId: persona, workSessionId: run, spaceId,
      apiScope: 'read', identityId: owner.identityId });
    expect(await participation()).toHaveLength(1);
    const writeRun = await start(firing, await createTool('mint-write', 'write'), loop);
    expect((await mint(firing, writeRun, loop, persona, 'read')).row.api_scope).toBe('read');
    const writer = await mint(firing, writeRun, loop, persona, 'write');
    expect(writer.row).toMatchObject({ kind: 'agent', api_scope: 'write' });
    expect((await tokensOf(writeRun)).filter(token => token.revoked_at === null)).toHaveLength(1); // a re-mint revokes the previous bearer
  });

  it('(1) refuses every caller but the loop executor: any bearer kind, a link, a work-session claim', async () => {
    const firing = firingClaims(owner.identityId, loop), run = await start(firing, await createTool('mint-bearer', 'read'), loop);
    for (const extra of [{ authKind: 'browser' }, { authKind: 'cli' }, { authKind: 'agent' }, { authKind: 'agent_runtime' }, { authKind: 'link' },
      { viaLinkId: randomUUID() }, { workSessionId: run }]) {
      await expect(mint({ ...firing, ...extra }, run, loop, persona), JSON.stringify(extra)).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(await tokensOf(run)).toEqual([]);
  });

  it('(1) refuses a run without the marked edge: a plain run, a run-history edge, and a forged marker', async () => {
    const firing = firingClaims(owner.identityId, loop), tool = await createTool('mint-unmarked', 'read');
    const plain = await start(firing, tool, null);
    await expect(mint(firing, plain, loop, persona)).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('provenance edge') });
    const history = await start(firing, tool, null);
    await node.database.query("insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'triggered_by',$4)", [spaceId, history, loop, owner.memberId]);
    await expect(mint(firing, history, loop, persona)).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('provenance edge') });
    // 347: only the spawn writer can set the marker, so nobody can forge the authority.
    await expect(node.database.query("update public.edges set props='{\"provenance\":true}' where src_id=$1 and dst_id=$2 and type='triggered_by'", [history, loop]))
      .rejects.toThrow('recorded by the server');
    // The marked edge of ANOTHER loop is not this loop's authority.
    const elsewhere = await start(firing, tool, otherLoop);
    await expect(mint(firing, elsewhere, loop, persona)).rejects.toMatchObject({ code: 'forbidden' });
    for (const run of [plain, history, elsewhere]) expect(await tokensOf(run)).toEqual([]);
  });

  it('(6) acts only as the loop\'s own runs-as persona, for the firing member\'s own live run', async () => {
    const firing = firingClaims(owner.identityId, loop), run = await start(firing, await createTool('mint-persona', 'write'), loop);
    await expect(mint(firing, run, loop, otherPersona)).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('runs-as persona') });
    await expect(mint(firing, run, loop, null)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(mint(firingClaims(peer.identityId, loop), run, loop, persona)).rejects.toMatchObject({ code: 'forbidden' });
    const personaLess = await start(firing, await createTool('mint-dispatch', 'write'), personaLessLoop);
    await expect(mint(firing, personaLess, personaLessLoop, persona)).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('runs-as persona') });
    await door().rpc(firing, 'record_tool_exit', [run, 0, 'exited', '']);
    await expect(mint(firing, run, loop, persona)).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('live tool session') });
    expect([...await tokensOf(run), ...await tokensOf(personaLess)]).toEqual([]);
  });

  it('(5) a tool without tm8 access mints nothing', async () => {
    const firing = firingClaims(owner.identityId, loop), run = await start(firing, await createTool('mint-none', 'none'), loop);
    await expect(mint(firing, run, loop, persona)).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('no tm8 API access') });
    expect(await tokensOf(run)).toEqual([]);
  });

  it('(2) revokes on tool settlement, on a launch failure\'s PTY end, and on explicit revoke', async () => {
    const firing = firingClaims(owner.identityId, loop), tool = await createTool('mint-revoke', 'read');
    const settledRun = await start(firing, tool, loop);
    await door().rpc(firing, 'work_session_transition', [settledRun, 'running']);
    const settled = await mint(firing, settledRun, loop, persona);
    await door().rpc(firing, 'record_tool_exit', [settledRun, 7, 'exited', '']);
    const failedRun = await start(firing, tool, loop);
    const failed = await mint(firing, failedRun, loop, persona);
    await door().rpc(firing, 'work_session_transition', [failedRun, 'failed', null, 'launch failed']);
    const revokedRun = await start(firing, tool, loop);
    const revoked = await mint(firing, revokedRun, loop, persona);
    await door().rpc(firing, 'revoke_agent_auth_session', [revokedRun]);
    for (const { hash } of [settled, failed, revoked]) expect(await resolve(hash)).toBeNull();
  });
});

describe('runScheduled on the production server with real PTYs', () => {
  type SettledRow = { status: string; tool_state: string; tool_exit_code: number | null; outcome: string; tool_output_tail: string; title: string };
  async function settled(id: string) {
    let row: SettledRow | undefined;
    await vi.waitFor(async () => {
      [row] = await node.database.query<SettledRow>('select status,tool_state,tool_exit_code,outcome,tool_output_tail,title from public.work_sessions where entity_id=$1', [id]);
      expect(row!.tool_state).not.toBe('running');
      expect(['exited', 'failed']).toContain(row!.status);
    }, { timeout: 20000, interval: 50 });
    return row!;
  }
  const fire = (tool: string, extra: Record<string, unknown> = {}, identityId = owner.identityId) => runtime.runScheduled(firingClaims(identityId, loop), {
    toolId: tool, inputs: {}, firingKey: `${loop}:${new Date().toISOString()}:${randomUUID()}`, triggeredByLoopId: loop,
    runAsTeamMemberId: persona, title: 'Nightly check', ...extra });
  let readTool: string, firstFiring: { request: Parameters<ToolRuntime['runScheduled']>[1]; sessionId: string };

  it('fires one run recorded like every run: edges, pins, token kind/scope, revoked at exit, titled by the tool', async () => {
    const source = `python3 -I - <<'PY'\nimport json, os, urllib.request, urllib.error\nbase = os.environ['TM8_BASE_URL']; headers = {'Authorization': 'Bearer ' + os.environ['TM8_AGENT_TOKEN'], 'Content-Type': 'application/json'}\nwith urllib.request.urlopen(urllib.request.Request(base + '/v2/entities/' + os.environ['TM8_SESSION_ID'], headers=headers)) as r: print('read-status:' + str(r.status))\nreq = urllib.request.Request(base + '/v2/entities', data=json.dumps({'spaceId': '${spaceId}', 'kind': 'task', 'title': 'Forbidden write', 'clientMutationId': '${cmid()}'}).encode(), headers=headers)\ntry:\n    urllib.request.urlopen(req)\n    raise RuntimeError('write unexpectedly allowed')\nexcept urllib.error.HTTPError as e:\n    print('write-status:' + str(e.code))\nPY\nprintf 'pwd:%s\\n' "$PWD"`;
    readTool = await createTool('nightly-read', 'read', source);
    const request = { toolId: readTool, inputs: {}, firingKey: `${loop}:2026-10-28T20:00:00.000Z`, triggeredByLoopId: loop,
      runAsTeamMemberId: persona, title: 'Nightly check' };
    const result = await runtime.runScheduled(firingClaims(owner.identityId, loop), request);
    firstFiring = { request, sessionId: result.sessionId };
    expect(result).toEqual({ sessionId: expect.any(String), toolVersion: await versionOf(readTool),
      sourceSha256: createHash('sha256').update(source).digest('hex') });
    const run = await settled(result.sessionId), cwd = await realpath(join(node.dataDir, 'tool-workspaces', owner.identityId, readTool));
    expect(run).toMatchObject({ status: 'exited', tool_state: 'exited', tool_exit_code: 0, outcome: 'completed' });
    expect(run.title).toBe('nightly-read'); // the session title stays the tool's name; the loop title is in the header
    expect(run.tool_output_tail).toContain('── nightly-read v1 · loop: Nightly check · inputs:  ──');
    expect(run.tool_output_tail).toContain(`── cwd: ${cwd} ──`);
    expect(run.tool_output_tail).toContain(`pwd:${cwd}`);
    expect(run.tool_output_tail).toContain('read-status:200'); expect(run.tool_output_tail).toContain('write-status:403');
    const [envelope] = await node.database.query<{ created_by: string; parent_id: string | null }>('select created_by,parent_id from public.entities where id=$1', [result.sessionId]);
    expect(envelope).toEqual({ created_by: owner.memberId, parent_id: null });
    expect(await node.database.query("select 1 from public.edges where src_id=$1 and dst_id=$2 and type='executes'", [result.sessionId, readTool])).toHaveLength(1);
    expect((await provenanceEdge(result.sessionId, loop))?.props.provenance).toBe(true);
    expect(await node.database.query("select 1 from public.edges where src_id=$1 and dst_id=$2 and type='participates_in'", [persona, result.sessionId])).toHaveLength(1);
    const tokens = await tokensOf(result.sessionId);
    expect(tokens).toMatchObject([{ kind: 'agent', api_scope: 'read', acting_as_team_member_id: persona, parent_session_id: null }]);
    expect(tokens[0]!.revoked_at).toBeTruthy();
    expect(node.production.execution!.pty.hasSession(result.sessionId)).toBe(false);
  });

  it('(4) a retry of that firing replays it; the next firing is a new run', async () => {
    const retry = await runtime.runScheduled(firingClaims(owner.identityId, loop), firstFiring.request);
    expect(retry.sessionId).toBe(firstFiring.sessionId);
    expect(await tokensOf(firstFiring.sessionId)).toHaveLength(1); // no remint
    expect(node.production.execution!.pty.hasSession(firstFiring.sessionId)).toBe(false); // no rerun
    const next = await runtime.runScheduled(firingClaims(owner.identityId, loop), { ...firstFiring.request, firingKey: `${loop}:2026-10-28T20:05:00.000Z` });
    expect(next.sessionId).not.toBe(firstFiring.sessionId);
    expect((await settled(next.sessionId)).tool_exit_code).toBe(0);
  });

  it('refuses a tm8 tool with no runs-as persona, and stale inputs naming each, before any row', async () => {
    const before = await runCount(readTool);
    await expect(fire(readTool, { runAsTeamMemberId: undefined })).rejects.toMatchObject({ code: 'invalid_input', message: 'tool nightly-read needs a runs-as persona for tm8 API access' });
    expect(await runCount(readTool)).toBe(before);
    const stale = await createTool('nightly-stale', 'none', 'exit 0', [{ name: 'target', type: 'string', required: true }]);
    await expect(fire(stale, { inputs: { tagret: 'db-1' } })).rejects.toMatchObject({ code: 'invalid_input',
      message: expect.stringContaining('tagret (not declared); target (required)') });
    expect(await runCount(stale)).toBe(0);
  });

  it('uses a bound secret only when the firing account may: the armer\'s private secret is refused to a peer', async () => {
    const secretTool = await createTool('nightly-secret', 'none', 'printf "key:%s\\n" "$API_KEY"', [{ name: 'api_key', type: 'secret', required: true }]);
    const human = { identityId: owner.identityId, nodeAdmin: false, authKind: 'browser', requestId: 'bind' };
    await runtime.createSecret(human, { toolId: secretTool, inputName: 'api_key', value: 'synthetic-scheduled-secret-31d', expectedVersion: await versionOf(secretTool), clientMutationId: cmid() });
    await expect(fire(secretTool, {}, peer.identityId)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await runCount(secretTool)).toBe(0);
    const run = await settled((await fire(secretTool)).sessionId);
    expect(run.tool_output_tail).toContain('key:[credential-redacted]');
    expect(run.tool_output_tail).not.toContain('synthetic-scheduled-secret-31d');
  });

  it('a nonzero exit is the run\'s outcome, not a firing failure', async () => {
    const failing = await createTool('nightly-exit', 'none', 'exit 7');
    const run = await settled((await fire(failing)).sessionId);
    // The PTY status is the process ending ('exited', the launcher's closePty); the work outcome carries the code.
    expect(run).toMatchObject({ status: 'exited', tool_state: 'exited', tool_exit_code: 7, outcome: 'completed' });
  });

  it('(2) a launch failure leaves a killed run with its marked edge and its token revoked', async () => {
    const tool = await createTool('nightly-launch', 'read');
    const spawn = vi.spyOn(node.production.execution!.pty, 'spawnIfAbsent').mockImplementationOnce(() => { throw new Error('Synthetic PTY launch failure'); });
    try {
      await expect(fire(tool)).rejects.toMatchObject({ code: 'upstream_unavailable', message: 'Tool launch failed' });
    } finally { spawn.mockRestore(); }
    const [run] = await node.database.query<{ entity_id: string; status: string; tool_state: string; outcome: string }>(
      'select entity_id,status,tool_state,outcome from public.work_sessions where tool_id=$1', [tool]);
    expect(run).toMatchObject({ status: 'failed', tool_state: 'killed', outcome: 'stopped' });
    expect((await provenanceEdge(run!.entity_id, loop))?.props.provenance).toBe(true);
    expect(await tokensOf(run!.entity_id)).toMatchObject([{ kind: 'agent', revoked_at: expect.anything() }]);
  });

  it('a refused mint leaves a killed run and surfaces the refusal to the executor', async () => {
    const tool = await createTool('nightly-mint', 'write');
    await expect(fire(tool, { runAsTeamMemberId: otherPersona })).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('runs-as persona') });
    const [run] = await node.database.query<{ entity_id: string; status: string; tool_state: string }>(
      'select entity_id,status,tool_state from public.work_sessions where tool_id=$1', [tool]);
    expect(run).toMatchObject({ status: 'failed', tool_state: 'killed' });
    expect(await tokensOf(run!.entity_id)).toEqual([]);
  });

  it('(6) no loop-triggered run, on any path above, holds a human-kind or persona-less token', async () => {
    const [counts] = await node.database.query<{ minted: number; wrong: number }>(
      `select count(*)::int minted, count(*) filter (where s.kind<>'agent' or s.acting_as_team_member_id is null)::int wrong
         from public.auth_sessions s where exists(select 1 from public.edges g where g.src_id=s.work_session_id
           and g.type='triggered_by' and g.props->>'provenance'='true')`);
    expect(counts!.minted).toBeGreaterThan(0);
    expect(counts!.wrong).toBe(0);
  });
});
