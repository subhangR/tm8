/**
 * Process-side adapter for staging's account_git_credentials store.
 *
 * Writes seal plaintext before it reaches Postgres. Reads are spawn-only and
 * resolve the caller's own row through an RLS-scoped SECURITY DEFINER RPC.
 */
import { CollabError } from '@tm8/contract';
import type { GitCredential, GitCredentialPort, GraphAuth } from '@tm8/execution';

import type { Db, DbClaims } from '../db/types.js';
import { loadOrCreateCredentialKey, openSecret, sealSecret } from './index.js';

interface StoredCredentialRow {
  accountId: string;
  provider: string;
  login: string | null;
  tokenCiphertext: string;
  tokenNonce: string;
}

export interface GitCredentialStoreOptions {
  readonly db: Db;
  readonly dataDir: string;
  readonly logger?: { warn?: (message: string, fields?: Record<string, unknown>) => void };
}

export class GitCredentialStore {
  constructor(private readonly options: GitCredentialStoreOptions) {}

  async store(input: {
    claims: DbClaims;
    login: string;
    provider: 'github';
    token: string;
  }): Promise<void> {
    const accountId = await this.resolveAccountId(input.claims);
    const key = await loadOrCreateCredentialKey(this.options.dataDir);
    const sealed = sealSecret(key, input.token, { accountId, provider: input.provider });
    await this.options.db.rpc(input.claims, 'public.set_account_git_credential', [
      input.provider,
      input.login,
      sealed.ciphertext,
      sealed.nonce,
    ]);
  }

  async delete(input: { claims: DbClaims }): Promise<void> {
    await this.options.db.rpc(input.claims, 'public.delete_account_git_credential', ['github']);
  }

  private async resolveAccountId(claims: DbClaims): Promise<string> {
    const rows = await this.options.db.query<{ account_id: string | null }>(
      claims,
      'select internal.current_account_id() as account_id',
    );
    const accountId = rows[0]?.account_id ?? null;
    if (!accountId) {
      throw new CollabError('unauthenticated', 'no active account for this identity');
    }
    return accountId;
  }
}

export function createGitCredentialPort(options: GitCredentialStoreOptions): GitCredentialPort {
  return {
    async forSpawner(auth: GraphAuth): Promise<GitCredential | null> {
      const claims = auth as DbClaims;
      let row: StoredCredentialRow | null;
      try {
        row = await options.db.rpc<StoredCredentialRow | null>(
          claims,
          'public.read_account_git_credential',
          ['github'],
        );
      } catch (error) {
        options.logger?.warn?.('git credentials: read failed; spawning without one', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
      if (!row) return null;

      try {
        const key = await loadOrCreateCredentialKey(options.dataDir);
        const token = openSecret(
          key,
          {
            ciphertext: Buffer.from(row.tokenCiphertext, 'base64'),
            nonce: Buffer.from(row.tokenNonce, 'base64'),
          },
          { accountId: row.accountId, provider: row.provider },
        );
        return { provider: 'github', login: row.login, token };
      } catch (error) {
        options.logger?.warn?.('git credentials: stored credential could not be decrypted', {
          provider: row.provider,
          login: row.login,
          reason: error instanceof Error ? error.name : 'unknown',
        });
        return null;
      }
    },
  };
}
