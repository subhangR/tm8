import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { McpOAuth, refreshOAuth, revokeOAuth, type McpOAuthPendingRow, type McpOAuthPendingTaken, type OAuthIdentity } from '../src/index.js';

it('standalone OAuth seals owner-bound one-time state, exchanges with PKCE, refreshes and revokes', async () => {
  let origin = '';
  const requests: { path: string; body: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    requests.push({ path: request.url ?? '', body });
    response.setHeader('content-type', 'application/json');
    const metadata = { issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', registration_endpoint: origin + '/register', revocation_endpoint: origin + '/revoke', code_challenge_methods_supported: ['S256'] };
    response.end(JSON.stringify(request.url?.startsWith('/.well-known/') ? metadata : request.url === '/register' ? { client_id: 'owned-client' } : { access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600 }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  origin = `http://127.0.0.1:${address.port}`;
  const rows = new Map<string, { owner: string; row: McpOAuthPendingRow }>();
  const key = randomBytes(32);
  const oauth = new McpOAuth(origin + '/callback', {
    async insert(claims: OAuthIdentity, row: McpOAuthPendingRow) {
      rows.set(row.stateHash.toString('hex'), { owner: claims.identityId ?? '', row });
      expect(row.ciphertext.toString()).not.toContain('owned-client');
      return row.expiresAt.toISOString();
    },
    async take(claims: OAuthIdentity, hash: Buffer): Promise<McpOAuthPendingTaken | null> {
      const saved = rows.get(hash.toString('hex'));
      if (!saved || saved.owner !== claims.identityId) return null;
      rows.delete(hash.toString('hex'));
      const row = saved.row;
      return { ...row, identityId: saved.owner, ciphertext: row.ciphertext.toString('base64'), nonce: row.nonce.toString('base64'), definitionVersion: row.definitionVersion ?? null, returnTo: row.returnTo ?? null, expiresAt: row.expiresAt.toISOString() };
    },
  }, { activeKeyId: 'test:key', keyFor: async () => key });
  try {
    const begun = await oauth.begin({ identityId: 'alice' }, { spaceId: 'tenant', serverId: 'provider', resource: origin + '/mcp', issuer: origin, label: 'Work', allowPrivateNetwork: true });
    const url = new URL(begun.authorizationUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state'); if (!state) throw new Error('No state');
    await expect(oauth.callback({ identityId: 'bob' }, { state, code: 'code' })).rejects.toThrow();
    const result = await oauth.callback({ identityId: 'alice' }, { state, code: 'code', issuer: origin });
    expect(result.secret.clientId).toBe('owned-client');
    expect(requests.find(request => request.path === '/token')?.body).toContain('code_verifier=');
    await expect(oauth.callback({ identityId: 'alice' }, { state, code: 'code' })).rejects.toThrow();
    expect((await refreshOAuth(result.secret, true)).accessToken).toBe('fixture-access');
    expect(await revokeOAuth(result.secret, true)).toBe(true);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
