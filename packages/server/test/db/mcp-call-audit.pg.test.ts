/**
 * §5.6 PER-CALL MCP AUDIT (plan §5.6, G10, §9.3(6); migration 346).
 *
 * Driven through the REAL `mcp.proxy.request` handler, the real
 * `McpSessionBindings.authorize` and the real database, against a fake upstream
 * MCP server. What has to hold:
 *
 *   * every call leaves a row — a refused one included, which before 346 left
 *     nothing because `authorize` threw ahead of the `started` row;
 *   * a row names the tool, the root, the chain bind RECORDED, latency and
 *     sizes, and never an argument or a result;
 *   * only the audited session's own runtime bearer can write its rows, and a
 *     chain or root that is not the recorded one is refused;
 *   * admins read the Space, members the rows they are the root of;
 *   * rows past the retention window are pruned (node admin only).
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getOperation } from '@tm8/contract';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { McpSessionBindings } from '../../src/mcp/session-bindings.js';
import { hashToken } from '../../src/identity/crypto.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { RequestContext } from '../../src/http/types.js';
import { registerMcpRuntimeHandlers } from '../../src/mcp/handlers.js';
import { registerMcpAuditHandlers } from '../../src/mcp/audit.js';
import { runMcpAuditRetentionTick } from '../../src/scheduler/jobs/mcp-audit-retention.js';

vi.setConfig({ testTimeout: 120000, hookTimeout: 300000 });

let scratch: W1ScratchDatabase;
let db: Db;
let bindings: McpSessionBindings;
let upstream: Server;
let upstreamUrl = '';
let failUpstream = false;
const registry = new HandlerRegistry();

const space = randomUUID();
const otherSpace = randomUUID();
const people = {
  alice: { identity: `audit-alice-${randomUUID()}`, account: randomUUID(), member: randomUUID(), role: 'owner' },
  bob:   { identity: `audit-bob-${randomUUID()}`,   account: randomUUID(), member: randomUUID(), role: 'member' },
  carol: { identity: `audit-carol-${randomUUID()}`, account: randomUUID(), member: randomUUID(), role: 'member' },
  /** Also a member of `otherSpace`, so a chain can pass through it. */
  dan:   { identity: `audit-dan-${randomUUID()}`,   account: randomUUID(), member: randomUUID(), role: 'member' },
};
const danElsewhere = randomUUID();
const operator = { identity: `audit-operator-${randomUUID()}`, account: randomUUID() };
const persona = randomUUID();
let server = '';
let unselected = '';

const human = (who: keyof typeof people, s = space): DbClaims =>
  ({ identityId: people[who].identity, authKind: 'browser', sessionSpaceId: s });

/** A live work session plus its agent bearer, as the spawn mints them. */
async function session(who: keyof typeof people) {
  const sessionId = randomUUID();
  const authSessionId = randomUUID();
  const secret = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query("insert into public.entities(id,space_id,kind,created_by) values($1,$2,'work_session',$3)", [sessionId, space, people[who].member]);
    await c.query("insert into public.work_sessions(entity_id,title,status,share_mode) values($1,'audit fixture','running','space')", [sessionId]);
    await c.query(`insert into public.auth_sessions(id,account_id,kind,acting_as_team_member_id,work_session_id,token_hash,expires_at,space_id)
      values($1,$2,'agent',$3,$4,$5,now()+interval '1 hour',$6)`,
      [authSessionId, people[who].account, persona, sessionId, hashToken(secret), space]);
  });
  return {
    sessionId, authSessionId, token: `tm8s_${authSessionId}.${secret}`,
    claims: { identityId: people[who].identity, authKind: 'agent', sessionSpaceId: space, authSessionId } as DbClaims,
  };
}
type Session = Awaited<ReturnType<typeof session>>;

/** Bound through the real `bind`, so root and chain are what 343 records. */
async function boundSession(who: keyof typeof people) {
  const s = await session(who);
  await bindings.bind(human(who), { sessionId: s.sessionId, spaceId: space, teamMemberId: persona, agentToken: s.token,
    mcpSelections: [{ serverId: server }] });
  return s;
}

/** One `mcp.proxy.request`, as the facade would dispatch it for this bearer. */
async function call(s: Session, who: keyof typeof people, serverId: string, method: string, params?: Record<string, unknown>, via: HandlerRegistry = registry) {
  const ctx = {
    op: getOperation('mcp.proxy.request'), opName: 'mcp.proxy.request', params: { sessionId: s.sessionId, serverId },
    query: new URLSearchParams(), body: { message: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) } },
    requestId: `audit-${randomUUID()}`, headers: {}, method: 'POST', path: '/',
    identity: { kind: 'bearer', identityId: people[who].identity, authKind: 'agent', sessionId: s.authSessionId,
      workSessionId: s.sessionId, sessionSpaceId: space },
  } as unknown as RequestContext;
  return via.get('mcp.proxy.request')!(ctx);
}

async function list(claims: { identity: string; authKind?: string; viaLinkId?: string; pin?: string }, query: Record<string, string> = {}, s = space) {
  const ctx = {
    op: getOperation('mcp.audit.list'), opName: 'mcp.audit.list', params: { spaceId: s },
    query: new URLSearchParams(query), body: undefined, requestId: `audit-list-${randomUUID()}`, headers: {}, method: 'GET', path: '/',
    identity: { kind: 'bearer', identityId: claims.identity, authKind: claims.authKind ?? 'browser', sessionId: randomUUID(),
      ...(claims.viaLinkId ? { viaLinkId: claims.viaLinkId } : {}), ...(claims.pin ? { sessionSpaceId: claims.pin } : {}) },
  } as unknown as RequestContext;
  return registry.get('mcp.audit.list')!(ctx) as Promise<{ items: Array<Record<string, unknown>>; nextCursor: string | null; scope: string }>;
}

const rowsFor = (sessionId: string) => scratch.query<Record<string, unknown>>(
  'select * from public.mcp_call_audit where session_id = $1 order by id', [sessionId]);

const failure = async (run: () => Promise<unknown>): Promise<string> => {
  try { await run(); return 'ok'; } catch (error) { return String((error as Error).message); }
};

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('mcp_call_audit');
  scratch.apply(migrationFiles());
  db = createDb(scratch.url, { max: 4 });
  bindings = new McpSessionBindings(db);
  upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string };
    if (failUpstream && message.method !== 'initialize' && message.id !== undefined) { res.writeHead(500); res.end('down'); return; }
    res.setHeader('content-type', 'application/json');
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'initialize' ? { protocolVersion: '2025-03-26' }
      : message.method === 'tools/list' ? { tools: [{ name: 'send_email', inputSchema: { type: 'object' } }] }
      : { content: [{ type: 'text', text: 'result-canary sent' }] } }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/mcp`;

  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    for (const [name, p] of [...Object.entries(people), ['operator', operator] as const]) {
      await c.query('insert into public.accounts(id,identity_id,username,is_node_admin) values($1,$2,$3,$4)',
        [p.account, p.identity, `audit-${name}-${p.account.slice(0, 8)}`, name === 'operator']);
      await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$2)', [p.identity, name]);
    }
    await c.query('insert into public.spaces(id,name,created_by_identity) values($1,$2,$3),($4,$5,$3)',
      [space, 'Audit space', people.alice.identity, otherSpace, 'Elsewhere']);
    for (const [name, p] of Object.entries(people)) {
      await c.query("insert into public.entities(id,space_id,kind,created_by) values($1,$2,'member',$1)", [p.member, space]);
      await c.query('insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,$4,$5)',
        [p.member, space, p.identity, p.role, name]);
    }
    await c.query("insert into public.entities(id,space_id,kind,created_by) values($1,$2,'member',$1)", [danElsewhere, otherSpace]);
    await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,'member','dan')",
      [danElsewhere, otherSpace, people.dan.identity]);
    await c.query("insert into public.entities(id,space_id,kind,created_by) values($1,$2,'team_member',$3)", [persona, space, people.alice.member]);
    await c.query("insert into public.team_members(entity_id,owner_member_id,name,role,model,agent_tool) values($1,$2,'Audit worker','helper','claude-sonnet-4-5','claude-code')",
      [persona, people.alice.member]);
  });
  const definition = (name: string) => JSON.stringify({ name, transport: 'http', url: 'https://example.test/mcp', envKeys: [], headerKeys: [],
    auth: { type: 'none' }, approved: true });
  server = (await db.rpc<{ entity: { id: string } }>(human('alice'), 'create_mcp_server_entity', [space, definition('auditmail'), null, randomUUID()])).entity.id;
  unselected = (await db.rpc<{ entity: { id: string } }>(human('alice'), 'create_mcp_server_entity', [space, definition('auditother'), null, randomUUID()])).entity.id;

  compose(registry);
  registerMcpAuditHandlers(registry, depsFor(db));
});

const depsFor = (database: Pick<Db, 'rpc'>) =>
  ({ db: database, owner: async () => ({ identityId: operator.identity, isNodeAdmin: false }), config: {} }) as unknown as FacadeDeps;
/** The connector the proxy dials is the fake upstream; authorize still resolves the REAL row. */
const upstreamDefinition = (overrides: Record<string, unknown> = {}) =>
  ({ name: 'auditmail', transport: 'http', url: upstreamUrl, envKeys: [], headerKeys: [], auth: { type: 'none' },
     approved: true, allowPrivateNetwork: true, ...overrides });
/** The real proxy handler over `database`, optionally with a different connector definition. */
function compose(target: HandlerRegistry, options: { database?: Pick<Db, 'rpc'>; definition?: () => Record<string, unknown> } = {}) {
  registerMcpRuntimeHandlers(target, depsFor(options.database ?? db), {
    dataDir: '/unused', callbackUrl: 'https://tm8.test/mcp/oauth/callback',
    definition: async (_claims, id) => ({ id, spaceId: space, version: 1,
      allowed: { register: false, manage: false, approve: false, attach: false },
      definition: options.definition?.() ?? upstreamDefinition() }) as never,
    authorize: (claims, sessionId, serverId) => bindings.authorize(claims, sessionId, serverId),
  });
  return target;
}
afterAll(async () => {
  await db?.end(); await scratch?.destroy();
  await new Promise<void>(resolve => upstream ? upstream.close(() => resolve()) : resolve());
});

describe('§5.6 every call leaves a row', () => {
  it('a succeeded call names tool, root, recorded chain, latency and sizes — and no argument or result', async () => {
    const s = await boundSession('bob');
    await call(s, 'bob', server, 'tools/list');
    const result = await call(s, 'bob', server, 'tools/call', { name: 'send_email', arguments: { to: 'argument-canary@example.test' } });
    expect(JSON.stringify(result)).toContain('result-canary');
    const rows = await rowsFor(s.sessionId);
    expect(rows.map(r => [r.method, r.tool, r.outcome])).toEqual([
      ['tools/list', null, 'started'], ['tools/list', null, 'succeeded'],
      ['tools/call', 'send_email', 'started'], ['tools/call', 'send_email', 'succeeded'],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ space_id: space, server_id: server, root_member_id: people.bob.member, chain: [s.sessionId],
        via: 'session', chat_id: null, deny_reason: null });
      expect(row.latency_ms).toBeGreaterThanOrEqual(0);
      expect(row.request_bytes).toBeGreaterThan(0);
    }
    expect(rows[3]!.response_bytes).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain('argument-canary');
    expect(JSON.stringify(rows)).not.toContain('result-canary');
  });

  it('a call to a connector the session never selected is DENIED, recorded with its reason and the recorded provenance', async () => {
    const s = await boundSession('bob');
    expect(await failure(() => call(s, 'bob', unselected, 'tools/call', { name: 'delete_everything' }))).toMatch(/not selected/);
    const rows = await rowsFor(s.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ server_id: unselected, method: 'tools/call', tool: 'delete_everything', outcome: 'denied',
      deny_reason: 'not_selected', root_member_id: people.bob.member, chain: [s.sessionId] });
  });

  it('a call refused because the root left the Space mid-session is DENIED, and still written', async () => {
    const s = await boundSession('carol');
    await call(s, 'carol', server, 'tools/list');
    await scratch.query("update public.members set status='removed', left_at=now() where entity_id=$1", [people.carol.member]);
    try {
      expect(await failure(() => call(s, 'carol', server, 'tools/list'))).not.toBe('ok');
    } finally {
      await scratch.query("update public.members set status='active', left_at=null where entity_id=$1", [people.carol.member]);
    }
    const rows = await rowsFor(s.sessionId);
    expect(rows.map(r => r.outcome)).toEqual(['started', 'succeeded', 'denied']);
    expect(rows[2]).toMatchObject({ deny_reason: 'not_member', root_member_id: people.carol.member });
  });

  it('an upstream failure is FAILED, not denied', async () => {
    const s = await boundSession('bob');
    failUpstream = true;
    try { expect(await failure(() => call(s, 'bob', server, 'tools/call', { name: 'send_email' }))).not.toBe('ok'); }
    finally { failUpstream = false; }
    expect((await rowsFor(s.sessionId)).map(r => [r.outcome, r.deny_reason])).toEqual([['started', null], ['failed', null]]);
  });

  it('a bearer naming ANOTHER session is denied and recorded against its own session only', async () => {
    const mine = await boundSession('bob');
    const theirs = await boundSession('alice');
    const ctx = {
      op: getOperation('mcp.proxy.request'), opName: 'mcp.proxy.request', params: { sessionId: theirs.sessionId, serverId: server },
      query: new URLSearchParams(), body: { message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }, requestId: 'mismatch',
      headers: {}, method: 'POST', path: '/',
      identity: { kind: 'bearer', identityId: people.bob.identity, authKind: 'agent', sessionId: mine.authSessionId,
        workSessionId: mine.sessionId, sessionSpaceId: space },
    } as unknown as RequestContext;
    expect(await failure(() => registry.get('mcp.proxy.request')!(ctx) as Promise<unknown>)).toMatch(/bearer mismatch/);
    expect(await rowsFor(theirs.sessionId)).toHaveLength(0);
    expect((await rowsFor(mine.sessionId)).map(r => [r.outcome, r.deny_reason, r.server_id]))
      .toEqual([['denied', 'session_mismatch', server]]);
  });
});

describe('review fixes (#1321)', () => {
  it('a NUL in the tool name cannot suppress a denied row: control characters are stripped', async () => {
    const s = await boundSession('bob');
    expect(await failure(() => call(s, 'bob', unselected, 'tools/call', { name: 'x\u0000\u0007' }))).toMatch(/not selected/);
    expect((await rowsFor(s.sessionId)).map(r => [r.outcome, r.deny_reason, r.tool])).toEqual([['denied', 'not_selected', 'x']]);
  });

  it('a refusal whose row will not write is retried without the tool name, never dropped', async () => {
    const s = await boundSession('bob');
    // The database refuses any row that carries a tool name.
    const picky = { rpc: (claims: DbClaims, fn: string, args: readonly unknown[] = []) =>
      fn === 'record_mcp_call_audit' && args[4] !== null ? Promise.reject(new Error('refused')) : db.rpc(claims, fn, args) };
    const via = compose(new HandlerRegistry(), { database: picky });
    expect(await failure(() => call(s, 'bob', unselected, 'tools/call', { name: 'send_email' }, via))).toMatch(/not selected/);
    expect((await rowsFor(s.sessionId)).map(r => [r.outcome, r.deny_reason, r.tool])).toEqual([['denied', 'not_selected', null]]);
  });

  it('a succeeded row that fails to write never turns a call the provider acted on into an error', async () => {
    const s = await boundSession('bob');
    const flaky = { rpc: (claims: DbClaims, fn: string, args: readonly unknown[] = []) =>
      fn === 'record_mcp_call_audit' && args[5] === 'succeeded' ? Promise.reject(new Error('audit down')) : db.rpc(claims, fn, args) };
    const via = compose(new HandlerRegistry(), { database: flaky });
    const result = await call(s, 'bob', server, 'tools/call', { name: 'send_email' }, via);
    expect(JSON.stringify(result)).toContain('result-canary');
    expect((await rowsFor(s.sessionId)).map(r => r.outcome)).toEqual(['started']);
  });

  it('a connector that needs an account the grant does not carry is DENIED credential_required', async () => {
    const s = await boundSession('bob');
    const via = compose(new HandlerRegistry(), { definition: () => upstreamDefinition({ auth: { type: 'api_key', headerName: 'Authorization' } }) });
    expect(await failure(() => call(s, 'bob', server, 'tools/list', undefined, via))).toMatch(/Select an MCP account/);
    expect((await rowsFor(s.sessionId)).map(r => [r.outcome, r.deny_reason])).toEqual([['started', null], ['denied', 'credential_required']]);
  });

  it('a connector whose definition changes mid-call is DENIED definition_changed', async () => {
    const s = await boundSession('bob');
    let reads = 0;
    const via = compose(new HandlerRegistry(), { definition: () => upstreamDefinition({ description: `revision ${reads++}` }) });
    expect(await failure(() => call(s, 'bob', server, 'tools/list', undefined, via))).toMatch(/definition changed/);
    expect((await rowsFor(s.sessionId)).map(r => [r.outcome, r.deny_reason])).toEqual([['started', null], ['denied', 'definition_changed']]);
  });

  it('multi-hop: the root leaving a Space EARLIER in the chain is DENIED, with the recorded chain on the row', async () => {
    const s = await session('dan');
    const parent = randomUUID();
    // A cross-Space chain cannot be produced through spawn today (the agent pin;
    // see mcp-provenance.pg.test.ts), so the binding is written as bind records it.
    await scratch.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query(`insert into internal.mcp_session_bindings
        (session_id,space_id,auth_session_id,runtime_identity_id,launcher_identity_id,launcher_auth_kind,
         selections,root_member_id,root_identity_id,chain,chain_space_ids)
        values($1,$2,$3,$4,$4,'browser',$5,$6,$4,$7,$8)`,
        [s.sessionId, space, s.authSessionId, people.dan.identity, JSON.stringify([{ serverId: server }]), people.dan.member,
         [s.sessionId, parent], [space, otherSpace]]);
    });
    await call(s, 'dan', server, 'tools/list');
    await scratch.query("update public.members set status='removed', left_at=now() where entity_id=$1", [danElsewhere]);
    try {
      expect(await failure(() => call(s, 'dan', server, 'tools/list'))).toMatch(/every space in the chain/);
    } finally {
      await scratch.query("update public.members set status='active', left_at=null where entity_id=$1", [danElsewhere]);
    }
    const rows = await rowsFor(s.sessionId);
    expect(rows.map(r => [r.outcome, r.deny_reason])).toEqual([['started', null], ['succeeded', null], ['denied', 'root_left_chain_space']]);
    expect(rows[2]).toMatchObject({ root_member_id: people.dan.member, chain: [s.sessionId, parent] });
  });
});

describe('the writer', () => {
  const write = (claims: DbClaims, s: Session, overrides: Partial<{ root: string | null; chain: string[] | null; outcome: string; reason: string | null }> = {}) =>
    db.rpc(claims, 'record_mcp_call_audit', [s.sessionId, server, null, 'tools/call', 'send_email', overrides.outcome ?? 'succeeded',
      overrides.root ?? null, overrides.chain ?? null, overrides.reason ?? null, 1, 2, 3]);

  it('accepts only the audited session\'s own runtime bearer', async () => {
    const s = await boundSession('bob');
    const other = await boundSession('alice');
    expect(await failure(() => write(other.claims, s))).toMatch(/writer unavailable/);
    expect(await failure(() => write(human('bob'), s))).toMatch(/writer unavailable/);
    expect(await failure(() => write({ ...s.claims, viaLinkId: randomUUID() }, s))).not.toBe('ok');
    expect(await failure(() => write(s.claims, s))).toBe('ok');
  });

  it('refuses a connector from ANOTHER Space (B50): a row can never name one', async () => {
    const s = await boundSession('bob');
    const foreign = randomUUID();
    await scratch.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query("insert into public.entities(id,space_id,kind,created_by) values($1,$2,'mcp_server',$3)", [foreign, otherSpace, danElsewhere]);
    });
    const as = (serverId: string, outcome: string, reason: string | null) => failure(() => db.rpc(s.claims, 'record_mcp_call_audit',
      [s.sessionId, serverId, null, 'tools/call', 'send_email', outcome, null, null, reason, 1, 2, 3]));
    expect(await as(foreign, 'succeeded', null)).toMatch(/not one of this space/);
    expect(await as(foreign, 'denied', 'not_selected')).toMatch(/not one of this space/);
    expect(await as(server, 'succeeded', null)).toBe('ok');
  });

  it('refuses a chain or root that is not the recorded one', async () => {
    const s = await boundSession('bob');
    expect(await failure(() => write(s.claims, s, { chain: [randomUUID()] }))).toMatch(/recorded chain/);
    expect(await failure(() => write(s.claims, s, { root: people.alice.member }))).toMatch(/recorded root/);
    expect(await failure(() => write(s.claims, s, { root: people.bob.member, chain: [s.sessionId] }))).toBe('ok');
  });

  it('requires a reason on a denial and refuses one anywhere else', async () => {
    const s = await boundSession('bob');
    expect(await failure(() => write(s.claims, s, { outcome: 'denied' }))).not.toBe('ok');
    expect(await failure(() => write(s.claims, s, { outcome: 'succeeded', reason: 'not_selected' }))).not.toBe('ok');
    expect(await failure(() => write(s.claims, s, { outcome: 'denied', reason: 'not_selected' }))).toBe('ok');
  });
});

describe('mcp.audit.list', () => {
  let bobSession: Session;
  let aliceSession: Session;
  beforeAll(async () => {
    bobSession = await boundSession('bob');
    aliceSession = await boundSession('alice');
    await call(bobSession, 'bob', server, 'tools/call', { name: 'send_email' });
    await call(aliceSession, 'alice', server, 'tools/call', { name: 'read_inbox' });
    await failure(() => call(aliceSession, 'alice', unselected, 'tools/list'));
  });

  it('an admin sees the whole Space, filtered by session, member, connector and outcome', async () => {
    const all = await list({ identity: people.alice.identity });
    expect(all.scope).toBe('space');
    const roots = new Set(all.items.map(r => r.rootMemberId));
    expect(roots.has(people.bob.member) && roots.has(people.alice.member)).toBe(true);
    const bobs = await list({ identity: people.alice.identity }, { sessionId: bobSession.sessionId });
    expect(bobs.items.map(r => [r.tool, r.outcome])).toEqual([['send_email', 'succeeded'], ['send_email', 'started']]);
    const byMember = await list({ identity: people.alice.identity }, { memberId: people.bob.member });
    expect(byMember.items.every(r => r.rootMemberId === people.bob.member)).toBe(true);
    const denied = await list({ identity: people.alice.identity }, { sessionId: aliceSession.sessionId, outcome: 'denied' });
    expect(denied.items.map(r => [r.serverId, r.denyReason])).toEqual([[unselected, 'not_selected']]);
    const byServer = await list({ identity: people.alice.identity }, { serverId: unselected });
    expect(byServer.items.every(r => r.serverId === unselected)).toBe(true);
  });

  it('a member sees only the calls they are the root of', async () => {
    const own = await list({ identity: people.bob.identity });
    expect(own.scope).toBe('own');
    expect(own.items.length).toBeGreaterThan(0);
    expect(own.items.every(r => r.rootMemberId === people.bob.member)).toBe(true);
    expect((await list({ identity: people.bob.identity }, { memberId: people.alice.member })).items).toEqual([]);
    expect((await list({ identity: people.bob.identity }, { sessionId: aliceSession.sessionId })).items).toEqual([]);
    // And the table's own policy agrees with the door.
    const direct = await db.query<{ root_member_id: string }>(human('bob'), 'select root_member_id from public.mcp_call_audit');
    expect(direct.length).toBeGreaterThan(0);
    expect(direct.every(r => r.root_member_id === people.bob.member)).toBe(true);
  });

  it('pages newest first with a cursor', async () => {
    const first = await list({ identity: people.alice.identity }, { limit: '2' });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await list({ identity: people.alice.identity }, { limit: '2', cursor: first.nextCursor! });
    expect(Number(second.items[0]!.id)).toBeLessThan(Number(first.items[1]!.id));
  });

  it('is a HUMAN surface: an agent bearer is refused, even one carrying an admin\'s identity', async () => {
    expect(await failure(() => list({ identity: people.alice.identity, authKind: 'agent' }))).toMatch(/human sessions only/);
    // The SQL door refuses on its own, behind the facade guard.
    const agentClaims: DbClaims = { identityId: people.alice.identity, authKind: 'agent', sessionSpaceId: space, authSessionId: aliceSession.authSessionId };
    expect(await failure(() => db.rpc(agentClaims, 'list_mcp_call_audit', [space, null, null, null, null, null, null, 10]))).not.toBe('ok');
    expect(await db.query(agentClaims, 'select id from public.mcp_call_audit')).toEqual([]);
  });

  it('honours the session-Space pin on BOTH branches', async () => {
    // Pinned to another Space, neither the admin nor a member reads this one.
    expect(await failure(() => list({ identity: people.alice.identity, pin: otherSpace }))).not.toBe('ok');
    expect(await failure(() => list({ identity: people.bob.identity, pin: otherSpace }))).not.toBe('ok');
    expect(await db.query(human('alice', otherSpace), 'select id from public.mcp_call_audit')).toEqual([]);
    expect(await db.query(human('bob', otherSpace), 'select id from public.mcp_call_audit')).toEqual([]);
    // Pinned to this Space, the member still sees their own.
    expect((await db.query(human('bob', space), 'select id from public.mcp_call_audit')).length).toBeGreaterThan(0);
  });

  it('refuses a non-member, a link caller and a bad filter', async () => {
    expect(await failure(() => list({ identity: operator.identity }))).not.toBe('ok');
    expect(await failure(() => list({ identity: people.alice.identity, viaLinkId: randomUUID() }))).not.toBe('ok');
    expect(await failure(() => list({ identity: people.alice.identity, authKind: 'link', viaLinkId: randomUUID() }))).not.toBe('ok');
    expect(await failure(() => list({ identity: people.alice.identity }, { outcome: 'exploded' }))).toMatch(/outcome must be/);
    expect(await failure(() => list({ identity: people.alice.identity }, { sessionId: 'nope' }))).toMatch(/uuid/);
  });
});

describe('retention', () => {
  it('prunes rows past the window, keeps the rest, and is node-admin only', async () => {
    const s = await boundSession('bob');
    await call(s, 'bob', server, 'tools/list');
    const [old] = await rowsFor(s.sessionId);
    await scratch.query("update public.mcp_call_audit set occurred_at = now() - interval '91 days' where id = $1", [old!.id]);
    const admin = async (): Promise<DbClaims> => ({ identityId: operator.identity, nodeAdmin: true });
    expect(await failure(() => db.rpc(human('alice'), 'prune_mcp_call_audit', ['90 days', 100]))).toMatch(/node admin/);
    expect(await failure(async () => db.rpc(await admin(), 'prune_mcp_call_audit', ['1 hour', 100]))).toMatch(/at least one day/);
    // Retention 0 keeps everything.
    expect(await runMcpAuditRetentionTick({ db, claims: admin, retentionDays: 0 })).toMatchObject({ skipped: true });
    expect(await rowsFor(s.sessionId)).toHaveLength(2);
    const outcome = await runMcpAuditRetentionTick({ db, claims: admin, batchSize: 1 });
    expect(outcome.affected).toBeGreaterThanOrEqual(1);
    expect((await rowsFor(s.sessionId)).map(r => r.id)).not.toContain(old!.id);
    expect(await rowsFor(s.sessionId)).toHaveLength(1);
  });
});
