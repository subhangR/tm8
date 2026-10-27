/**
 * Migration 345 against a real Postgres: connector REQUESTS from members, and
 * changing a live chat's connectors.
 *
 * Both doors relax a rule that has been admin-only since 296, so the refusals
 * are the point of this file. Every negative is asserted BY SQLSTATE, because
 * the message is prose and the code is the contract: 42501 is "not you", 22023
 * is "not that shape", 53400 is "not that many".
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { MCP_CATALOG, type ChatMcpSelectionsResult, type McpCatalogListResult, type McpServerView, type McpSessionProvenance } from '@tm8/contract';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db } from '../../src/db/types.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerMcpDefinitionHandlers } from '../../src/mcp/definitions.js';
import { registerChatHandlers } from '../../src/chat/handlers.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { RequestContext } from '../../src/http/types.js';
vi.setConfig({ testTimeout: 60000, hookTimeout: 300000 });

let database: W1ScratchDatabase;
let db: Db;
let registry: HandlerRegistry;
const space = randomUUID();
const adminMember = randomUUID();
const plainMember = randomUUID();
const outsideMember = randomUUID();
const otherSpace = randomUUID();
const approvedServer = randomUUID();
const otherSpaceServer = randomUUID();
const chat = randomUUID();
const teammate = randomUUID();
const ADMIN = 'mcp-req-admin';
const MEMBER = 'mcp-req-member';
const OUTSIDE = 'mcp-req-outside';

/**
 * A CUSTOM request body, shaped exactly as `mcp.servers.request` sends one. It
 * carries no `catalogId`, `serverKey` or `provenance` — a custom request claims
 * no identity (B23), and the fixtures below assert each of those refusals.
 */
const request = (name: string, over: Record<string, unknown> = {}) => JSON.stringify({
  name, transport: 'http', url: 'https://docs.example.test/mcp', envKeys: [], headerKeys: [],
  auth: { type: 'oauth2' }, approved: false, enabled: true, ...over,
});
/**
 * A CATALOG request body: the definition the SERVER supplies from MCP_CATALOG,
 * which is the only shape that may carry a catalogId. Its URL has to be that
 * entry's own, which is exactly what the identity rule pins.
 */
const catalogRequest = (over: Record<string, unknown> = {}) => JSON.stringify({
  name: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp', envKeys: [], headerKeys: [],
  auth: { type: 'oauth2' }, approved: false, enabled: true, catalogId: 'notion',
  provenance: 'Notion remote MCP server (official). OAuth with dynamic client registration.', ...over,
});

/**
 * Run SQL under one identity's claims, exactly as the facade sets them per
 * request. `claims` adds the extra ones a link or agent session carries.
 */
async function q<R extends Record<string, unknown>>(
  identity: string, sql: string, params: readonly unknown[] = [], claims: ReadonlyArray<[string, string]> = [],
): Promise<R[]> {
  return database.transaction(async (c) => {
    await c.query("select set_config('tm8.identity_id',$1,true),set_config('tm8.auth_kind','browser',true)", [identity]);
    for (const [name, value] of claims) await c.query('select set_config($1,$2,true)', [name, value]);
    return (await c.query<R>(sql, [...params])).rows;
  });
}

/** One request, returning the new connector's id. */
async function requestConnector(identity: string, actor: string, definition: string, note: string | null = null): Promise<string> {
  const [row] = await q<{ result: { entity: { id: string } } }>(identity,
    'select public.request_mcp_server_entity($1,$2::jsonb,$3,$4,$5) as result',
    [space, definition, note, actor, `req-${randomUUID()}`]);
  return row!.result.entity.id;
}

/** The SQLSTATE of whatever a statement raises, so refusals are asserted by code. */
async function refusal(
  identity: string, sql: string, params: readonly unknown[], claims: ReadonlyArray<[string, string]> = [],
): Promise<string> {
  try {
    await q(identity, sql, params, claims);
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code';
  }
  return 'no-error';
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('mcp_requests_345');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  registry = new HandlerRegistry();
  const facade = {
    db, config: {},
    // The loopback owner the facade falls back to; `claimsFor` prefers the
    // request's own bearer identity, which is what each call names below.
    owner: async () => ({ identityId: ADMIN, memberId: adminMember, spaceId: space }),
  } as unknown as FacadeDeps;
  registerMcpDefinitionHandlers(registry, facade);
  // §10.4's READ door lives with the rest of the chat family, and the chat
  // RUNTIME is deliberately absent: `chat.getMcpSelections` reads a row and
  // must work on a node whose runtime is asleep, exactly like its sibling write.
  registerChatHandlers(registry, facade);
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    for (const identity of [ADMIN, MEMBER, OUTSIDE]) {
      await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1)', [identity]);
      await c.query('insert into public.accounts(identity_id,username,display_name,is_node_admin,is_owner) values($1,$1,$1,false,false)', [identity]);
    }
    for (const [id, name, creator] of [[space, 'Requests fixture', ADMIN], [otherSpace, 'Other space', ADMIN]] as const) {
      await c.query('insert into public.spaces(id,name,created_by_identity) values($1,$2,$3)', [id, name, creator]);
    }
    for (const [id, identity, role, inSpace] of [
      [adminMember, ADMIN, 'owner', space], [plainMember, MEMBER, 'member', space], [outsideMember, ADMIN, 'owner', otherSpace],
    ] as const) {
      await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1)", [id, inSpace]);
      await c.query('insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,$4,$3)', [id, inSpace, identity, role]);
    }
    // The connector guards read the caller's claims even under the graph owner
    // role, so the fixture binds an admin identity before writing definitions.
    await c.query("select set_config('tm8.identity_id',$1,true),set_config('tm8.auth_kind','browser',true)", [ADMIN]);
    // An approved connector in each Space, for the selection tests.
    for (const [id, inSpace, name, owner] of [
      [approvedServer, space, 'reqfixture', adminMember], [otherSpaceServer, otherSpace, 'elsewhere', outsideMember],
    ] as const) {
      await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'mcp_server',0,$3)", [id, inSpace, owner]);
      await c.query('insert into public.mcp_servers(entity_id,space_id,title,definition) values($1,$2,$3,$4)', [id, inSpace, name, JSON.stringify({
        name, transport: 'http', url: 'https://example.test/mcp', envKeys: [], headerKeys: ['Authorization'],
        auth: { type: 'api_key', headerName: 'Authorization' }, approved: true,
      })]);
    }
    // A chat the PLAIN member configures, which is what makes it theirs to change.
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'team_member',0,$1)", [teammate, space]);
    await c.query("insert into public.team_members(entity_id,owner_member_id,name,role,identity) values($1,$2,'Fixture teammate','worker','persona')", [teammate, plainMember]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'chat',0,$3)", [chat, space, plainMember]);
    await c.query(`insert into public.chats(
      entity_id,space_id,title,teammate_id,model,provider,agent_tool,chat_mode,workdir_mode,cwd,native_session_id,
      configured_by_identity_id,configured_by_member_id,client_mutation_id)
      values($1,$2,'Selection fixture',$3,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/tm8-345',gen_random_uuid(),$4,$5,$6)`,
      [chat, space, teammate, MEMBER, plainMember, `chat-345-${randomUUID()}`]);
  });
});

afterAll(async () => { await db?.end(); await database?.destroy(); });

/**
 * One facade request, as the HTTP layer composes it: the identity on the
 * bearer, the Space on the path, the rest on the query or the body.
 */
function ctx(identity: string, over: Partial<RequestContext> = {}): RequestContext {
  return {
    params: {}, query: new URLSearchParams(), body: {}, requestId: randomUUID(), headers: {},
    identity: { identityId: identity, authKind: 'browser' }, ...over,
  } as unknown as RequestContext;
}
const call = async <T>(op: string, identity: string, over: Partial<RequestContext> = {}): Promise<T> =>
  (await registry.get(op as never)!(ctx(identity, over))) as T;

it('serves the catalog statically, and per Space says where each entry is already added', async () => {
  // No Space named: the bare node-level list, with no `added` anywhere.
  const bare = await call<McpCatalogListResult>('mcp.catalog.list', MEMBER);
  expect(bare.items.map((entry) => entry.id)).toEqual(MCP_CATALOG.map((entry) => entry.id));
  expect(bare.items.some((entry) => entry.added !== undefined)).toBe(false);

  // An approved Notion connector and an unapproved (requested) Slack one.
  const notion = await call<McpServerView>('mcp.servers.request', MEMBER, {
    params: { spaceId: space }, body: { catalogId: 'notion', clientMutationId: `req-${randomUUID()}` },
  });
  expect(notion.definition.catalogId).toBe('notion');
  // The definition came from the CATALOG, not from the request body.
  expect(notion.definition.url).toBe('https://mcp.notion.com/mcp');
  expect(notion.definition.approved).toBe(false);
  await q(ADMIN, 'select public.update_mcp_server_entity($1,$2,$3::jsonb,$4,$5)', [
    notion.id, notion.version, JSON.stringify({ ...notion.definition, approved: true }), adminMember, `up-${randomUUID()}`,
  ]);
  const slack = await call<McpServerView>('mcp.servers.request', MEMBER, {
    params: { spaceId: space }, body: { catalogId: 'slack', clientMutationId: `req-${randomUUID()}` },
  });

  const scoped = await call<McpCatalogListResult>('mcp.catalog.list', MEMBER, {
    query: new URLSearchParams({ spaceId: space }),
  });
  const added = (id: string) => scoped.items.find((entry) => entry.id === id)?.added;
  // "Added" and "Requested" are the same join, told apart by `approved` (B16).
  expect(added('notion')).toEqual([{ serverId: notion.id, approved: true }]);
  expect(added('slack')).toEqual([{ serverId: slack.id, approved: false }]);
  expect(added('figma')).toBeUndefined();

  // Withdrawn, so the fixture below starts clean and the join forgets it.
  await q(ADMIN, 'select public.delete_entity($1,$2,$3)', [slack.id, adminMember, `del-${randomUUID()}`]);
  const afterward = await call<McpCatalogListResult>('mcp.catalog.list', MEMBER, {
    query: new URLSearchParams({ spaceId: space }),
  });
  expect(afterward.items.find((entry) => entry.id === 'slack')?.added).toBeUndefined();
  // And the approved Notion one goes too, so the tests below start from a Space
  // with no live `notion` holding that name and server key.
  await q(ADMIN, 'select public.delete_entity($1,$2,$3)', [notion.id, adminMember, `del-${randomUUID()}`]);
});

it('refuses a request for an unknown catalog entry', async () => {
  const body = (catalogId: string) => ({ catalogId, clientMutationId: `req-${randomUUID()}` });
  await expect(call('mcp.servers.request', MEMBER, { params: { spaceId: space }, body: body('nosuchthing') }))
    .rejects.toMatchObject({ code: 'not_found' });
  // Exactly one of catalogId or definition.
  await expect(call('mcp.servers.request', MEMBER, {
    params: { spaceId: space }, body: { clientMutationId: `req-${randomUUID()}` },
  })).rejects.toBeTruthy();
});

it('admits a member request, keeps it inert, and refuses every administrator-only shape', async () => {
  const id = await requestConnector(MEMBER, plainMember, request('wantnotion'), 'we use Notion for specs');
  expect(id).toMatch(/^[0-9a-f-]{36}$/);

  // Inert and attributed: unapproved, and the requester is on the envelope, so
  // the Yours tab can show "connectors you requested" without a second table.
  const [row] = await q<{ approved: string; created_by: string }>(MEMBER,
    `select m.definition->>'approved' as approved, e.created_by::text as created_by
       from public.mcp_servers m join public.entities e on e.id=m.entity_id where m.entity_id=$1`, [id]);
  expect(row).toMatchObject({ approved: 'false', created_by: plainMember });

  // An attention request on the connector itself is the admins' lever.
  const attention = await q<{ action_type: string; status: string }>(MEMBER,
    'select action_type, status from public.attention_requests where entity_id=$1', [id]);
  expect(attention).toHaveLength(1);
  expect(attention[0]).toMatchObject({ action_type: 'approve', status: 'open' });

  // Every refused shape, by SQLSTATE. 22023 is the request-shape guard.
  const cases: Array<[string, Record<string, unknown>]> = [
    ['approved', { approved: true }],
    ['stdio', { transport: 'stdio', command: '/bin/echo', url: undefined }],
    ['plain http url', { url: 'http://example.test/mcp' }],
    ['client secret env', { auth: { type: 'oauth2', clientId: 'x', clientSecretEnv: 'TM8_MCP_CLIENT_SECRET_SLACK' } }],
    ['stdioTrusted', { stdioTrusted: true }],
    ['allowPrivateNetwork', { allowPrivateNetwork: true }],
    ['defaultOn', { defaultOn: true }],
    ['allowExternalClients', { allowExternalClients: true }],
    ['firstParty', { firstParty: true }],
    ['gates', { gates: { send: false } }],
  ];
  for (const [label, over] of cases) {
    const shape = JSON.parse(request(`refused${label.replace(/[^a-z]/g, '')}`)) as Record<string, unknown>;
    for (const [key, value] of Object.entries(over)) {
      if (value === undefined) delete shape[key]; else shape[key] = value;
    }
    expect(await refusal(MEMBER, 'select public.request_mcp_server_entity($1,$2::jsonb,null,$3,$4)',
      [space, JSON.stringify(shape), plainMember, `req-${randomUUID()}`]), label).toBe('22023');
  }
});

it('refuses a non-member, a link session and an agent session, and caps open requests', async () => {
  // Not a member of this Space: 42501, before anything is written.
  expect(await refusal(OUTSIDE, 'select public.request_mcp_server_entity($1,$2::jsonb,null,null,$3)',
    [space, request('fromoutside'), `req-${randomUUID()}`])).toBe('42501');
  // A link session is a human, but not THIS Space's human (§6.5, B11).
  expect(await refusal(MEMBER, 'select public.request_mcp_server_entity($1,$2::jsonb,null,$3,$4)',
    [space, request('fromlink'), plainMember, `req-${randomUUID()}`],
    [['tm8.via_link', randomUUID()]])).toBe('42501');
  // An agent session never requests a connector: the human gate refuses it.
  expect(await refusal(MEMBER, 'select public.request_mcp_server_entity($1,$2::jsonb,null,$3,$4)',
    [space, request('fromagent'), plainMember, `req-${randomUUID()}`],
    [['tm8.auth_kind', 'agent']])).toBe('42501');

  // The per-member cap. One request already exists from the test above.
  for (let i = 1; i < 10; i += 1) {
    await requestConnector(MEMBER, plainMember, request(`capfill${i}`));
  }
  expect(await refusal(MEMBER, 'select public.request_mcp_server_entity($1,$2::jsonb,null,$3,$4)',
    [space, request('overcap'), plainMember, `req-${randomUUID()}`])).toBe('53400');

  // Withdrawing frees a slot, which is what makes the cap a queue depth rather
  // than a lifetime quota. It also leaves the fixture usable for the tests
  // below, which would otherwise all hit the cap.
  const open = await q<{ id: string }>(MEMBER,
    `select e.id from public.mcp_servers m join public.entities e on e.id=m.entity_id
      where m.space_id=$1 and e.deleted_at is null and (m.definition->>'approved')='false' and e.created_by=$2`,
    [space, plainMember]);
  expect(open.length).toBe(10);
  for (const row of open) {
    await q(MEMBER, 'select public.delete_entity($1,$2,$3)', [row.id, plainMember, `del-${randomUUID()}`]);
  }
  expect(await requestConnector(MEMBER, plainMember, request('afterwithdrawals'))).toMatch(/^[0-9a-f-]{36}$/);
});

it('lets the requester withdraw their own unapproved request, and nobody else', async () => {
  const id = await requestConnector(MEMBER, plainMember, request('withdrawme'));
  // Another Space's admin cannot: the connector is not theirs to touch.
  expect(await refusal(OUTSIDE, 'select public.delete_entity($1,null,$2)', [id, `del-${randomUUID()}`])).toBe('42501');
  // The requester can, through the ordinary entity door.
  await q(MEMBER, 'select public.delete_entity($1,$2,$3)', [id, plainMember, `del-${randomUUID()}`]);
  const [gone] = await q<{ deleted: boolean }>(ADMIN,
    'select deleted_at is not null as deleted from public.entities where id=$1', [id]);
  expect(gone!.deleted).toBe(true);
});

it('keeps connector creation and editing administrator-only', async () => {
  // The relaxation is for the REQUEST shape only: a member still cannot create
  // an approved connector, and still cannot edit one at all.
  expect(await refusal(MEMBER, 'select public.create_mcp_server_entity($1,$2::jsonb,$3,$4)',
    [space, request('memberdirect', { approved: true }), plainMember, `cr-${randomUUID()}`])).toBe('42501');
  const [row] = await q<{ version: number }>(MEMBER, 'select version from public.entities where id=$1', [approvedServer]);
  expect(await refusal(MEMBER, 'select public.update_mcp_server_entity($1,$2,$3::jsonb,$4,$5)',
    [approvedServer, row!.version, request('reqfixture'), plainMember, `up-${randomUUID()}`])).toBe('42501');
});

it('upserts a chat selection, clears it with NULL, and validates structure at the write', async () => {
  const pick = JSON.stringify([{ serverId: approvedServer }]);
  const [first] = await q<{ result: { chatId: string; mcpSelections: unknown } }>(MEMBER,
    'select public.update_chat_mcp_selections($1,$2::jsonb) as result', [chat, pick]);
  expect(first!.result).toEqual({ chatId: chat, mcpSelections: [{ serverId: approvedServer }] });
  const [before] = await q<{ updated_at: Date }>(MEMBER,
    'select updated_at from internal.mcp_launch_selections where session_id=$1', [chat]);

  // THE WHOLE POINT versus 298's `on conflict do nothing`: a second write wins.
  const [second] = await q<{ result: { mcpSelections: unknown } }>(MEMBER,
    'select public.update_chat_mcp_selections($1,$2::jsonb) as result', [chat, JSON.stringify([])]);
  expect(second!.result.mcpSelections).toEqual([]);
  const [stored] = await q<{ selections: unknown; updated_at: Date }>(MEMBER,
    'select selections, updated_at from internal.mcp_launch_selections where session_id=$1', [chat]);
  expect(stored!.selections).toEqual([]);
  // `updated_at` moves, which is what lets the next compose tell "changed since
  // the last bind" and rebind instead of resuming the stored list (B14).
  expect(stored!.updated_at.getTime()).toBeGreaterThanOrEqual(before!.updated_at.getTime());

  // NULL deletes the row: back to the defaults, resolved fresh at each turn.
  const [cleared] = await q<{ result: { mcpSelections: unknown } }>(MEMBER,
    'select public.update_chat_mcp_selections($1,null) as result', [chat]);
  expect(cleared!.result.mcpSelections).toBeNull();
  expect(await q(MEMBER, 'select 1 from internal.mcp_launch_selections where session_id=$1', [chat])).toHaveLength(0);

  // Structure, by SQLSTATE. Shape problems are 22023; a connector that is not
  // this chat's to use is 42501.
  const bad: Array<[string, string]> = [
    ['not an array', JSON.stringify({ serverId: approvedServer })],
    ['unknown field', JSON.stringify([{ serverId: approvedServer, label: 'x' }])],
    ['serverId not a uuid', JSON.stringify([{ serverId: 'notauuid' }])],
    ['credentialId not a uuid', JSON.stringify([{ serverId: approvedServer, credentialId: 'nope' }])],
    ['duplicate server', JSON.stringify([{ serverId: approvedServer }, { serverId: approvedServer }])],
  ];
  for (const [label, shape] of bad) {
    expect(await refusal(MEMBER, 'select public.update_chat_mcp_selections($1,$2::jsonb)', [chat, shape]), label).toBe('22023');
  }
  expect(await refusal(MEMBER, 'select public.update_chat_mcp_selections($1,$2::jsonb)',
    [chat, JSON.stringify([{ serverId: otherSpaceServer }])])).toBe('42501');
  expect(await refusal(MEMBER, 'select public.update_chat_mcp_selections($1,$2::jsonb)',
    [chat, JSON.stringify([{ serverId: randomUUID() }])])).toBe('42501');
});

/**
 * B57 (354). THE PROVENANCE COLUMNS ARE THE BIND'S, NOT THE SELECTION WRITE'S.
 *
 * 345's upsert named neither `root_member_id`, `root_identity_id`, `chain` nor
 * `chain_space_ids`, so its `do update` left them where an earlier bind had put
 * them: a root and chain from one selection, sitting beside the list that
 * replaced it. `mcp_session_provenance` reports this very row to §10.6, so the
 * row could answer "recorded: true" with provenance belonging to a selection
 * the human had already discarded.
 */
it('clears the previous bind\'s root and chain when the selection is replaced', async () => {
  const pick = JSON.stringify([{ serverId: approvedServer }]);
  await q(MEMBER, 'select public.update_chat_mcp_selections($1,$2::jsonb)', [chat, pick]);
  // Stand in for an earlier bind having stamped the row. (The real one no
  // longer writes a chat's launch record at all — 354, S21a — which is the
  // other half of why these four are always NULL on a chat row.)
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`update internal.mcp_launch_selections
       set root_member_id=$2, root_identity_id='someone', chain=array[$1]::uuid[], chain_space_ids=array[$3]::uuid[]
     where session_id=$1`, [chat, plainMember, space]);
  });
  const [stamped] = await q<{ root_member_id: string | null }>(MEMBER,
    'select root_member_id from internal.mcp_launch_selections where session_id=$1', [chat]);
  expect(stamped!.root_member_id).toBe(plainMember);

  // The human replaces the selection, and the stale provenance goes with it.
  await q(MEMBER, 'select public.update_chat_mcp_selections($1,$2::jsonb)', [chat, JSON.stringify([])]);
  const [after] = await q<{ selections: unknown; root_member_id: string | null;
    root_identity_id: string | null; chain: string[] | null; chain_space_ids: string[] | null }>(MEMBER,
    `select selections, root_member_id, root_identity_id, chain, chain_space_ids
       from internal.mcp_launch_selections where session_id=$1`, [chat]);
  expect(after!.selections).toEqual([]);
  expect(after!.root_member_id).toBeNull();
  expect(after!.root_identity_id).toBeNull();
  expect(after!.chain).toBeNull();
  expect(after!.chain_space_ids).toBeNull();
  await q(MEMBER, 'select public.update_chat_mcp_selections($1,null)', [chat]);
});

it('refuses a chat selection from anyone but the configuring human', async () => {
  const pick = JSON.stringify([{ serverId: approvedServer }]);
  // An admin of the Space is not the chat's configurer, and connectors ride the
  // human who owns the thread's configuration.
  expect(await refusal(ADMIN, 'select public.update_chat_mcp_selections($1,$2::jsonb)', [chat, pick])).toBe('42501');
  expect(await refusal(OUTSIDE, 'select public.update_chat_mcp_selections($1,$2::jsonb)', [chat, pick])).toBe('42501');
  // The configurer through a LINK or an AGENT session is still refused.
  expect(await refusal(MEMBER, 'select public.update_chat_mcp_selections($1,$2::jsonb)', [chat, pick],
    [['tm8.via_link', randomUUID()]])).toBe('42501');
  expect(await refusal(MEMBER, 'select public.update_chat_mcp_selections($1,$2::jsonb)', [chat, pick],
    [['tm8.auth_kind', 'agent_runtime']])).toBe('42501');
  // A chat that does not exist is the SAME refusal, never a different error
  // that would tell a caller whether it exists.
  expect(await refusal(MEMBER, 'select public.update_chat_mcp_selections($1,$2::jsonb)', [randomUUID(), pick])).toBe('42501');
});

/**
 * B23. A catalogId is an IDENTITY CLAIM, and these are the refusals that make it
 * one. They bind ADMINISTRATORS as well — the spoof does not need a member to
 * perform it, and the Connectors page renders a provider's name, logo and help
 * text from `catalogId` alone.
 */
it('pins a catalogId to its catalog entry, for administrators too', async () => {
  const create = (over: Record<string, unknown>) => refusal(ADMIN,
    'select public.create_mcp_server_entity($1,$2::jsonb,$3,$4)',
    [space, JSON.stringify({
      name: 'identity' + Math.random().toString(36).slice(2, 8), transport: 'http',
      url: 'https://mcp.notion.com/mcp', envKeys: [], headerKeys: [],
      auth: { type: 'oauth2' }, approved: true, catalogId: 'notion', ...over,
    }), adminMember, `cr-${randomUUID()}`]);

  // The honest shape is accepted: Notion's id with Notion's endpoint.
  expect(await create({})).toBe('no-error');
  // THE SPOOF: Notion's badge on someone else's server.
  expect(await create({ url: 'https://evil.example.test/mcp' })).toBe('22023');
  // An id no catalog entry owns.
  expect(await create({ catalogId: 'notion2' })).toBe('22023');
  // A first-party entry is pinned to its own identity URL (349): Notion's URL
  // under Gmail's id is refused, and Gmail's own URL is admitted.
  expect(await create({ catalogId: 'google.gmail', firstParty: true })).toBe('22023');
  expect(await create({ name: 'gmailhonest', catalogId: 'google.gmail', firstParty: true,
    url: 'https://gmail.googleapis.com/gmail/v1' })).toBe('no-error');
  // firstParty has to agree with the entry in both directions.
  expect(await create({ firstParty: true })).toBe('22023');
  expect(await refusal(ADMIN, 'select public.create_mcp_server_entity($1,$2::jsonb,$3,$4)',
    [space, JSON.stringify({
      name: 'hostedbynobody', transport: 'http', url: 'https://else.example.test/mcp',
      envKeys: [], headerKeys: [], auth: { type: 'oauth2' }, approved: true, firstParty: true,
    }), adminMember, `cr-${randomUUID()}`])).toBe('22023');
});

it('refuses a custom request that claims a catalog identity', async () => {
  // Each of these is the attack in one field: the provider's face in Discover,
  // the tool prefix the model reads, and the line an admin reads before
  // approving. The URL in `request()` is the requester's own.
  for (const claim of [
    { catalogId: 'notion' },
    { serverKey: 'notion' },
    { provenance: 'Notion remote MCP server (official).' },
  ]) {
    expect(await refusal(MEMBER, 'select public.request_mcp_server_entity($1,$2::jsonb,null,$3,$4)',
      [space, request('claimer', claim), plainMember, `req-${randomUUID()}`]), JSON.stringify(claim)).toBe('22023');
  }
  // And a catalogId whose URL is the member's own is refused by the identity
  // rule even if the request predicate let it through.
  expect(await refusal(MEMBER, 'select public.request_mcp_server_entity($1,$2::jsonb,null,$3,$4)',
    [space, catalogRequest({ url: 'https://evil.example.test/mcp' }), plainMember, `req-${randomUUID()}`])).toBe('22023');
});

/**
 * B22. Uniqueness over LIVE rows. 296's `unique(space_id,title)` outlived a soft
 * delete, so deleting a connector reserved its name in that Space for ever and a
 * withdrawn request could squat on `notion` permanently.
 */
it('frees a connector name on delete and refuses a restore into a taken one', async () => {
  const first = await requestConnector(MEMBER, plainMember, request('squatme'));
  // The name is held while the request is live.
  expect(await refusal(MEMBER, 'select public.request_mcp_server_entity($1,$2::jsonb,null,$3,$4)',
    [space, request('squatme'), plainMember, `req-${randomUUID()}`])).toBe('23505');
  // Withdrawing frees it, which is the whole point.
  await q(MEMBER, 'select public.delete_entity($1,$2,$3)', [first, plainMember, `del-${randomUUID()}`]);
  const second = await requestConnector(MEMBER, plainMember, request('squatme'));
  expect(second).not.toBe(first);

  // A restore now has to find its name free, and raises 23505 rather than
  // quietly producing two live `squatme` connectors.
  expect(await refusal(ADMIN, 'select public.restore_entity($1,$2,$3)', [first, adminMember, `res-${randomUUID()}`]))
    .toBe('23505');
  // With the live one gone, the same restore succeeds.
  await q(MEMBER, 'select public.delete_entity($1,$2,$3)', [second, plainMember, `del-${randomUUID()}`]);
  expect(await refusal(ADMIN, 'select public.restore_entity($1,$2,$3)', [first, adminMember, `res-${randomUUID()}`]))
    .toBe('no-error');
  await q(ADMIN, 'select public.delete_entity($1,$2,$3)', [first, adminMember, `del-${randomUUID()}`]);
});

it('lets a member withdraw only a NEVER-approved request', async () => {
  const id = await requestConnector(MEMBER, plainMember, request('onceapproved'));
  const [v] = await q<{ version: number }>(MEMBER, 'select version from public.entities where id=$1', [id]);
  // An admin approves it, then suspends it. `approved` is false again, but it
  // has BEEN approved, and `approved_at` is what remembers that (finding 6).
  const definition = (approved: boolean) => JSON.stringify({
    name: 'onceapproved', transport: 'http', url: 'https://docs.example.test/mcp',
    envKeys: [], headerKeys: [], auth: { type: 'oauth2' }, approved, enabled: true,
  });
  await q(ADMIN, 'select public.update_mcp_server_entity($1,$2,$3::jsonb,$4,$5)',
    [id, v!.version, definition(true), adminMember, `up-${randomUUID()}`]);
  const [v2] = await q<{ version: number }>(MEMBER, 'select version from public.entities where id=$1', [id]);
  await q(ADMIN, 'select public.update_mcp_server_entity($1,$2,$3::jsonb,$4,$5)',
    [id, v2!.version, definition(false), adminMember, `up-${randomUUID()}`]);
  const [stamp] = await q<{ stamped: boolean }>(MEMBER,
    'select approved_at is not null as stamped from public.mcp_servers where entity_id=$1', [id]);
  expect(stamp!.stamped).toBe(true);
  expect(await refusal(MEMBER, 'select public.delete_entity($1,$2,$3)', [id, plainMember, `del-${randomUUID()}`]))
    .toBe('42501');
  // The admin still can, and that also frees the cap slot this test used.
  await q(ADMIN, 'select public.delete_entity($1,$2,$3)', [id, adminMember, `del-${randomUUID()}`]);
});

/**
 * B22 and B25, the two halves of adoption. A second ask is the same request; an
 * admin's create is told which connector to approve instead.
 */
it('returns the open request for a repeat catalog ask, and tells an admin to approve it', async () => {
  const first = await requestConnector(MEMBER, plainMember, catalogRequest());
  // A second member asking for Notion is the same decision for an admin, so it
  // is the same row — not a second one, which would collide on the name anyway.
  const again = await requestConnector(ADMIN, adminMember, catalogRequest());
  expect(again).toBe(first);
  const [open] = await q<{ found: string | null }>(MEMBER,
    'select public.open_mcp_catalog_request($1,$2) as found', [space, 'notion']);
  expect(open!.found).toBe(first);

  // B25: the admin's "Add to Space" is answered with the id to approve.
  await expect(call('mcp.servers.create', ADMIN, {
    params: { spaceId: space },
    body: {
      spaceId: space, clientMutationId: `cr-${randomUUID()}`,
      definition: {
        name: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp', envKeys: [], headerKeys: [],
        auth: { type: 'oauth2' }, approved: true, catalogId: 'notion',
      },
    },
  })).rejects.toMatchObject({ code: 'conflict', details: { serverId: first, catalogId: 'notion' } });

  // Approving the existing one is what the admin meant, and it works.
  const [version] = await q<{ version: number }>(ADMIN, 'select version from public.entities where id=$1', [first]);
  const [approved] = await q<{ result: unknown }>(ADMIN, 'select public.update_mcp_server_entity($1,$2,$3::jsonb,$4,$5) as result', [
    first, version!.version,
    JSON.stringify({
      name: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp', envKeys: [], headerKeys: [],
      auth: { type: 'oauth2' }, approved: true, catalogId: 'notion',
    }),
    adminMember, `up-${randomUUID()}`,
  ]);
  expect(approved!.result).toBeTruthy();
  // Once approved it is no longer an OPEN request, so the next create is free to
  // add a second Notion workspace deliberately.
  const [closed] = await q<{ found: string | null }>(MEMBER,
    'select public.open_mcp_catalog_request($1,$2) as found', [space, 'notion']);
  expect(closed!.found).toBeNull();
  await q(ADMIN, 'select public.delete_entity($1,$2,$3)', [first, adminMember, `del-${randomUUID()}`]);
});

/**
 * THE DRIFT TEST (B23). `internal.mcp_catalog` is a second copy of the catalog,
 * and this is what keeps it honest: a provider added to one side and not the
 * other fails here rather than leaving a hole in the identity rule.
 */
it('holds the SQL catalog equal to MCP_CATALOG, entry by entry', async () => {
  for (const entry of MCP_CATALOG) {
    const [row] = await q<{ catalog_id: string; url: string | null; first_party: boolean }>(MEMBER,
      'select * from internal.mcp_catalog($1)', [entry.id]);
    expect(row, `${entry.id} is missing from internal.mcp_catalog`).toBeTruthy();
    expect(row!.url ?? null, `${entry.id} url`).toBe(entry.definition?.url ?? null);
    expect(row!.first_party, `${entry.id} firstParty`).toBe(entry.kind === 'first_party');
    // An entry with no endpoint is exactly an entry that is not available yet.
    expect(row!.url === null, `${entry.id} availability`).toBe(!entry.available);
    // And a member may request every available entry: the SQL request predicate
    // admits the server's own prefill, first-party flag and closed gates included (349).
    if (entry.definition) {
      const [admit] = await q<{ ok: boolean }>(MEMBER, 'select internal.mcp_definition_is_request($1::jsonb) as ok', [JSON.stringify(entry.definition)]);
      expect(admit!.ok, `${entry.id} requestable`).toBe(true);
    }
  }
  // And nothing in SQL that the TS catalog does not have: the ids are the join
  // key the Discover tab uses, so an extra one would be unreachable and an
  // unexplained hole in the identity rule.
  const ids = MCP_CATALOG.map((entry) => entry.id);
  for (const stray of ['linear', 'github', 'atlassian', 'gmail', '']) {
    expect(ids).not.toContain(stray);
    const rows = await q(MEMBER, 'select * from internal.mcp_catalog($1)', [stray]);
    expect(rows, `internal.mcp_catalog knows ${stray}`).toHaveLength(0);
  }
});

/**
 * §10.4 / S25 — THE READ DOOR, through the real facade against a real database.
 *
 * `chat.getMcpSelections` exists because §10.4's sheet must know "Space
 * defaults" from "Custom" BEFORE the user touches a switch, and since 354 that
 * is the row's existence rather than anything in the list. Four things are
 * asserted here and each is a thing the UI would otherwise get wrong:
 *
 *  - NULL IS THE ANSWER for a thread on defaults, not an error and not `[]`.
 *    Confusing those two is how "back to the Space's defaults" would silently
 *    become "every connector off".
 *  - the stored list comes back verbatim after a write, so the sheet repaints
 *    from what landed rather than from what it sent;
 *  - `:id` MUST BE A CHAT. `read_mcp_launch_selections` is keyed by session id
 *    and answers for a WORK SESSION just as readily, so without the check this
 *    operation would quietly be a session-selection read on a chat path;
 *  - a LINK caller is refused, matching §10.4's own "chats opened through a
 *    Space link don't get connectors" — a surface that refuses to show the
 *    list must not have a door beside it that hands the list over.
 */
it('answers a chat\u2019s stored selection, null for defaults, and refuses a non-chat or a link caller', async () => {
  const pick = JSON.stringify([{ serverId: approvedServer }]);
  // Start from defaults: whatever earlier cells left behind, cleared through
  // the same human door the UI uses.
  await q(MEMBER, 'select public.update_chat_mcp_selections($1,null)', [chat]);

  const defaults = await call<ChatMcpSelectionsResult>('chat.getMcpSelections', MEMBER, { params: { id: chat } });
  expect(defaults).toEqual({ chatId: chat, mcpSelections: null });

  await q(MEMBER, 'select public.update_chat_mcp_selections($1,$2::jsonb)', [chat, pick]);
  const custom = await call<ChatMcpSelectionsResult>('chat.getMcpSelections', MEMBER, { params: { id: chat } });
  expect(custom.mcpSelections).toEqual([{ serverId: approvedServer }]);

  // `[]` is its own value and must not read back as null.
  await q(MEMBER, 'select public.update_chat_mcp_selections($1,$2::jsonb)', [chat, JSON.stringify([])]);
  const off = await call<ChatMcpSelectionsResult>('chat.getMcpSelections', MEMBER, { params: { id: chat } });
  expect(off.mcpSelections).toEqual([]);

  // A WORK SESSION id on the chat path: not_found, never that session's list.
  const session = randomUUID();
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'work_session',0,$3)", [session, space, plainMember]);
  });
  await expect(call('chat.getMcpSelections', MEMBER, { params: { id: session } }))
    .rejects.toMatchObject({ code: 'not_found' });

  // A human session that entered through a Space link carries `via_link` with a
  // human auth kind, so `isHumanAuthKind` alone would admit it.
  await expect(call('chat.getMcpSelections', MEMBER, {
    params: { id: chat },
    identity: { identityId: MEMBER, authKind: 'browser', viaLinkId: randomUUID() },
  })).rejects.toMatchObject({ code: 'forbidden' });

  // An AGENT session is refused by the registration's own human gate, which is
  // the whole reason this door carries `requireHumanSession` while its sibling
  // write relies on a human check inside its RPC.
  await expect(call('chat.getMcpSelections', MEMBER, {
    params: { id: chat }, identity: { identityId: MEMBER, authKind: 'agent' },
  })).rejects.toMatchObject({ code: 'forbidden' });

  await q(MEMBER, 'select public.update_chat_mcp_selections($1,null)', [chat]);
});

/**
 * §10.6 / S6 — the provenance read is a PASS-THROUGH, and `recorded:false` is a
 * normal answer.
 *
 * Nothing in this fixture binds a session, so the function's own
 * "no binding" branch is what comes back. The debug view renders that as "No
 * connector record for this session" rather than as a failure, which is the
 * distinction this cell pins: a readable session with no binding must RESOLVE,
 * not raise. The refusals (a link caller, an unreadable session) stay the
 * function's to raise and the handler's to pass on untouched.
 */
it('passes public.mcp_session_provenance through, including its recorded:false answer', async () => {
  const session = randomUUID();
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'work_session',0,$3)", [session, space, plainMember]);
  });
  const answer = await call<McpSessionProvenance>('mcp.sessions.provenance', MEMBER, { params: { sessionId: session } });
  expect(answer).toEqual({ sessionId: session, recorded: false });

  // The link refusal is the RPC's, raised before any row is read, and the
  // handler neither catches nor softens it.
  await expect(call('mcp.sessions.provenance', MEMBER, {
    params: { sessionId: session },
    identity: { identityId: MEMBER, authKind: 'browser', viaLinkId: randomUUID() },
  })).rejects.toThrow();
});
