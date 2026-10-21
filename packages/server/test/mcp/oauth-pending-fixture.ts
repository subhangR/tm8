import { randomBytes } from 'node:crypto';
import type { KeyProvider } from '../../src/credentials/key-provider.js';
import { McpOAuth, type McpOAuthPendingStore, type McpOAuthPendingTaken } from '../../src/mcp/oauth.js';

/**
 * A database-free stand-in for `internal.mcp_oauth_pending` (migration 342), for
 * the unit tests that exercise discovery, PKCE and the code exchange. It keeps
 * the table's rules — keyed by state hash, consumed once, never by another
 * identity — so the OAuth tests still prove single use. Production never uses
 * it: the handlers default to DbMcpOAuthPendingStore.
 */
export function memoryOAuthPending(): McpOAuthPendingStore & { rows: Map<string, McpOAuthPendingTaken> } {
  const rows = new Map<string, McpOAuthPendingTaken>();
  return {
    rows,
    async insert(claims, row) {
      const expiresAt = row.expiresAt.toISOString();
      rows.set(row.stateHash.toString('hex'), {
        identityId: claims.identityId!, spaceId: row.spaceId, serverId: row.serverId,
        definitionVersion: row.definitionVersion ?? null, scope: row.scope, keyId: row.keyId,
        ciphertext: row.ciphertext.toString('base64'), nonce: row.nonce.toString('base64'),
        label: row.label, returnTo: row.returnTo ?? null, expiresAt,
      });
      return expiresAt;
    },
    async take(claims, stateHash) {
      const key = stateHash.toString('hex'); const row = rows.get(key);
      if (!row || row.identityId !== claims.identityId) return null;
      rows.delete(key);
      return row;
    },
  };
}

export function fixtureKeys(): KeyProvider {
  const key = randomBytes(32);
  return { activeKeyId: 'local:v1', keyFor: async () => key };
}

export function fixtureOAuth(callbackUrl = 'https://tm8.test/callback'): McpOAuth {
  return new McpOAuth(callbackUrl, memoryOAuthPending(), fixtureKeys());
}
