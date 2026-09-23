/**
 * The encrypted SERVICE KEY store (migration 203): keys tm8 uses server-side
 * on a member's behalf. Today only `typesafe`, the key behind ✦ Ask Jev.
 *
 * NOT AN AGENT CREDENTIAL. Nothing on the spawn path imports this module or
 * reads 203's table: a service key is never placed in a spawned session's
 * environment, manifest, credential home or PTY. `SERVICE_KEY_PROVIDERS`
 * records that as data (`injectedAtSpawn: false`) so a test can hold it, and
 * `test/credentials/service-key-not-injected.test.ts` proves it on the real
 * spawn path.
 *
 * Sealed exactly as GitHub tokens are (`github-credential-store.ts`): AES-256-GCM
 * under the node key, AAD `<account_id>|<provider>`. This is the only module
 * that opens one; status reads use 203's column-limited grant and never have
 * the ciphertext in scope. The key and its ciphertext are never logged.
 */
import type { ServiceKeyProviderName } from '@tm8/contract';

import type { Db, DbClaims } from '../db/types.js';
import { loadOrCreateCredentialKey } from './credential-key.js';
import { openSecret, sealSecret } from './secret-box.js';

/**
 * Every service key provider, with what it is for. `injectedAtSpawn: false` is
 * a literal type: a provider that ever needed to reach a spawned session would
 * be an agent credential and belongs in `CREDENTIAL_PROVIDERS`, not here.
 */
export const SERVICE_KEY_PROVIDERS: Readonly<Record<ServiceKeyProviderName, {
  readonly usedBy: 'launch.suggest';
  readonly injectedAtSpawn: false;
  /** The node-wide fallback a member without a key of their own gets. */
  readonly nodeEnvVar: string;
}>> = Object.freeze({
  typesafe: { usedBy: 'launch.suggest', injectedAtSpawn: false, nodeEnvVar: 'TYPESAFE_API_KEY' },
});

export const SERVICE_KEY_PROVIDER_NAMES = Object.keys(SERVICE_KEY_PROVIDERS) as ServiceKeyProviderName[];

/** How many trailing characters the screen may show. */
export const SERVICE_KEY_HINT_LENGTH = 4;

export interface StoredServiceKeyStatus {
  provider: ServiceKeyProviderName;
  keyHint: string;
  updatedAt: string;
}

interface StatusRow {
  provider: string;
  key_hint: string;
  updated_at: Date | string;
}

interface SealedRow {
  accountId: string;
  provider: string;
  keyCiphertext: string;
  keyNonce: string;
}

interface AccountRow {
  account_id: string | null;
}

export interface DbServiceKeyStoreOptions {
  db: Db;
  dataDir: string;
  logger?: { warn?: (message: string, fields?: Record<string, unknown>) => void };
}

export class DbServiceKeyStore {
  private readonly db: Db;
  private readonly dataDir: string;
  private readonly logger: DbServiceKeyStoreOptions['logger'];

  constructor(options: DbServiceKeyStoreOptions) {
    this.db = options.db;
    this.dataDir = options.dataDir;
    this.logger = options.logger;
  }

  /** Whether 203 is applied on this node. Absent is "unknown", never "no key". */
  async present(claims: DbClaims): Promise<boolean> {
    const [row] = await this.db.query<{ present: boolean }>(
      claims,
      `select to_regclass('public.account_service_keys') is not null as present`,
    );
    return row?.present === true;
  }

  /** The caller's stored keys: provider, hint and time only — no secret column is selected, or grantable. */
  async status(claims: DbClaims): Promise<StoredServiceKeyStatus[]> {
    const rows = await this.db.query<StatusRow>(
      claims,
      'select provider, key_hint, updated_at from public.account_service_keys',
    );
    return rows.map((row) => ({
      provider: row.provider as ServiceKeyProviderName,
      keyHint: row.key_hint,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    }));
  }

  /** Seal and store (or replace) the caller's key. The account is derived by the RPC. */
  async put(claims: DbClaims, provider: ServiceKeyProviderName, apiKey: string): Promise<StoredServiceKeyStatus> {
    const key = apiKey.trim();
    if (key.length < SERVICE_KEY_HINT_LENGTH) {
      // Neither the value nor its length is echoed.
      throw new Error('service key is too short');
    }
    const [account] = await this.db.query<AccountRow>(claims, 'select internal.current_account_id() as account_id');
    const accountId = account?.account_id ?? null;
    if (!accountId) throw new Error('no active account for this identity');

    const sealed = sealSecret(await loadOrCreateCredentialKey(this.dataDir), key, { accountId, provider });
    const stored = await this.db.rpc<{ provider: string; keyHint: string; updatedAt: string }>(
      claims,
      'set_account_service_key',
      [provider, key.slice(-SERVICE_KEY_HINT_LENGTH), sealed.ciphertext, sealed.nonce],
    );
    return { provider, keyHint: stored.keyHint, updatedAt: String(stored.updatedAt) };
  }

  /** Idempotent. Returns whether a row was removed. */
  async delete(claims: DbClaims, provider: ServiceKeyProviderName): Promise<boolean> {
    const result = await this.db.rpc<{ deleted: boolean }>(claims, 'delete_account_service_key', [provider]);
    return result?.deleted === true;
  }

  /**
   * The caller's OWN plaintext key, or null when they have none. The RPC
   * derives the account from the caller's claims and takes no account id, so
   * there is no way to ask for another member's key.
   */
  async resolve(claims: DbClaims, provider: ServiceKeyProviderName): Promise<string | null> {
    const row = await this.db.rpc<SealedRow | null>(claims, 'read_account_service_key', [provider]);
    if (!row) return null;
    try {
      return openSecret(
        await loadOrCreateCredentialKey(this.dataDir),
        { ciphertext: Buffer.from(row.keyCiphertext, 'base64'), nonce: Buffer.from(row.keyNonce, 'base64') },
        { accountId: row.accountId, provider: row.provider },
      );
    } catch (error) {
      this.logger?.warn?.('service key could not be decrypted', {
        provider: row.provider,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      throw new Error('stored service key is unreadable');
    }
  }
}
