/** AES-256-GCM sealing for string-shaped third-party credentials. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const SECRET_KEY_BYTES = 32;
export const SECRET_NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface SealedSecret {
  /** ciphertext || authentication tag. */
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
}

/** A member's credential (079, 203): AAD `<account_id>|<provider>`. */
export interface AccountSecretBinding {
  readonly accountId: string;
  readonly provider: string;
}

/**
 * A space credential (206): AAD `<space_id>|<credential_id>|<provider>`. Two
 * separators against the account form's one, so the two binding spaces cannot
 * collide: an account-bound ciphertext never opens as a space one, or back.
 */
export interface SpaceSecretBinding {
  readonly spaceId: string;
  readonly credentialId: string;
  readonly provider: string;
}

/**
 * A member's stored space-link session (251): AAD
 * `<home_space_id>|<link_id>|<member_id>|<target_space_id>`. Three separators,
 * so it collides with neither the account form (one) nor the space form (two):
 * a link ciphertext copied to another row, member or target does not open.
 */
export interface SpaceLinkSecretBinding {
  readonly homeSpaceId: string;
  readonly linkId: string;
  readonly memberId: string;
  readonly targetSpaceId: string;
}

/**
 * A member's gate session on a remote server (W8): AAD
 * `server-gate|<home_space_id>|<server_id>|<member_id>`. The literal prefix
 * keeps it apart from every other form, whatever the ids hold.
 */
export interface ServerGateSecretBinding {
  readonly homeSpaceId: string;
  readonly serverId: string;
  readonly memberId: string;
}

/**
 * An MCP connection sealed under a NAMED key (§5.2, §9.4): AAD
 * `mcp-key|<key_id>|<space_id>|<credential_id>|<provider>`.
 *
 * The literal prefix is load-bearing. Every form above separates its domain by
 * SEPARATOR COUNT, so appending the key id to the space form would give three
 * separators and collide with the space-link form. The prefix keeps it apart
 * whatever the ids hold, exactly as the server-gate form does.
 *
 * Binding the key id means an attacker who can write `space_credentials.key_id`
 * still cannot make the server open a ciphertext under a different key: the tag
 * check fails. A row whose `key_id` is NULL was sealed before the column existed
 * and keeps the unkeyed `SpaceSecretBinding` form — the OPENER picks the form
 * from the column and never tries one and then the other.
 */
export interface KeyedSpaceSecretBinding {
  readonly keyId: string;
  readonly spaceId: string;
  readonly credentialId: string;
  readonly provider: string;
}

/**
 * A pending MCP OAuth sign-in (§5.4, migration 342): AAD
 * `mcp-oauth|<key_id>|<state_hash>|<identity_id>|<space_id>|<server_id>|<scope>|<definition_version>|<return_to>`.
 * Literal prefix, like the keyed and server-gate forms. It binds the sealed
 * verifier, client and token endpoint to the row's state hash, its owner, its
 * connector, its scope, the connector revision begin saw and its return path, so
 * no column of `internal.mcp_oauth_pending` can be rewritten — not even to slip
 * past the "connector changed" guard — and still open. `-` is "none"; the
 * return path is percent-encoded, so it can never carry the separator.
 */
export interface OAuthPendingSecretBinding {
  readonly keyId: string;
  /** Hex sha256 of the `state` the provider echoes back. */
  readonly stateHash: string;
  readonly identityId: string;
  readonly spaceId: string;
  readonly serverId: string;
  readonly scope: string;
  /** The connector revision begin saw; null when the definition had none. */
  readonly definitionVersion: number | null;
  /** Where a same-tab sign-in returns to; null when none was given. */
  readonly returnTo: string | null;
}

/**
 * A phone's push token (392 `public.devices`): AAD
 * `push-device|<identity_id>|<token_hash>`. Literal prefix, like the
 * server-gate and keyed forms, so it collides with no other form whatever the
 * ids hold. Binding the token's own sha256 pins the ciphertext to the row's
 * `token_hash`, the column a dead-token report deletes by: a ciphertext moved to
 * another person's row, or paired with another token's hash, does not open.
 * `devices/device-token.ts` is the only module that builds one.
 */
export interface DeviceTokenSecretBinding {
  readonly identityId: string;
  /** Hex sha256 of the push token. */
  readonly tokenHash: string;
}

export type SecretBinding =
  | AccountSecretBinding | SpaceSecretBinding | SpaceLinkSecretBinding | ServerGateSecretBinding
  | KeyedSpaceSecretBinding | OAuthPendingSecretBinding | DeviceTokenSecretBinding;

/** The AAD string for `binding`; for a link or server gate, the value its `aad` column holds. */
export function bindingAad(binding: SecretBinding): string {
  if ('stateHash' in binding) {
    const parts = [binding.keyId, binding.stateHash, binding.identityId, binding.spaceId, binding.serverId, binding.scope,
      binding.definitionVersion === null ? '-' : String(binding.definitionVersion),
      binding.returnTo === null ? '-' : encodeURIComponent(binding.returnTo)];
    if (parts.some(part => part.includes('|'))) throw new Error('secret binding part must not contain "|"');
    return `mcp-oauth|${parts.join('|')}`;
  }
  if ('tokenHash' in binding) {
    if (binding.identityId.includes('|')) throw new Error('secret binding identity id must not contain "|"');
    if (!/^[a-f0-9]{64}$/.test(binding.tokenHash)) throw new Error('secret binding token hash must be 64 hex characters');
    return `push-device|${binding.identityId}|${binding.tokenHash}`;
  }
  if ('keyId' in binding) {
    if (binding.keyId.includes('|')) throw new Error('secret binding key id must not contain "|"');
    if (binding.provider.includes('|')) throw new Error('secret binding provider must not contain "|"');
    return `mcp-key|${binding.keyId}|${binding.spaceId}|${binding.credentialId}|${binding.provider}`;
  }
  if ('serverId' in binding) {
    return `server-gate|${binding.homeSpaceId}|${binding.serverId}|${binding.memberId}`;
  }
  if ('linkId' in binding) {
    return `${binding.homeSpaceId}|${binding.linkId}|${binding.memberId}|${binding.targetSpaceId}`;
  }
  // The separator count IS the domain separation between the three forms, so
  // a provider carrying `|` could make an account AAD read as a space or link
  // one. Every sealed table pins its provider to a closed, `|`-free list
  // (space-links.pg asserts it); this refuses the rest before sealing/opening.
  if (binding.provider.includes('|')) throw new Error('secret binding provider must not contain "|"');
  return 'spaceId' in binding
    ? `${binding.spaceId}|${binding.credentialId}|${binding.provider}`
    : `${binding.accountId}|${binding.provider}`;
}

function bindingBytes(binding: SecretBinding): Buffer {
  return Buffer.from(bindingAad(binding), 'utf8');
}

function assertKey(key: Buffer): void {
  if (key.length !== SECRET_KEY_BYTES) {
    throw new Error(`credential key must be ${String(SECRET_KEY_BYTES)} bytes`);
  }
}

export function sealSecret(
  key: Buffer,
  plaintext: string,
  binding: SecretBinding,
): SealedSecret {
  assertKey(key);
  const nonce = randomBytes(SECRET_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(bindingBytes(binding));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

export function openSecret(
  key: Buffer,
  sealed: SealedSecret,
  binding: SecretBinding,
): string {
  assertKey(key);
  if (sealed.nonce.length !== SECRET_NONCE_BYTES) {
    throw new Error('sealed credential has a malformed nonce');
  }
  if (sealed.ciphertext.length <= AUTH_TAG_BYTES) {
    throw new Error('sealed credential is too short to carry an authentication tag');
  }

  const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - AUTH_TAG_BYTES);
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - AUTH_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce);
  decipher.setAAD(bindingBytes(binding));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
