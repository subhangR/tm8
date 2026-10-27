/**
 * The KeyProvider seam (plan §9.4, gap G12).
 *
 * Every MCP ciphertext now records WHICH key sealed it, in `space_credentials.key_id`
 * and inside the AAD, so a key can be rotated — and a KMS or Vault backend added —
 * without re-encrypting the table in one shot. Only `local` is implemented: it is the
 * node key `<dataDir>/.git-credential.key` that `credential-key.ts` already owns.
 *
 * THE FOUR RULES THIS FILE EXISTS TO HOLD
 *
 * 1. A row's key is chosen by its `key_id`, never guessed. `keyFor(null)` is the
 *    legacy local key and `keyFor('local:v1')` is the same bytes; they differ only in
 *    which AAD form the caller must use (see `mcpSecretBinding`). Nothing ever tries
 *    one key or form and then falls back to the other — a failure to open is a
 *    failure, because silent fallback is how an attacker gets an oracle.
 * 2. An UNKNOWN key id is refused, loudly, before any crypto runs. A new backend adds
 *    its id here and to `space_credentials_key_id_check` (migration 341) together.
 * 3. `activeKeyId` is what new and re-sealed rows get. Rotation means: point this at a
 *    new id, and every row upgrades the next time it is written.
 * 4. Envelope encryption (a wrapped DEK per Space) is explicitly NOT here yet. §9.4
 *    adds `wrap`/`unwrap` when the first remote backend lands; today a `local` provider
 *    would wrap with itself, which buys nothing and would have to be undone.
 */
import type { KeyedSpaceSecretBinding, SpaceSecretBinding } from './secret-box.js';
import { loadOrCreateCredentialKey } from './credential-key.js';

/** The node-local key, version 1. The only id `space_credentials.key_id` admits. */
export const LOCAL_KEY_ID = 'local:v1';
const KNOWN_KEY_IDS: readonly string[] = [LOCAL_KEY_ID];

export interface KeyProvider {
  /** The id new and re-sealed ciphertext is written under. */
  readonly activeKeyId: string;
  /**
   * The key bytes for `keyId`. `null`/`undefined` is a row sealed before key ids
   * existed, which is the local key under the legacy AAD.
   */
  keyFor(keyId: string | null | undefined): Promise<Buffer>;
}

export function isKnownKeyId(keyId: string): boolean {
  return KNOWN_KEY_IDS.includes(keyId);
}

/** The only backend today (§9.4: `aws-kms` and `vault-transit` come later). */
export function localKeyProvider(dataDir: string): KeyProvider {
  return {
    activeKeyId: LOCAL_KEY_ID,
    async keyFor(keyId) {
      // Rule 2. A row carrying an id this node does not know must never be opened
      // with whatever key happens to be at hand.
      if (keyId !== null && keyId !== undefined && !isKnownKeyId(keyId)) {
        throw new Error(`unknown credential key id: ${keyId}`);
      }
      return loadOrCreateCredentialKey(dataDir);
    },
  };
}

/**
 * The AAD form for an MCP connection, chosen by the row's `key_id` (rule 1):
 * keyed when it has one, and the pre-341 unkeyed space form when it does not.
 */
export function mcpSecretBinding(
  binding: { spaceId: string; credentialId: string },
  keyId: string | null | undefined,
): KeyedSpaceSecretBinding | SpaceSecretBinding {
  const base = { spaceId: binding.spaceId, credentialId: binding.credentialId, provider: 'mcp' as const };
  return keyId === null || keyId === undefined ? base : { keyId, ...base };
}
