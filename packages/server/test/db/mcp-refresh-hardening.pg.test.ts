/**
 * Migration 377 — §7.2 refresh failures and §9.3(4) revoke-all, against a real
 * database and a loopback provider (nothing leaves the host):
 *
 * - a refresh refused with invalid_grant marks the connection needs_reconnect
 *   and puts an inbox item in front of its owner, and no one else;
 * - the same refusal within 10 minutes of a successful refresh on a shared
 *   connection is possible_reuse, and the Space admins are told too;
 * - a Space admin's revoke-all revokes every row locally but calls Google's
 *   revoke ONLY for the Space-owned row, never a member's (B39).
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { GOOGLE_OAUTH_ISSUER } from '@tm8/contract';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { McpCredentialStore, type McpOAuthSecret } from '../../src/mcp/credential-store.js';
import { MCP_RECONNECT_REQUIRED, McpProxy, type McpProxyDefinition } from '../../src/mcp/proxy.js';
import { registerMcpRuntimeHandlers } from '../../src/mcp/handlers.js';
import { GOOGLE_ENDPOINTS } from '../../src/mcp/first-party/google/endpoints.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { RequestContext } from '../../src/http/types.js';
import { memoryOAuthPending } from '../mcp/oauth-pending-fixture.js';

vi.setConfig({ testTimeout: 180000, hookTimeout: 300000 });

let scratch: W1ScratchDatabase; let db: Db; let dir: string; let store: McpCredentialStore;
let provider: Server; let origin: string;
/** Every token the loopback provider was asked to revoke. */
const revoked: string[] = [];
const spaceId = randomUUID();
const adminMember = randomUUID(), aliceMember = randomUUID();
const adminIdentity = 'mcp-rh-admin-' + randomUUID();
const aliceIdentity = 'mcp-rh-alice-' + randomUUID();
const auth = (identityId: string): DbClaims => ({ identityId, authKind: 'browser', sessionSpaceId: spaceId, requestId: randomUUID() });
const RESOURCE = 'https://mcp.example.test/mcp';

beforeAll(async () => {
  // The provider: its token endpoint refuses every refresh as a dead grant, and
  // its revoke endpoint records what it was sent.
  provider = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/token') { res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid_grant' })); return; }
      if (req.url === '/revoke') { revoked.push(new URLSearchParams(body).get('token') ?? ''); res.end('{}'); return; }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  scratch = await createW1ScratchDatabase('mcp_refresh_hardening');
  scratch.apply(migrationFiles());
  db = createDb(scratch.url, { max: 4 });
  dir = await mkdtemp(join(tmpdir(), 'mcp-refresh-hardening-'));
  store = new McpCredentialStore(db, dir);
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    for (const identity of [adminIdentity, aliceIdentity]) {
      await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1)', [identity]);
      await c.query('insert into public.accounts(identity_id,username,display_name,is_node_admin,is_owner) values($1,$1,$1,false,false)', [identity]);
    }
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'MCP refresh hardening',$2)", [spaceId, adminIdentity]);
    for (const [id, identity, role] of [[adminMember, adminIdentity, 'owner'], [aliceMember, aliceIdentity, 'member']] as const) {
      await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1)", [id, spaceId]);
      await c.query('insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,$4,$3)', [id, spaceId, identity, role]);
    }
  });
});
afterAll(async () => {
  await db?.end(); await scratch?.destroy();
  if (dir) await rm(dir, { recursive: true, force: true });
  await new Promise<void>(resolve => provider ? provider.close(() => resolve()) : resolve());
});

const connector = async (name: string) =>
  (await db.tx(auth(adminIdentity), q => q.rpc<{ entity: { id: string } }>('create_mcp_server_entity', [spaceId,
    JSON.stringify({ name, transport: 'http', url: RESOURCE, envKeys: [], headerKeys: ['Authorization'], auth: { type: 'api_key', headerName: 'Authorization' }, approved: true }),
    null, randomUUID()]))).entity.id;
const oauthSecret = (overrides: Partial<McpOAuthSecret> = {}): McpOAuthSecret => ({
  kind: 'oauth', accessToken: 'access-' + randomUUID(), refreshToken: 'refresh-' + randomUUID(), expiresAt: Date.now() - 60_000,
  issuer: origin, tokenEndpoint: `${origin}/token`, resource: RESOURCE, clientId: 'client', tokenEndpointAuthMethod: 'none', ...overrides,
});
const connect = async (identity: string, serverId: string, secret: McpOAuthSecret, scope: 'member' | 'space' = 'member') =>
  (await store.create(auth(identity), { spaceId, serverId, label: 'Conn ' + randomUUID().slice(0, 8), secret, scope }) as { id: string }).id;
const row = async (id: string) => (await scratch.query<{ status: string; status_reason: string | null; secret_ciphertext: Buffer | null }>(
  'select status,status_reason,secret_ciphertext from public.space_credentials where id=$1', [id]))[0]!;
const inbox = (credentialId: string) => scratch.query<{ recipient_member_id: string; kind: string; reason: string }>(
  "select recipient_member_id,kind,payload->>'reason' as reason from public.notifications where payload->>'credentialId'=$1 order by recipient_member_id", [credentialId]);
/** One proxied call by Alice's session on her own connection: the refresh is due, so it runs first. */
const call = (serverId: string, credentialId: string) => {
  const definition: McpProxyDefinition = { id: serverId, spaceId, approved: true, transport: 'http', url: RESOURCE, allowPrivateNetwork: true, auth: { type: 'oauth2' } };
  const proxy = new McpProxy({
    credentials: store,
    authorize: async () => ({ sessionId: 'session', identityId: aliceIdentity, spaceId, serverId, credentialId }),
    definition: async () => definition,
  });
  return proxy.request(auth(aliceIdentity), 'session', serverId, 'tools/list');
};

it('a refresh refused with invalid_grant marks the connection needs_reconnect and puts an inbox item before its owner', async () => {
  const serverId = await connector('invalidgrant');
  const credentialId = await connect(aliceIdentity, serverId, oauthSecret());

  await expect(call(serverId, credentialId)).rejects.toThrow(MCP_RECONNECT_REQUIRED);

  expect(await row(credentialId)).toMatchObject({ status: 'needs_reconnect', status_reason: 'invalid_grant' });
  // The owner, and only the owner: a private member connection is nobody else's to fix.
  expect(await inbox(credentialId)).toEqual([{ recipient_member_id: aliceMember, kind: 'mcp.credential.needs_reconnect', reason: 'invalid_grant' }]);
  // One-way and idempotent: a second failure neither unmarks nor re-notifies.
  await expect(call(serverId, credentialId)).rejects.toThrow();
  expect(await inbox(credentialId)).toHaveLength(1);
});

it('the same refusal within 10 minutes of a successful refresh on a shared connection is possible_reuse, and the admins are told', async () => {
  const serverId = await connector('possiblereuse');
  const credentialId = await connect(aliceIdentity, serverId, oauthSecret());
  // Shared with the Space, and refreshed successfully a minute ago.
  await scratch.query("update public.space_credentials set visibility='public', last_refresh_at=now()-interval '1 minute' where id=$1", [credentialId]);

  await expect(call(serverId, credentialId)).rejects.toThrow(MCP_RECONNECT_REQUIRED);

  expect(await row(credentialId)).toMatchObject({ status: 'needs_reconnect', status_reason: 'possible_reuse' });
  expect((await inbox(credentialId)).map(item => [item.recipient_member_id, item.reason]).sort())
    .toEqual([[adminMember, 'possible_reuse'], [aliceMember, 'possible_reuse']].sort());
});

it("a Space admin's revoke-all revokes every row locally but calls Google's revoke only for the Space-owned row (B39)", async () => {
  const serverId = await connector('revokeall');
  const google = (refreshToken: string) => oauthSecret({ issuer: GOOGLE_OAUTH_ISSUER, tokenEndpoint: GOOGLE_ENDPOINTS.token, refreshToken, expiresAt: Date.now() + 3_600_000 });
  const member = await connect(aliceIdentity, serverId, google('member-refresh-token'));
  const shared = await connect(adminIdentity, serverId, google('space-refresh-token'), 'space');

  const registry = new HandlerRegistry();
  registerMcpRuntimeHandlers(registry, { db, owner: async () => ({ identityId: adminIdentity, isNodeAdmin: false }) } as unknown as FacadeDeps, {
    dataDir: dir, callbackUrl: 'https://tm8.test/mcp/oauth/callback', oauthPending: memoryOAuthPending(),
    google: { endpoints: { ...GOOGLE_ENDPOINTS, revocation: `${origin}/revoke` }, client: () => undefined, privateNetwork: true },
    definition: async () => { throw new Error('unused'); },
    authorize: async () => { throw new Error('unused'); },
  });
  const ctx = (identityId: string, body: unknown) => ({ body, params: {}, requestId: 'revoke-all',
    identity: { kind: 'bearer', identityId, authKind: 'browser', sessionSpaceId: spaceId } }) as unknown as RequestContext;

  // A member is no Space admin.
  await expect(registry.get('mcp.credentials.revokeAll')!(ctx(aliceIdentity, { clientMutationId: 'm', spaceId }))).rejects.toThrow();
  expect(revoked).toEqual([]);

  // Every live MCP row in the Space goes: these two, plus whatever the tests
  // above left needs_reconnect (Alice's, not Google's, so nothing to send).
  const [{ live }] = await scratch.query<{ live: number }>(
    "select count(*)::int as live from public.space_credentials where space_id=$1 and provider='mcp' and status<>'revoked'", [spaceId]) as [{ live: number }];
  const result = await registry.get('mcp.credentials.revokeAll')!(ctx(adminIdentity, { clientMutationId: 'a', spaceId }));
  expect(result).toEqual({ scope: 'space', revoked: live, providerRevoked: 1, providerFailed: 0 });
  // Google heard about the Space's connection and never about Alice's.
  expect(revoked).toEqual(['space-refresh-token']);
  for (const id of [member, shared]) expect(await row(id)).toMatchObject({ status: 'revoked', secret_ciphertext: null });
});
