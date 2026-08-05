/**
 * The ONE place a stored git credential is decrypted, and the only consumer of
 * `public.read_account_git_credential`.
 *
 * It is a separate file from `git-credentials.ts` on purpose. That file answers
 * HTTP and must never have a plaintext token in scope; this one exists solely
 * to put a token into a child process's environment at spawn. Keeping them
 * apart means "does any request handler touch plaintext?" is answerable by
 * looking at imports rather than by reading every method.
 *
 * WHY THE SPAWNER'S CREDENTIAL AND NOT THE PERSONA'S. A teammate persona is a
 * shared object — several members of a space can launch the same one — so a
 * credential attached to a persona would be a credential shared by whoever
 * happened to use it, which is precisely the machine-wide login this feature
 * replaces. The claims carried into `spawn` are the HUMAN's, and the session
 * therefore acts on GitHub as the human who started it. That is also who is
 * accountable for what it pushes.
 */
import type { GitCredential, GitCredentialPort, GraphAuth } from '@tm8/execution';

import { loadOrCreateCredentialKey, openSecret } from '../../../credentials/index.js';
import type { Db, DbClaims } from '../../../db/types.js';

interface StoredCredentialRow {
  accountId: string;
  provider: string;
  login: string | null;
  tokenCiphertext: string;
  tokenNonce: string;
}

export interface GitCredentialPortOptions {
  readonly db: Db;
  /** Where the node's credential key lives. Same root the blob store uses. */
  readonly dataDir: string;
  readonly logger?: { warn?: (message: string, fields?: Record<string, unknown>) => void };
}

/**
 * Build the spawn-side reader.
 *
 * `forSpawner` resolves `null` — never throws — when there is no credential,
 * when the row cannot be decrypted, or when the read itself fails. A launch
 * must not die because someone has not connected GitHub yet, and a node whose
 * key file was replaced should degrade to "no credential" rather than refusing
 * to start agents. The undecryptable case is LOGGED, because it means a stored
 * row is permanently unreadable and the owner needs to re-enter their token.
 */
export function createGitCredentialPort(options: GitCredentialPortOptions): GitCredentialPort {
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
        // Never include the ciphertext or any part of it: an error string is
        // the classic way a secret reaches a log file.
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
