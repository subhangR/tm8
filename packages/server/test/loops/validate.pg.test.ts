/**
 * Write-time reference validation for loops (PR3, task 01a182d5-e482; design of
 * record 01a182d4 §2.1/§4.3), over authenticated HTTP against a scratch
 * database with every migration applied — the same harness as PR1's
 * loops-ops.pg.test.ts, plus the tools ops so a loop can name a real tool.
 *
 * What a "returned 400" check would miss, and what is pinned here: the refusal
 * names the field (details.path) and the offending ids; an update is judged on
 * the references it SETS, on the row the write leaves, so a refused update rolls
 * the door's write back and a reference that went stale under the loop never
 * blocks an unrelated edit (loops PR1 review B2), while an action change judges
 * every reference; an untrusted project is refused, since no firing can confirm
 * it (348); tool inputs are judged against the tool's CURRENT definition
 * whenever a write sets them; and 394's gate refuses a loop-triggered run of a
 * tool the loop does not name.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerW2EntitiesCommandsTrackingHandlers } from '../../src/facade/handlers/w2/entities-commands-tracking.js';
import { createFacadeServer, type FacadeServer } from '../../src/http/server.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { registerLoopHandlers } from '../../src/loops/handlers.js';
import { assertLoopDefinitionReferences } from '../../src/loops/validate.js';
import { registerToolHandlers } from '../../src/tools/handlers.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 60000, hookTimeout: 300000 });
let database: W1ScratchDatabase, db: Db, server: FacadeServer, base: string;
const space = randomUUID(), member = randomUUID(), account = randomUUID(), authSession = randomUUID(), persona = randomUUID();
const otherSpace = randomUUID(), otherMember = randomUUID(), otherPersona = randomUUID();
const project = randomUUID(), projectEntity = randomUUID(), profile = randomUUID(), farProfile = randomUUID();
const freshProject = randomUUID(), freshEntity = randomUUID();
let memory: string, doomedMemory: string;
const identityId = 'loops-validate-owner', secret = generateSecret(), token = formatToken(authSession, secret);
const owner = async () => ({ identityId, accountId: account, username: identityId, isNodeAdmin: false, isOwner: false });
/** `claimsForLoop`'s shape (375): the firing member, no bearer. */
const firing: DbClaims = { identityId, nodeAdmin: false, requestId: 'loop-executor:validate' };

beforeAll(async () => {
  database = await createW1ScratchDatabase('loops_validate');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1)', [identityId]);
    await c.query('insert into public.accounts(id,identity_id,username,display_name) values($1,$2,$2,$2)', [account, identityId]);
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'Validate fixture',$2),($3,'Elsewhere',$2)", [space, identityId, otherSpace]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1),($3,$4,'member',0,$3)", [member, space, otherMember, otherSpace]);
    await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,'owner',$3),($4,$5,$3,'owner',$3)", [member, space, identityId, otherMember, otherSpace]);
    await c.query("insert into public.auth_sessions(id,account_id,kind,space_id,token_hash,expires_at) values($1,$2,'cli',$3,$4,now()+interval '1 hour')", [authSession, account, space, hashToken(secret)]);
    await c.query("select set_config('tm8.identity_id',$1,true),set_config('tm8.auth_kind','browser',true)", [identityId]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'team_member',0,$3),($4,$5,'team_member',0,$6)", [persona, space, member, otherPersona, otherSpace, otherMember]);
    await c.query("insert into public.team_members(entity_id,owner_member_id,name,role,identity) values($1,$2,'Runner','','persona'),($3,$4,'Stranger','','persona')", [persona, member, otherPersona, otherMember]);
    // Two project projections in the space (021's shape): one marked trusted, and one left at the
    // default trust ('untrusted', 001), which no loop can launch in. And an interaction profile in each space.
    await c.query("insert into public.projects(id,name,working_dir,trust) values($1,'Lane project','/srv/lane','trusted'),($2,'Fresh clone','/srv/fresh',default)", [project, freshProject]);
    await c.query("select internal.w1_set_writer('project_materializer')");
    await c.query("insert into public.entities(id,space_id,kind,parent_id,position,visibility,created_by) values($1,$2,'project',null,null,'restricted',$3),($4,$2,'project',null,null,'restricted',$3)", [projectEntity, space, member, freshEntity]);
    await c.query("insert into public.project_projection_details(entity_id,project_id,materialized_version,name,repo_url) values($1,$2,1,'Lane project',null),($3,$4,1,'Fresh clone',null)", [projectEntity, project, freshEntity, freshProject]);
    await c.query('insert into public.project_links(space_id,project_id,project_entity_id) values($1,$2,$3),($1,$4,$5)', [space, project, projectEntity, freshProject, freshEntity]);
    await c.query('insert into public.space_projects(space_id,project_id,linked_by) values($1,$2,$3),($1,$4,$3)', [space, project, member, freshProject]);
    await c.query('select internal.w1_set_writer(null)');
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'interaction_profile',0,$3),($4,$5,'interaction_profile',0,$6)", [profile, space, member, farProfile, otherSpace, otherMember]);
    await c.query('insert into public.interaction_profiles(entity_id) values($1),($2)', [profile, farProfile]);
  });
  const human: DbClaims = { identityId, nodeAdmin: false, authKind: 'cli', requestId: 'seed' };
  memory = (await db.rpc<{ entity: { id: string } }>(human, 'create_memory',
    [space, 'The lane runs on the prod node', 'measured', 'this node', 'other nodes', null, null, null, null, randomUUID()])).entity.id;
  doomedMemory = (await db.rpc<{ entity: { id: string } }>(human, 'create_memory',
    [space, 'The lane keeps its scratch on /srv', 'measured', 'this node', 'other nodes', null, null, null, null, randomUUID()])).entity.id;
  const config = { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 * 1024, databaseUrl: database.url, disableAutoOwner: true };
  const registry = new HandlerRegistry();
  const deps = { db, config, owner };
  registerLoopHandlers(registry, deps);
  registerToolHandlers(registry, deps);
  registerW2EntitiesCommandsTrackingHandlers(registry, deps);
  server = createFacadeServer({ config, registry, identityResolver: createSessionIdentityResolver({ db, owner }) });
  base = (await server.listen()).url;
});
afterAll(async () => {
  await server?.close();
  await db?.end();
  await database?.destroy();
});

async function request(method: string, path: string, body?: Record<string, unknown>) {
  const payload = body === undefined ? undefined : { clientMutationId: randomUUID(), ...body };
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, json: await response.json() };
}
const ok = (result: { status: number; json: any }) => {
  expect([200, 201], JSON.stringify(result.json)).toContain(result.status);
  return result.json.data;
};
const refused = (result: { status: number; json: any }, path: string) => {
  expect(result.status, JSON.stringify(result.json)).toBe(400);
  expect(result.json.error.code).toBe('invalid_input');
  expect(result.json.error.details?.path, JSON.stringify(result.json.error)).toBe(path);
  expect(result.json.error.message).toMatch(new RegExp(`^${path.replace(/\./g, '\\.')}:`));
  return result.json.error;
};
const create = (definition: Record<string, unknown>) => request('POST', `/v2/spaces/${space}/loops`, { definition });
const patch = (id: string, expectedVersion: number, definition: Record<string, unknown>) =>
  request('PATCH', `/v2/loops/${id}`, { expectedVersion, definition });
const toolDefinition = (name: string, inputs: unknown[], tm8Access = 'none') =>
  ({ name, description: '', help: '', runtime: 'bash', source: 'exit 0', inputs, tm8Access, timeoutSeconds: 30 });
async function createTool(name: string, inputs: unknown[], tm8Access = 'none'): Promise<{ id: string; version: number }> {
  const view = ok(await request('POST', `/v2/spaces/${space}/tools`, { definition: toolDefinition(name, inputs, tm8Access) }));
  return { id: view.id, version: view.version };
}
const stored = async (id: string) => (await database.query<{ prompt: string; version: number; tool_inputs: Record<string, unknown>; config: Record<string, unknown> }>(
  'select l.prompt, e.version, l.tool_inputs, l.config from public.loops l join public.entities e on e.id = l.entity_id where l.entity_id = $1', [id]))[0];

describe('tool inputs are judged against the CURRENT tool definition', () => {
  it('a tool loop whose inputs fit is created; one with a stale and a missing input is refused naming both', async () => {
    const tool = await createTool('probe', [{ name: 'target', type: 'string', required: true }, { name: 'limit', type: 'int', min: 1, max: 10 }]);
    const view = ok(await create({ title: 'Probe nightly', schedule: 'every 1d', action: 'tool', toolId: tool.id, toolInputs: { target: 'db-1', limit: 5 } }));
    expect(view.definition).toMatchObject({ action: 'tool', toolId: tool.id, toolInputs: { target: 'db-1', limit: 5 } });

    const error = refused(await create({ title: 'Probe typo', schedule: 'every 1d', action: 'tool', toolId: tool.id, toolInputs: { tagret: 'db-1', limit: 50 } }),
      'definition.toolInputs');
    expect(error.message).toContain('tagret (not declared)');
    expect(error.message).toContain('limit (invalid int)');
    expect(error.message).toContain('target (required)');
    // jsonb orders keys by length then name, so the stored row's order is what the message follows.
    expect([...error.details.problems].sort()).toEqual(['limit (invalid int)', 'tagret (not declared)', 'target (required)']);
    // Judged on the row the write leaves, inside the door's transaction: the refusal rolled the create back.
    expect(await database.query("select 1 from public.loops where title = 'Probe typo'")).toHaveLength(0);
  });

  it('an edit to the tool is judged when the loop\'s tool inputs are next written, never on an unrelated edit (review B2); a refused update rolls the door\'s write back', async () => {
    const tool = await createTool('probe-evolving', [{ name: 'target', type: 'string', required: true }]);
    const view = ok(await create({ title: 'Evolving', schedule: 'every 1d', action: 'tool', toolId: tool.id, toolInputs: { target: 'db-1' }, prompt: 'v1' }));
    // The tool now requires a region as well; the loop's stored inputs no longer fit.
    ok(await request('PATCH', `/v2/tools/${tool.id}`, { expectedVersion: tool.version,
      definition: toolDefinition('probe-evolving', [{ name: 'target', type: 'string', required: true }, { name: 'region', type: 'enum', options: ['eu', 'us'], required: true }]) }));

    // A prompt edit sets no tool reference, so the stale inputs do not block it (loops PR1 review B2):
    // the firing reports them, as the run's error and the loop's last_error.
    const edited = ok(await patch(view.id, view.version, { prompt: 'v2' }));
    expect((await stored(view.id))!.prompt).toBe('v2');

    // Writing the inputs is judged against the CURRENT definition, and a refusal rolls the write back.
    const error = refused(await patch(view.id, edited.version, { prompt: 'v3', toolInputs: { target: 'db-2' } }), 'definition.toolInputs');
    expect(error.message).toContain('region (required)');
    expect(await stored(view.id)).toMatchObject({ prompt: 'v2', version: edited.version, tool_inputs: { target: 'db-1' } });

    // Supplying the input passes; the stored row moves on.
    const fixed = ok(await patch(view.id, edited.version, { prompt: 'v3', toolInputs: { target: 'db-1', region: 'eu' } }));
    expect(fixed.definition.toolInputs).toEqual({ target: 'db-1', region: 'eu' });
    expect((await stored(view.id))!.prompt).toBe('v3');
  });

  it('a secret slot is never a stored input: a value there is refused, a bound secret is used by leaving it out', async () => {
    const tool = await createTool('probe-secret', [{ name: 'api_key', type: 'secret', required: true }]);
    // Unbound and required: the firing could not resolve it, so the write says so now.
    expect(refused(await create({ title: 'Secret unbound', schedule: 'every 1d', action: 'tool', toolId: tool.id, toolInputs: {} }), 'definition.toolInputs').message)
      .toContain('api_key (required secret is not bound)');
    expect(refused(await create({ title: 'Secret literal', schedule: 'every 1d', action: 'tool', toolId: tool.id, toolInputs: { api_key: 'hunter2' } }), 'definition.toolInputs').message)
      .toContain('api_key (secret values are never stored; bind the secret to the tool)');
  });
});

describe('config references must be live entities of the right kind in the space', () => {
  const spawn = (extra: Record<string, unknown>) => create({ title: `Spawn ${randomUUID().slice(0, 8)}`, schedule: 'every 1d', action: 'spawn', teamMemberId: persona, ...extra });

  it('projectId: the space\'s project passes by entity id or folder id (resolve_project_ref, as a spawn does); a tool, a random id and a non-uuid are refused by path', async () => {
    const tool = await createTool('probe-not-a-project', []);
    const view = ok(await spawn({ config: { projectId: projectEntity, model: 'claude-opus-5-5' } }));
    expect(view.definition.config).toEqual({ projectId: projectEntity, model: 'claude-opus-5-5' });
    ok(await spawn({ config: { projectId: project } }));
    expect(refused(await spawn({ config: { projectId: tool.id } }), 'definition.config.projectId').details.ids).toEqual([tool.id]);
    const missing = randomUUID();
    refused(await spawn({ config: { projectId: missing } }), 'definition.config.projectId');
    refused(await spawn({ config: { projectId: 'not-an-id' } }), 'definition.config.projectId');
  });

  it('projectId: an untrusted project is refused on create and update, saying what to do; a loop cannot give the per-spawn confirmation it needs (348, S12)', async () => {
    for (const ref of [freshEntity, freshProject]) {
      const error = refused(await spawn({ config: { projectId: ref } }), 'definition.config.projectId');
      expect(error.message).toContain('mark the project trusted, or run the loop without a project');
      expect(error.details).toMatchObject({ ids: [ref], trust: 'untrusted' });
    }
    // Setting it on an existing loop is refused too, and the refusal rolls the door's write back.
    const view = ok(await spawn({ config: { projectId: projectEntity } }));
    refused(await patch(view.id, view.version, { config: { projectId: freshEntity } }), 'definition.config.projectId');
    expect(await stored(view.id)).toMatchObject({ version: view.version, config: { projectId: projectEntity } });
    // Marking the project trusted is the way through.
    const trust = (level: string) => database.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query('update public.projects set trust = $2 where id = $1', [freshProject, level]);
    });
    await trust('trusted');
    try {
      ok(await patch(view.id, view.version, { config: { projectId: freshEntity } }));
    } finally {
      await trust('untrusted');
    }
  });

  it('a memory deleted under a spawn loop blocks a rename through neither door; an action change judges every reference, through both (review of a648dea0b)', async () => {
    const view = ok(await spawn({ config: { memoryIds: [doomedMemory] } }));
    await database.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query('update public.entities set deleted_at = now() where id = $1', [doomedMemory]);
    });
    // A rename sets no reference, so the stale memory blocks it at neither door (loops PR1 review B2).
    ok(await patch(view.id, view.version, { title: 'Stale memory, renamed' }));
    const renamed = (await stored(view.id))!.version;
    ok(await request('PATCH', `/v2/entities/${view.id}`, { expectedVersion: renamed, title: 'Stale memory, renamed again' }));
    const version = (await stored(view.id))!.version;
    expect(version).toBeGreaterThan(renamed);
    // An action change judges every reference, since what the loop launches then reads them all.
    const viaLoops = refused(await patch(view.id, version, { action: 'dispatch', teamMemberId: null }), 'definition.config.memoryIds');
    expect(viaLoops.details.ids).toEqual([doomedMemory]);
    const viaEntities = await request('PATCH', `/v2/entities/${view.id}`, { expectedVersion: version, content: { action: 'dispatch', teamMemberId: null } });
    expect(viaEntities.status, JSON.stringify(viaEntities.json)).toBe(400);
    expect(viaEntities.json.error.details).toMatchObject({ path: 'definition.config.memoryIds', ids: [doomedMemory] });
    expect(await stored(view.id)).toMatchObject({ version, config: { memoryIds: [doomedMemory] } });
  });

  it('memoryIds: live memories pass; the refusal lists exactly the ids that are not', async () => {
    ok(await spawn({ config: { memoryIds: [memory] } }));
    const missing = randomUUID();
    const error = refused(await spawn({ config: { memoryIds: [memory, missing, persona] } }), 'definition.config.memoryIds');
    expect(error.details.ids).toEqual([missing, persona]);
    expect(error.message).toContain(missing);
  });

  it('interactionProfileId: a profile in this space passes; another space\'s is as missing as a random id', async () => {
    ok(await spawn({ config: { interactionProfileId: profile } }));
    expect(refused(await spawn({ config: { interactionProfileId: farProfile } }), 'definition.config.interactionProfileId').details.ids).toEqual([farProfile]);
  });

  it('an unknown config key is refused at the body boundary (PR1) and, as a backstop, on a stored row', async () => {
    const result = await spawn({ config: { shell: 'rm -rf' } });
    expect(result.status).toBe(400);
    expect(result.json.error.code).toBe('invalid_input');
    // The stored-row backstop, for a writer that reached the door another way.
    const q = {
      query: <R>(sql: string, params?: readonly unknown[]) => db.query<R>(firing, sql, params),
      rpc: <T>(fn: string, args?: readonly unknown[]) => db.rpc<T>(firing, fn, args),
    };
    await expect(assertLoopDefinitionReferences(q, space, { action: 'spawn', teamMemberId: persona, toolId: null, toolInputs: {}, config: { shell: 'rm -rf' } }))
      .rejects.toMatchObject({ code: 'invalid_input', details: { path: 'definition.config' } });
    // And a teammate from another space (the door refuses it first; this is the TS backstop's own answer).
    await expect(assertLoopDefinitionReferences(q, space, { action: 'spawn', teamMemberId: otherPersona, toolId: null, toolInputs: {}, config: {} }))
      .rejects.toMatchObject({ code: 'invalid_input', details: { path: 'definition.teamMemberId', ids: [otherPersona] } });
  });

  it('the entities.* loop arm goes through the same validator', async () => {
    const missing = randomUUID();
    const result = await request('POST', '/v2/entities', { spaceId: space, kind: 'loop', title: 'Old UI loop',
      content: { schedule: 'every 1d', teamMemberId: persona, config: { memoryIds: [missing] } } });
    expect(result.status, JSON.stringify(result.json)).toBe(400);
    expect(result.json.error.details.path).toBe('definition.config.memoryIds');
    expect(await database.query("select 1 from public.loops where title = 'Old UI loop'")).toHaveLength(0);
    const created = ok(await request('POST', '/v2/entities', { spaceId: space, kind: 'loop', title: 'Old UI loop ok',
      content: { schedule: 'every 1d', teamMemberId: persona, config: { memoryIds: [memory] } } }));
    const id = created.entity.id as string;
    const bad = await request('PATCH', `/v2/entities/${id}`, { expectedVersion: 1, content: { config: { projectId: missing } } });
    expect(bad.status, JSON.stringify(bad.json)).toBe(400);
    expect(bad.json.error.details.path).toBe('definition.config.projectId');
    const untrusted = await request('PATCH', `/v2/entities/${id}`, { expectedVersion: 1, content: { config: { projectId: freshEntity } } });
    expect(untrusted.status, JSON.stringify(untrusted.json)).toBe(400);
    expect(untrusted.json.error.details).toMatchObject({ path: 'definition.config.projectId', trust: 'untrusted' });
    expect((await stored(id))!.config).toEqual({ memoryIds: [memory] });
  });
});

describe('394: a loop-triggered run executes the loop\'s own tool', () => {
  const opened: string[] = [];
  afterAll(async () => { for (const id of opened) await db.rpc(firing, 'work_session_transition', [id, 'failed', null, 'test cleanup']); });

  it('start_tool_session refuses a tool the loop does not name, and writes the marked edge for the one it does', async () => {
    const named = await createTool('gate-named', []);
    const other = await createTool('gate-other', []);
    const loop = ok(await create({ title: 'Gated', schedule: 'every 1d', action: 'tool', toolId: named.id, toolInputs: {} }));
    const start = (toolId: string, version: number) => db.rpc<{ entity: { id: string } }>(firing, 'start_tool_session',
      [space, toolId, version, {}, false, 'validate-pg', '/tmp', 100, null, `tool-fire:${loop.id}:${randomUUID()}`, loop.id]);

    await expect(start(other.id, other.version)).rejects.toMatchObject({ code: 'invariant_violation', message: expect.stringContaining('loop tool_id does not name this tool') });
    expect(await database.query('select 1 from public.work_sessions where tool_id = $1', [other.id])).toHaveLength(0);

    const run = (await start(named.id, named.version)).entity.id;
    opened.push(run);
    const edges = await database.query<{ props: { provenance?: boolean } }>(
      "select props from public.edges where src_id = $1 and dst_id = $2 and type = 'triggered_by'", [run, loop.id]);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.props.provenance).toBe(true);
  });
});
