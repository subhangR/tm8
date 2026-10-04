import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { McpProxy } from '../src/mcp/proxy.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function fixture(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const claims = (identityId = 'human') => ({ identityId });
const grant = (sessionId: string, credentialId = 'account') => ({
  sessionId, identityId: 'human', spaceId: 'space', serverId: 'server', credentialId,
});

describe('independent MCP proxy adversarial assertions', () => {
  it('serializes refresh for one rotating OAuth credential across two sessions', async () => {
    let refreshCalls = 0;
    let current = { kind: 'oauth' as const, accessToken: 'old', refreshToken: 'rotate',
      expiresAt: Date.now() - 1, issuer: 'https://issuer.test', tokenEndpoint: '', resource: '', clientId: 'client' };
    const url = await fixture(async (req, res) => {
      if (req.url === '/token') {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        current = { ...current, accessToken: `access-${refreshCalls}`, refreshToken: `rotate-${refreshCalls}`, expiresAt: Date.now() + 3_600_000 };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ access_token: current.accessToken, refresh_token: current.refreshToken, token_type: 'Bearer', expires_in: 3600 }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    });
    current.tokenEndpoint = `${url}/token`;
    current.resource = url;
    const proxy = new McpProxy({
      authorize: async (requestClaims, sessionId) => ({ ...grant(sessionId), identityId: requestClaims.identityId }),
      definition: async () => ({ id: 'server', spaceId: 'space', approved: true, transport: 'http' as const, url, allowPrivateNetwork: true, auth: { type: 'oauth2' as const } }),
      credentials: {
        read: async () => ({ secret: current, nonce: 'nonce' }),
        replace: async (_claims, _binding, _nonce, secret) => { current = secret as typeof current; },
      },
    });
    await Promise.all([
      proxy.request(claims(), 'session-a', 'server', 'tools/list'),
      proxy.request(claims(), 'session-b', 'server', 'tools/list'),
    ]);
    expect(refreshCalls).toBe(1);
  });

  it('rechecks a revoked share after session bind before upstream traffic', async () => {
    let requests = 0;
    const url = await fixture((_req, res) => { requests += 1; res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })); });
    let authorizations = 0;
    const proxy = new McpProxy({
      authorize: async () => {
        authorizations += 1;
        if (authorizations > 1) throw new Error('share revoked');
        return grant('session');
      },
      definition: async () => ({ id: 'server', spaceId: 'space', approved: true, transport: 'http' as const, url, allowPrivateNetwork: true, auth: { type: 'none' as const } }),
      credentials: { read: async () => { throw new Error('not used'); }, replace: async () => {} },
    });
    await expect(proxy.request(claims(), 'session', 'server', 'tools/call')).rejects.toThrow('revoked');
    expect(requests).toBe(0);
  });

  it('denies a swapped session/server/credential grant before network access', async () => {
    let requests = 0;
    const url = await fixture((_req, res) => { requests += 1; res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })); });
    const proxy = new McpProxy({
      authorize: async () => ({ ...grant('other-session', 'other-account'), serverId: 'other-server' }),
      definition: async () => ({ id: 'server', spaceId: 'space', approved: true, transport: 'http' as const, url, allowPrivateNetwork: true, auth: { type: 'none' as const } }),
      credentials: { read: async () => { throw new Error('not used'); }, replace: async () => {} },
    });
    await expect(proxy.request(claims(), 'session', 'server', 'tools/list')).rejects.toThrow('unavailable');
    expect(requests).toBe(0);
  });

  it('honors an explicit API-key prefix of none', async () => {
    let authorization = '';
    const url = await fixture((req, res) => { authorization = String(req.headers.authorization); res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })); });
    const proxy = new McpProxy({
      authorize: async () => grant('session'),
      definition: async () => ({ id: 'server', spaceId: 'space', approved: true, transport: 'http' as const, url, allowPrivateNetwork: true, auth: { type: 'api_key' as const, headerName: 'Authorization', prefix: 'none' } as never }),
      credentials: { read: async () => ({ secret: { kind: 'api_key' as const, value: 'raw-secret' }, nonce: 'n' }), replace: async () => {} },
    });
    await proxy.request(claims(), 'session', 'server', 'tools/list');
    expect(authorization).toBe('raw-secret');
  });

  it('rechecks connector approval before every send', async () => {
    let requests = 0;
    const url = await fixture((_req, res) => { requests += 1; res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })); });
    let definitions = 0;
    const proxy = new McpProxy({
      authorize: async () => ({ ...grant('session'), credentialId: undefined }),
      definition: async () => ({ id: 'server', spaceId: 'space', approved: definitions++ === 0, transport: 'http' as const, url, allowPrivateNetwork: true, auth: { type: 'none' as const } }),
      credentials: { read: async () => { throw new Error('not used'); }, replace: async () => {} },
    });
    await expect(proxy.request(claims(), 'session', 'server', 'tools/list')).rejects.toThrow('unavailable');
    expect(requests).toBe(0);
  });
});
