import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpOAuth, refreshOAuth } from '../src/mcp/oauth.js';
import { McpProxy } from '../src/mcp/proxy.js';
import { HandlerRegistry } from '../src/facade/registry.js';
import { registerMcpRuntimeHandlers } from '../src/mcp/handlers.js';
import type { FacadeDeps } from '../src/facade/deps.js';
import type { RequestContext } from '../src/http/types.js';

// Independent fixtures exercise the actual OAuth, proxy and HTTP transport.
// Private-network policy is explicit so these tests never contact live vendors.
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
async function fixture(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function provider() {
  const calls: { path: string; body: string; authorization?: string }[] = [];
  let origin = '';
  const state = {
    metadata: {} as Record<string, unknown>, resource: {} as Record<string, unknown>,
    registration: { client_id: 'registered-client', token_endpoint_auth_method: 'none' } as Record<string, unknown>,
    token: { access_token: 'access-secret', refresh_token: 'refresh-secret', token_type: 'Bearer', expires_in: 3600 } as Record<string, unknown>,
    tokenStatus: 200, rawResource: undefined as string | undefined, rawRegistration: undefined as string | undefined,
  };
  origin = await fixture(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    calls.push({ path: req.url!, body: Buffer.concat(chunks).toString(), authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/mcp') { res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/resource"` }); res.end(); }
    else if (req.url === '/resource') res.end(state.rawResource ?? JSON.stringify(state.resource));
    else if (req.url?.startsWith('/.well-known/')) res.end(JSON.stringify(state.metadata));
    else if (req.url === '/register') res.end(state.rawRegistration ?? JSON.stringify(state.registration));
    else { res.statusCode = state.tokenStatus; res.end(JSON.stringify(state.token)); }
  });
  state.metadata = { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, code_challenge_methods_supported: ['S256'] };
  state.resource = { resource: `${origin}/mcp`, authorization_servers: [origin] };
  const oauth = new McpOAuth('https://tm8.test/callback');
  const input = { identityId: 'human', spaceId: 'space', serverId: 'server', resource: `${origin}/mcp`, issuer: origin, clientId: 'client', allowPrivateNetwork: true };
  const begin = async (overrides: Partial<typeof input> = {}) => new URL((await oauth.begin({ ...input, ...overrides })).authorizationUrl);
  return { state, calls, origin, oauth, input, begin };
}

describe('independent OAuth binding and lifecycle', () => {
  it('proves PKCE hash and exact redirect/client/resource binding through token exchange', async () => {
    const p = await provider(); const auth = await p.begin();
    const result = await p.oauth.callback('human', { state: auth.searchParams.get('state')!, code: 'code', issuer: p.origin });
    const body = new URLSearchParams(p.calls.find(call => call.path === '/token')!.body);
    expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(auth.searchParams.get('code_challenge'));
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    for (const name of ['redirect_uri', 'client_id', 'resource']) expect(body.get(name)).toBe(auth.searchParams.get(name));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(result).toMatchObject({ spaceId: 'space', serverId: 'server', secret: { issuer: p.origin, clientId: 'client', resource: p.input.resource } });
  });
  it('rejects wrong callback identity, allows owner, and rejects concurrent replay', async () => {
    const p = await provider(); const auth = await p.begin(); const input = { state: auth.searchParams.get('state')!, code: 'code' };
    await expect(p.oauth.callback('other', input)).rejects.toThrow('state');
    expect(p.calls.filter(call => call.path === '/token')).toHaveLength(0);
    const result = await Promise.allSettled([p.oauth.callback('human', input), p.oauth.callback('human', input)]);
    expect(result.map(item => item.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(p.calls.filter(call => call.path === '/token')).toHaveLength(1);
  });
  it('rejects expired state before token exchange', async () => {
    const p = await provider(); const auth = await p.begin();
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 601_000);
    await expect(p.oauth.callback('human', { state: auth.searchParams.get('state')!, code: 'code' })).rejects.toThrow('expired');
    expect(p.calls.filter(call => call.path === '/token')).toHaveLength(0);
  });
  it('rejects issuer mix-up and consumes that state', async () => {
    const p = await provider(); const auth = await p.begin(); const input = { state: auth.searchParams.get('state')!, code: 'code' };
    await expect(p.oauth.callback('human', { ...input, issuer: 'https://other.test' })).rejects.toThrow('issuer');
    await expect(p.oauth.callback('human', input)).rejects.toThrow('state');
    expect(p.calls.filter(call => call.path === '/token')).toHaveLength(0);
  });
  it.each(['issuer', 'pkce', 'token-origin', 'authorization-origin'])('rejects malicious %s discovery metadata', async attack => {
    const p = await provider();
    if (attack === 'issuer') p.state.metadata.issuer = 'https://other.test';
    if (attack === 'pkce') p.state.metadata.code_challenge_methods_supported = ['plain'];
    if (attack === 'token-origin') p.state.metadata.token_endpoint = 'http://127.0.0.1:1/token';
    if (attack === 'authorization-origin') p.state.metadata.authorization_endpoint = 'http://127.0.0.1:1/authorize';
    await expect(p.begin()).rejects.toThrow();
    expect(p.calls).toHaveLength(1);
  });
  it('discovers protected resource and refuses a substituted resource binding', async () => {
    const p = await provider();
    const auth = await p.begin({ issuer: undefined }); expect(auth.searchParams.get('resource')).toBe(p.input.resource);
    p.calls.length = 0; p.state.resource.resource = `${p.origin}/other`;
    await expect(p.begin({ issuer: undefined })).rejects.toThrow('resource binding');
    expect(p.calls.map(call => call.path)).toEqual(['/mcp', '/resource']);
  });
  it('registers a public client with exact callback and uses returned client identity', async () => {
    const p = await provider(); const auth = await p.begin({ clientId: undefined });
    expect(JSON.parse(p.calls.find(call => call.path === '/register')!.body)).toMatchObject({ redirect_uris: ['https://tm8.test/callback'], token_endpoint_auth_method: 'none' });
    expect(auth.searchParams.get('client_id')).toBe('registered-client');
    await p.oauth.callback('human', { state: auth.searchParams.get('state')!, code: 'code' });
    expect(new URLSearchParams(p.calls.find(call => call.path === '/token')!.body).get('client_id')).toBe('registered-client');
  });
  it('refuses confidential dynamic registration without exposing provider secret', async () => {
    const p = await provider(); p.state.registration.client_secret = 'provider-confidential-secret';
    await expect(p.begin({ clientId: undefined })).rejects.toThrow('public client');
  });
  it('consumes state on denied token exchange and redacts provider error body', async () => {
    const p = await provider(); p.state.tokenStatus = 400; p.state.token = { error: 'access_denied', error_description: 'secret-from-provider' };
    const auth = await p.begin(); const input = { state: auth.searchParams.get('state')!, code: 'code' };
    await expect(p.oauth.callback('human', input)).rejects.toThrow(/^OAuth token exchange failed$/);
    await expect(p.oauth.callback('human', input)).rejects.toThrow('state');
    expect(p.calls.filter(call => call.path === '/token')).toHaveLength(1);
  });
  it.each(['resource', 'registration'])('does not expose a malformed %s response in errors', async stage => {
    const p = await provider();
    if (stage === 'resource') p.state.rawResource = 'S3CRET invalid JSON';
    else p.state.rawRegistration = 'S3CRET invalid JSON';
    const error = await p.begin(stage === 'resource' ? { issuer: undefined } : { clientId: undefined }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain('S3CRET');
  });
  it('keeps resource/client binding and rotates refresh credentials', async () => {
    const p = await provider(); const auth = await p.begin();
    const { secret } = await p.oauth.callback('human', { state: auth.searchParams.get('state')!, code: 'code' });
    p.state.token = { access_token: 'rotated-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 60 };
    const refreshed = await refreshOAuth(secret, true);
    const body = new URLSearchParams(p.calls.at(-1)!.body);
    expect(Object.fromEntries(body)).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh-secret', client_id: 'client', resource: p.input.resource });
    expect(refreshed).toMatchObject({ accessToken: 'rotated-access', refreshToken: 'rotated-refresh', issuer: secret.issuer, tokenEndpoint: secret.tokenEndpoint, clientId: secret.clientId, resource: secret.resource });
  });
  it('consumes provider-denied authorization without exchanging a code', async () => {
    const p = await provider(); const auth = await p.begin(); const state = auth.searchParams.get('state')!;
    await expect(p.oauth.callback('human', { state, error: 'access_denied' })).rejects.toThrow(/^OAuth authorization denied$/);
    await expect(p.oauth.callback('human', { state, code: 'late-code' })).rejects.toThrow('state');
    expect(p.calls.filter(call => call.path === '/token')).toHaveLength(0);
  });
  it.each(['denial', 'issuer'])('handles %s through the actual OAuth callback handler', async scenario => {
    const p = await provider(); p.state.tokenStatus = 400;
    const serverId = '00000000-0000-4000-8000-000000000001';
    const registry = new HandlerRegistry();
    const deps = { db: {}, owner: async () => ({ identityId: 'human', isNodeAdmin: false }) } as unknown as FacadeDeps;
    registerMcpRuntimeHandlers(registry, deps, {
      dataDir: '/unused-independent-oauth-fixture', callbackUrl: 'https://tm8.test/callback',
      definition: async () => ({ id: serverId, spaceId: 'space', definition: { approved: true, transport: 'http', url: p.input.resource, allowPrivateNetwork: true, auth: { type: 'oauth2', authorizationUrl: `${p.origin}/authorize`, clientId: 'client' } } }) as never,
      authorize: async () => { throw new Error('unused'); },
    });
    const ctx = (body: unknown) => ({ body, params: { serverId }, identity: { kind: 'bearer', identityId: 'human', authKind: 'browser' }, requestId: 'fixture' }) as RequestContext;
    const started = await registry.get('mcp.oauth.begin')!(ctx({ clientMutationId: 'begin', label: 'fixture' })) as { authorizationUrl: string };
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    const callback = registry.get('mcp.oauth.callback')!;
    if (scenario === 'denial') {
      await expect(callback(ctx({ state, error: 'access_denied' }))).rejects.toThrow();
      await expect(callback(ctx({ state, code: 'late-code' }))).rejects.toThrow('state');
      expect(p.calls.filter(call => call.path === '/token')).toHaveLength(0);
    } else {
      // A mismatched issuer may be safely rejected at the contract boundary.
      await expect(callback(ctx({ state, code: 'code', issuer: 'https://attacker.test' }))).rejects.toThrow();
      expect(p.calls.filter(call => call.path === '/token')).toHaveLength(0);
      // A matching issuer must be usable; a provider error proves it reached
      // token exchange instead of rejecting every issuer-bearing callback.
      const second = await registry.get('mcp.oauth.begin')!(ctx({ clientMutationId: 'begin-again', label: 'fixture' })) as { authorizationUrl: string };
      const secondState = new URL(second.authorizationUrl).searchParams.get('state')!;
      await expect(callback(ctx({ state: secondState, code: 'code', issuer: p.origin }))).rejects.toThrow(/^OAuth token exchange failed$/);
      expect(p.calls.filter(call => call.path === '/token')).toHaveLength(1);
    }
  });
  it.each([false, true])('refreshes once after 401 and bounds a repeated failure (recovery=%s)', async recover => {
    let requests = 0; let refreshes = 0;
    const seenTokens: (string | undefined)[] = [];
    const url = await fixture((req, res) => {
      if (req.url === '/token') { refreshes++; res.end(JSON.stringify({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 })); return; }
      requests++; seenTokens.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-secret' || !recover) { res.writeHead(401); res.end('access-secret refresh-secret'); return; }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { echoed: ['access-secret', 'refresh-secret', 'rotated-access', 'rotated-refresh'] } }));
    });
    let secret = { kind: 'oauth' as const, accessToken: 'access-secret', refreshToken: 'refresh-secret', issuer: url, tokenEndpoint: `${url}/token`, clientId: 'client', resource: url, expiresAt: Date.now() + 3_600_000 };
    const proxy = new McpProxy({
      authorize: async () => ({ sessionId: 'session', identityId: 'human', spaceId: 'space', serverId: 'server', credentialId: 'account' }),
      definition: async () => ({ id: 'server', spaceId: 'space', approved: true, transport: 'http', url, allowPrivateNetwork: true, auth: { type: 'oauth2' } }),
      credentials: { read: async () => ({ nonce: 'n', secret }), replace: async (_claims, _binding, _nonce, updated) => { secret = updated as typeof secret; } },
    });
    const request = proxy.request({ identityId: 'human' }, 'session', 'server', 'tools/list');
    if (recover) await expect(request).resolves.toEqual({ echoed: Array(4).fill('[redacted]') });
    else await expect(request).rejects.toThrow(/^MCP upstream request failed$/);
    expect(requests).toBe(recover ? 4 : 2); expect(refreshes).toBe(1);
    expect(seenTokens[0]).toBe('Bearer access-secret');
    expect(seenTokens.slice(1).every(token => token === 'Bearer rotated-access')).toBe(true);
  });
  it('does not retry an OAuth request after connector approval is revoked during refresh', async () => {
    let approved = true; let requests = 0; let refreshes = 0;
    const url = await fixture((req, res) => {
      if (req.url === '/token') {
        refreshes++; approved = false;
        res.end(JSON.stringify({ access_token: 'rotated', token_type: 'Bearer', expires_in: 3600 })); return;
      }
      requests++;
      if (requests === 1) { res.writeHead(401); res.end(); return; }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
    });
    let secret = { kind: 'oauth' as const, accessToken: 'original', refreshToken: 'refresh', issuer: url, tokenEndpoint: `${url}/token`, clientId: 'client', resource: url, expiresAt: Date.now() + 3_600_000 };
    const proxy = new McpProxy({
      authorize: async () => ({ sessionId: 'session', identityId: 'human', spaceId: 'space', serverId: 'server', credentialId: 'account' }),
      definition: async () => ({ id: 'server', spaceId: 'space', approved, transport: 'http', url, allowPrivateNetwork: true, auth: { type: 'oauth2' } }),
      credentials: { read: async () => ({ nonce: 'n', secret }), replace: async (_claims, _binding, _nonce, updated) => { secret = updated as typeof secret; } },
    });
    await expect(proxy.request({ identityId: 'human' }, 'session', 'server', 'tools/list')).rejects.toThrow('unavailable');
    expect(refreshes).toBe(1);
    expect(requests).toBe(1);
  });
});
