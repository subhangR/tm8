import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { CheckpointReadError, type CheckpointSigner, type CheckpointVerifier } from '../core-types.js';
import { KmsRefusedError, KmsUnavailableError } from '../crypto/kms.js';
import { crc32c, matchesCrc32c } from './crc32c.js';
import { decodeBase64 } from './http.js';
import { KmsClient, requireKeyName, type KmsConnectionOptions } from './kms.js';

export type CheckpointKeyAlgorithm = 'EC_SIGN_ED25519' | 'EC_SIGN_P256_SHA256';

interface VersionKey { pem: string; algorithm: CheckpointKeyAlgorithm; key: KeyObject }

/** Fetches and checks one cryptoKeyVersion's public key: algorithm, CRC32C, name and curve. */
async function readVersionKey(client: KmsClient, keyVersionName: string): Promise<VersionKey> {
  const result = await client.call(`${keyVersionName}/publicKey`, 'GET');
  if (result.algorithm !== 'EC_SIGN_ED25519' && result.algorithm !== 'EC_SIGN_P256_SHA256') {
    throw new KmsRefusedError('KMS request refused');
  }
  try {
    if (typeof result.pem !== 'string' || !matchesCrc32c(Buffer.from(result.pem), result.pemCrc32c) ||
        (result.name !== undefined && result.name !== keyVersionName)) throw new Error();
    const key = createPublicKey(result.pem);
    const expectedType = result.algorithm === 'EC_SIGN_ED25519' ? 'ed25519' : 'ec';
    if (key.asymmetricKeyType !== expectedType ||
        (expectedType === 'ec' && key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')) throw new Error();
    return { pem: result.pem, algorithm: result.algorithm, key };
  } catch { throw new KmsUnavailableError('KMS unavailable'); }
}

const cryptoKeyOf = (keyVersionName: string): string => keyVersionName.slice(0, keyVersionName.lastIndexOf('/cryptoKeyVersions/'));

export class KmsCheckpointSigner implements CheckpointSigner, CheckpointVerifier {
  readonly keyId: string;
  readonly #client: KmsClient;
  readonly #pem: string;
  readonly #algorithm: CheckpointKeyAlgorithm;
  readonly #key: KeyObject;
  /** Rotated-out versions of the same cryptoKey that signed an older retained checkpoint. */
  readonly #versions = new Map<string, VersionKey>();

  private constructor(keyId: string, client: KmsClient, version: VersionKey) {
    this.keyId = keyId;
    this.#client = client;
    this.#pem = version.pem;
    this.#algorithm = version.algorithm;
    this.#key = version.key;
  }

  static async connect(options: KmsConnectionOptions & { keyVersionName: string }): Promise<KmsCheckpointSigner> {
    requireKeyName(options.keyVersionName, true);
    const client = new KmsClient(options);
    return new KmsCheckpointSigner(options.keyVersionName, client, await readVersionKey(client, options.keyVersionName));
  }

  publicKey(): { pem: string; algorithm: CheckpointKeyAlgorithm } {
    return { pem: this.#pem, algorithm: this.#algorithm };
  }

  /**
   * Review F01. This signer vouches for its own version and for another
   * version of the same cryptoKey, whose public key it reads from KMS; any
   * other key id is false. A KMS outage is CheckpointReadError('unavailable').
   */
  async verify(keyId: string, input: Buffer, signature: Buffer): Promise<boolean> {
    let version: VersionKey | undefined = keyId === this.keyId
      ? { pem: this.#pem, algorithm: this.#algorithm, key: this.#key }
      : this.#versions.get(keyId);
    if (!version) {
      try { requireKeyName(keyId, true); } catch { return false; }
      if (cryptoKeyOf(keyId) !== cryptoKeyOf(this.keyId)) return false;
      try { version = await readVersionKey(this.#client, keyId); }
      catch (error) {
        if (error instanceof KmsRefusedError) return false;
        throw new CheckpointReadError('unavailable');
      }
      if (this.#versions.size >= 16) this.#versions.clear();
      this.#versions.set(keyId, version);
    }
    try { return verify(version.algorithm === 'EC_SIGN_ED25519' ? null : 'sha256', input, version.key, signature); }
    catch { return false; }
  }

  async sign(input: Buffer): Promise<Buffer> {
    const data = Buffer.from(input);
    try {
      const ed25519 = this.#algorithm === 'EC_SIGN_ED25519';
      const digest = ed25519 ? undefined : createHash('sha256').update(data).digest();
      const body = ed25519
        ? { data: data.toString('base64'), dataCrc32c: String(crc32c(data)) }
        : { digest: { sha256: digest!.toString('base64') }, digestCrc32c: String(crc32c(digest!)) };
      const result = await this.#client.call(`${this.keyId}:asymmetricSign`, 'POST', body);
      try {
        const signature = decodeBase64(result.signature);
        const verified = ed25519 ? result.verifiedDataCrc32c : result.verifiedDigestCrc32c;
        if (verified !== true || !signature.length || !matchesCrc32c(signature, result.signatureCrc32c) ||
            (result.name !== undefined && result.name !== this.keyId) ||
            !verify(ed25519 ? null : 'sha256', data, this.#key, signature)) throw new Error();
        return signature;
      } catch { throw new KmsUnavailableError('KMS unavailable'); }
    } finally { data.fill(0); }
  }
}
