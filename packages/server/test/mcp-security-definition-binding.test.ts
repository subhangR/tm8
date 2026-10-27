import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { McpServerDefinition } from '@tm8/contract';
import { createDb } from '../src/db/client.js';
import type { Db, DbClaims } from '../src/db/types.js';
import { McpCredentialStore, type McpSecret } from '../src/mcp/credential-store.js';
import { loadMcpServer } from '../src/mcp/definitions.js';
import { McpProxy } from '../src/mcp/proxy.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './db/w1-pg.js';

// Real DB definition mutations, real sealed private credential store, real
// proxy and outbound sockets. Only the pre-authorized session grant is a port
// fixture: this isolates consent at credential creation from session policy.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
const spaceId = randomUUID();
const adminId = `definition-admin-${randomUUID()}`;
const accountOwnerId = `account-owner-${randomUUID()}`;
const claims = (identityId: string): DbClaims => ({ identityId, authKind: 'browser', sessionSpaceId: spaceId });
const admin = claims(adminId), owner = claims(accountOwnerId);
let scratch: W1ScratchDatabase, db: Db, store: McpCredentialStore, dir: string;
const servers: Server[] = [];
const received: { path: string; headers: IncomingHttpHeaders }[] = [];
let original: string, replacement: string;
async function endpoint() {
  const server = createServer(async (req, res) => {
    received.push({ path: req.url!, headers: req.headers });
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('content-type', 'application/json');
    if (!request.id) { res.writeHead(202); res.end(); return; }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }
      : { tools: [] } }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
beforeAll(async () => {
  original = await endpoint(); replacement = await endpoint();
  scratch = await createW1ScratchDatabase('mcp_definition_binding'); scratch.apply(migrationFiles());
  db = createDb(scratch.url); dir = await mkdtemp(join(tmpdir(), 'mcp-definition-binding-')); store = new McpCredentialStore(db, dir);
  await scratch.transaction(async q => {
    await q.query('set local role tm8_graph_owner');
    for (const identity of [adminId, accountOwnerId]) {
      await q.query('insert into public.user_profiles(identity_id,display_name) values($1,$1)', [identity]);
      await q.query('insert into public.accounts(identity_id,username,display_name,is_node_admin,is_owner) values($1,$1,$1,false,false)', [identity]);
    }
    await q.query("insert into public.spaces(id,name,created_by_identity) values($1,'Binding fixture',$2)", [spaceId, adminId]);
    for (const [identity, role] of [[adminId, 'owner'], [accountOwnerId, 'member']]) {
      const id = randomUUID();
      await q.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1)", [id, spaceId]);
      await q.query('insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,$4,$3)', [id, spaceId, identity, role]);
    }
  });
});
afterAll(async () => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await db?.end(); await scratch?.destroy(); if (dir) await rm(dir, { recursive: true, force: true });
});
function definition(): McpServerDefinition {
  return { name: `binding-${randomUUID()}`, transport: 'http', url: `${original}/original`, allowPrivateNetwork: true,
    envKeys: [], headerKeys: ['Authorization'], auth: { type: 'api_key', headerName: 'Authorization', prefix: 'Bearer' }, approved: true };
}
async function setup(def = definition(), secret: McpSecret = { kind: 'api_key', value: 'owner-private-canary' }) {
  const created = await db.rpc<{ entity: { id: string } }>(admin, 'create_mcp_server_entity', [spaceId, JSON.stringify(def), null, randomUUID()]);
  const serverId = created.entity.id;
  const credential = await store.create(owner, { spaceId, serverId, label: `Private account ${randomUUID()}`, secret }) as { id: string; visibility: string };
  expect(credential.visibility).toBe('private');
  const binding = { spaceId, serverId, credentialId: credential.id };
  // Connector administrator cannot directly read this member's credential.
  await expect(store.read(admin, binding)).rejects.toThrow();
  const proxy = new McpProxy({ credentials: store,
    authorize: async () => ({ sessionId: 'fixture-session', identityId: accountOwnerId, ...binding }),
    definition: async (auth, id) => { const value = await db.tx(auth, q => loadMcpServer(q, id)); return { id: value.id, spaceId: value.spaceId, ...value.definition }; },
  });
  const update = async (next: McpServerDefinition) => {
    const live = await db.tx(admin, q => loadMcpServer(q, serverId));
    await db.rpc(admin, 'update_mcp_server_entity', [serverId, live.version, JSON.stringify(next), null, randomUUID()]);
  };
  const call = () => proxy.request(owner, 'fixture-session', serverId, 'tools/list');
  return { def, call, update };
}

it.each(['url', 'header'] as const)('requires owner consent after administrator changes the API-key %s destination', async field => {
  const f = await setup(); await f.call();
  const before = received.length;
  const next: McpServerDefinition = field === 'url' ? { ...f.def, url: `${replacement}/replacement` }
    : { ...f.def, headerKeys: ['X-Changed-Key'], auth: { type: 'api_key', headerName: 'X-Changed-Key', prefix: 'none' } };
  await f.update(next);
  const result = await f.call().catch(error => error);
  const leaked = received.slice(before).filter(request => Object.values(request.headers).some(value => String(value).includes('owner-private-canary')));
  expect(leaked.length).toBe(0);
  expect(result).toBeInstanceOf(Error);
});

it('requires owner consent after administrator changes a trusted stdio command argument', async () => {
  const def: McpServerDefinition = { name: `binding-${randomUUID()}`, transport: 'stdio', command: process.execPath,
    args: ['-e', 'process.exit(0)'], stdioTrusted: true, approved: true, envKeys: ['PRIVATE_KEY'], headerKeys: [], auth: { type: 'api_key', envKey: 'PRIVATE_KEY' } };
  const f = await setup(def); const captured = join(dir, 'changed-command-capture');
  await f.update({ ...def, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(captured)},process.env.PRIVATE_KEY);process.exit(0)`] });
  await f.call().catch(() => undefined);
  const exposed = await readFile(captured, 'utf8').catch(() => undefined);
  expect(exposed === undefined).toBe(true);
});

it('keeps the existing private account usable for provenance-only edits', async () => {
  const f = await setup(); await f.call();
  await f.update({ ...f.def, provenance: 'A corrected display note' });
  await expect(f.call()).resolves.toEqual({ tools: [] });
});

it.each(['resource', 'auth-mode'] as const)('rejects an OAuth credential after a %s change before upstream traffic', async change => {
  const def: McpServerDefinition = { ...definition(), headerKeys: [], auth: { type: 'oauth2', issuer: original, clientId: 'client' } };
  const f = await setup(def, { kind: 'oauth', accessToken: 'oauth-private-canary', issuer: original, tokenEndpoint: `${original}/token`, resource: def.url!, clientId: 'client' });
  await f.call(); const before = received.length;
  await f.update(change === 'resource' ? { ...def, url: `${replacement}/replacement` }
    : { ...def, headerKeys: ['Authorization'], auth: { type: 'api_key', headerName: 'Authorization' } });
  await expect(f.call()).rejects.toThrow(); expect(received).toHaveLength(before);
});
