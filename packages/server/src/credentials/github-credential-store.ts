/**
 * The encrypted string-shaped GitHub credential store.
 *
 * This is the only server module that opens a stored token. Status reads stay
 * in credential-catalog.ts and use the table's column-limited SELECT grant, so
 * no HTTP read handler ever has plaintext in scope.
 */
import type { GitHubCredential, GitHubCredentialPort, GraphAuth } from '@tm8/execution';

import type { Db, DbClaims } from '../db/types.js';
import { loadOrCreateCredentialKey } from './credential-key.js';
import { openSecret, sealSecret } from './secret-box.js';

const PROVIDER = 'github' as const;
const MAX_TOKEN_BYTES = 4_000;

interface StoredCredentialRow {
  accountId: string;
  provider: string;
  login: string;
  tokenCiphertext: string;
  tokenNonce: string;
}

interface AccountRow {
  account_id: string | null;
}

export interface DbGitHubCredentialStoreOptions {
  db: Db;
  dataDir: string;
  logger?: { warn?: (message: string, fields?: Record<string, unknown>) => void };
}

export class DbGitHubCredentialStore implements GitHubCredentialPort {
  private readonly db: Db;
  private readonly dataDir: string;
  private readonly logger: DbGitHubCredentialStoreOptions['logger'];

  constructor(options: DbGitHubCredentialStoreOptions) {
    this.db = options.db;
    this.dataDir = options.dataDir;
    this.logger = options.logger;
  }

  async store(claims: DbClaims, input: { login: string; token: string }): Promise<void> {
    const login = input.login.trim();
    if (login === '') throw new Error('GitHub credential login is empty');
    const tokenBytes = Buffer.byteLength(input.token, 'utf8');
    if (tokenBytes < 1 || tokenBytes > MAX_TOKEN_BYTES) {
      // Do not include the value or even its prefix in an error.
      throw new Error('GitHub credential token has an invalid length');
    }

    const rows = await this.db.query<AccountRow>(
      claims,
      'select internal.current_account_id() as account_id',
    );
    const accountId = rows[0]?.account_id ?? null;
    if (!accountId) throw new Error('no active account for this identity');

    const key = await loadOrCreateCredentialKey(this.dataDir);
    const sealed = sealSecret(key, input.token, { accountId, provider: PROVIDER });
    await this.db.rpc(claims, 'set_account_git_credential', [
      PROVIDER,
      login,
      sealed.ciphertext,
      sealed.nonce,
    ]);
  }

  async delete(claims: DbClaims): Promise<void> {
    await this.db.rpc(claims, 'delete_account_git_credential', [PROVIDER]);
  }

  /** Resolve only the caller's RLS-scoped row; null is the ordinary no-login case. */
  async resolve(auth: GraphAuth): Promise<GitHubCredential | null> {
    const claims = auth as DbClaims;
    const row = await this.db.rpc<StoredCredentialRow | null>(
      claims,
      'read_account_git_credential',
      [PROVIDER],
    );
    if (!row) return null;

    try {
      const key = await loadOrCreateCredentialKey(this.dataDir);
      const token = openSecret(
        key,
        {
          ciphertext: Buffer.from(row.tokenCiphertext, 'base64'),
          nonce: Buffer.from(row.tokenNonce, 'base64'),
        },
        { accountId: row.accountId, provider: row.provider },
      );
      return { provider: PROVIDER, login: row.login, token };
    } catch (error) {
      // The token/ciphertext is never logged. Login is display metadata.
      this.logger?.warn?.('GitHub credential could not be decrypted', {
        provider: row.provider,
        login: row.login,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      throw new Error('stored GitHub credential is unreadable');
    }
  }
}
