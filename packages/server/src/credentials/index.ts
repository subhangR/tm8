/**
 * Third-party secret storage for one tm8 node. The whole module is two files:
 * a key that lives on disk and never in Postgres, and an AEAD that binds every
 * ciphertext to the row it belongs to. See db/migrations/079 for the threat
 * model these implement.
 */
export {
  CREDENTIAL_KEY_FILE,
  credentialKeyPath,
  loadOrCreateCredentialKey,
  resetCredentialKeyCache,
} from './credential-key.js';
export {
  SECRET_KEY_BYTES,
  SECRET_NONCE_BYTES,
  openSecret,
  sealSecret,
  secretsEqual,
  type SealedSecret,
  type SecretBinding,
} from './secret-box.js';
