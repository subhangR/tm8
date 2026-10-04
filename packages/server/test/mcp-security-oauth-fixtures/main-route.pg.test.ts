import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startW3PublicServer, successData, type W3PublicServer } from '../w3/public-harness.js';

// Full main.bootstrap composition, a fresh migrated DB and public HTTP routes.
// Run only with an explicit isolated test PG URL; the harness refuses prod5442.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });
let node: W3PublicServer;
let provider: Server;
let origin = '';
let serverId = '';
let spaceId = '';
const tokens: URLSearchParams[] = [];
beforeAll(async () => {
  provider = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/.well-known/')) {
      res.end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, code_challenge_methods_supported: ['S256'] })); return;
    }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    tokens.push(new URLSearchParams(Buffer.concat(chunks).toString()));
    res.end(JSON.stringify({ access_token: 'http-route-access-secret', refresh_token: 'http-route-refresh-secret', token_type: 'Bearer', expires_in: 3600 }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  // The ephemeral unclaimed-node banner contains a setup token. Keep it out
  // of test logs; errors remain visible and the scratch node is always closed.
  const bootLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  try { node = await startW3PublicServer('mcp_oauth_independent'); }
  finally { bootLog.mockRestore(); }
  const space = successData(await node.request<{ space: { id: string } }>('POST', '/v2/spaces', { name: 'OAuth independent', clientMutationId: randomUUID() }));
  spaceId = space.space.id;
  const created = successData(await node.request<{ id: string }>('POST', `/v2/spaces/${space.space.id}/mcp/servers`, {
    spaceId: space.space.id, clientMutationId: randomUUID(),
    definition: { name: 'oauth-fixture', transport: 'http', url: `${origin}/mcp`, allowPrivateNetwork: true, approved: true,
      auth: { type: 'oauth2', authorizationUrl: `${origin}/authorize`, clientId: 'route-client' }, envKeys: [], headerKeys: [] },
  }));
  serverId = created.id;
});
afterAll(async () => {
  await node?.close();
  if (provider) await new Promise<void>(resolve => provider.close(() => resolve()));
});

async function begin() {
  const started = successData(await node.request<{ authorizationUrl: string }>('POST', `/v2/mcp/servers/${serverId}/oauth/begin`, { serverId, clientMutationId: randomUUID(), label: 'HTTP account' }));
  return new URL(started.authorizationUrl);
}
const callback = (body: unknown) => node.request('POST', '/v2/mcp/oauth/callback', body);

it('composed HTTP create accepts the contract-supported OAuth issuer field', async () => {
  const created = await node.request('POST', `/v2/spaces/${spaceId}/mcp/servers`, {
    spaceId, clientMutationId: randomUUID(),
    definition: { name: 'oauth-explicit-issuer', transport: 'http', url: `${origin}/mcp`, allowPrivateNetwork: true, approved: true,
      auth: { type: 'oauth2', issuer: origin, clientId: 'route-client' }, envKeys: [], headerKeys: [] },
  });
  expect(created.status).toBe(200);
});

it('composed HTTP begin/callback preserves PKCE and binding, stores account, hides tokens and rejects replay', async () => {
  const auth = await begin(); const state = auth.searchParams.get('state')!;
  const completed = await callback({ state, code: 'fixture-code', issuer: origin });
  expect(completed.status).toBe(200);
  expect(JSON.stringify(completed.body)).not.toContain('http-route-access-secret');
  expect(JSON.stringify(completed.body)).not.toContain('http-route-refresh-secret');
  expect(tokens).toHaveLength(1);
  const token = tokens[0]!;
  expect(createHash('sha256').update(token.get('code_verifier')!).digest('base64url')).toBe(auth.searchParams.get('code_challenge'));
  expect(token.get('client_id')).toBe('route-client');
  expect(token.get('resource')).toBe(`${origin}/mcp`);
  expect(token.get('redirect_uri')).toBe(auth.searchParams.get('redirect_uri'));
  const replay = await callback({ state, code: 'fixture-code', issuer: origin });
  expect(replay.status).toBeGreaterThanOrEqual(400); expect(tokens).toHaveLength(1);
});

it('composed HTTP issuer mismatch consumes state and never exchanges a code', async () => {
  const before = tokens.length; const state = (await begin()).searchParams.get('state')!;
  expect((await callback({ state, code: 'fixture-code', issuer: 'https://attacker.test' })).status).toBeGreaterThanOrEqual(400);
  expect((await callback({ state, code: 'late-code', issuer: origin })).status).toBeGreaterThanOrEqual(400);
  expect(tokens).toHaveLength(before);
});

it('composed HTTP provider denial consumes state without token exchange', async () => {
  const before = tokens.length; const state = (await begin()).searchParams.get('state')!;
  expect((await callback({ state, error: 'access_denied', issuer: origin })).status).toBeGreaterThanOrEqual(400);
  expect((await callback({ state, code: 'late-code', issuer: origin })).status).toBeGreaterThanOrEqual(400);
  expect(tokens).toHaveLength(before);
});

it('composed HTTP callback refuses expired state before token exchange', async () => {
  const before = tokens.length; const state = (await begin()).searchParams.get('state')!;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 601_000);
  try { expect((await callback({ state, code: 'expired-code', issuer: origin })).status).toBeGreaterThanOrEqual(400); }
  finally { clock.mockRestore(); }
  expect(tokens).toHaveLength(before);
});
