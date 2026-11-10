import { CollabError } from '@tm8/contract';
import { McpOAuth as IntegrationOAuth, IntegrationOAuthError } from '@tm8/integrations';
import type { Db, DbClaims } from '../db/types.js';
import type { McpOAuthPendingStore, McpOAuthPendingRow, McpOAuthPendingTaken } from '@tm8/integrations';
export { refreshOAuth, revokeOAuth, OAuthTokenError, oauthErrorCode } from '@tm8/integrations';
export type { Metadata, OAuthClient, McpFirstPartyAuthorization, McpOAuthPendingRow, McpOAuthPendingTaken, McpOAuthPendingTarget, McpOAuthCallbackResult } from '@tm8/integrations';
export type { McpOAuthPendingStore } from '@tm8/integrations';

/** Translate reusable authorization errors into tm8's wire contract. */
async function wire<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) { if (error instanceof IntegrationOAuthError) throw new CollabError(error.code, error.message); throw error; }
}
export class McpOAuth extends IntegrationOAuth<DbClaims> {
  override begin(...args: Parameters<IntegrationOAuth<DbClaims>['begin']>) { return wire(() => super.begin(...args)); }
  override callback(...args: Parameters<IntegrationOAuth<DbClaims>['callback']>) { return wire(() => super.callback(...args)); }
}

export class DbMcpOAuthPendingStore implements McpOAuthPendingStore {
  constructor(private readonly db: Db) {}
  async insert(claims: DbClaims, row: McpOAuthPendingRow): Promise<string> {
    const stored = await this.db.rpc<string | Date>(claims, 'create_mcp_oauth_pending', [
      row.stateHash, row.spaceId, row.serverId, row.definitionVersion ?? null, row.scope, row.keyId,
      row.ciphertext, row.nonce, row.label, row.returnTo ?? null, row.expiresAt.toISOString(),
    ]);
    return new Date(stored).toISOString();
  }
  take(claims: DbClaims, stateHash: Buffer): Promise<McpOAuthPendingTaken | null> {
    return this.db.rpc<McpOAuthPendingTaken | null>(claims, 'take_mcp_oauth_pending', [stateHash]);
  }
}
