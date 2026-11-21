import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { CheckpointSigner } from '../core-types.js';
import { KmsRefusedError, KmsUnavailableError } from '../crypto/kms.js';
import { crc32c, matchesCrc32c } from './crc32c.js';
import { decodeBase64 } from './http.js';
import { KmsClient, requireKeyName, type KmsConnectionOptions } from './kms.js';

export type CheckpointKeyAlgorithm = 'EC_SIGN_ED25519' | 'EC_SIGN_P256_SHA256';

export class KmsCheckpointSigner implements CheckpointSigner {
  readonly keyId: string;
  readonly #client: KmsClient;
  readonly #pem: string;
  readonly #algorithm: CheckpointKeyAlgorithm;
  readonly #key: KeyObject;

  private constructor(keyId: string, client: KmsClient, pem: string, algorithm: CheckpointKeyAlgorithm, key: KeyObject) {
    this.keyId = keyId;
    this.#client = client;
    this.#pem = pem;
    this.#algorithm = algorithm;
    this.#key = key;
  }

  static async connect(options: KmsConnectionOptions & { keyVersionName: string }): Promise<KmsCheckpointSigner> {
    requireKeyName(options.keyVersionName, true);
    const client = new KmsClient(options);
    const result = await client.call(`${options.keyVersionName}/publicKey`, 'GET');
    if (result.algorithm !== 'EC_SIGN_ED25519' && result.algorithm !== 'EC_SIGN_P256_SHA256') {
      throw new KmsRefusedError('KMS request refused');
    }
    try {
      if (typeof result.pem !== 'string' || !matchesCrc32c(Buffer.from(result.pem), result.pemCrc32c) ||
          (result.name !== undefined && result.name !== options.keyVersionName)) throw new Error();
      const key = createPublicKey(result.pem);
      const expectedType = result.algorithm === 'EC_SIGN_ED25519' ? 'ed25519' : 'ec';
      if (key.asymmetricKeyType !== expectedType ||
          (expectedType === 'ec' && key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')) throw new Error();
      return new KmsCheckpointSigner(options.keyVersionName, client, result.pem, result.algorithm, key);
    } catch { throw new KmsUnavailableError('KMS unavailable'); }
  }

  publicKey(): { pem: string; algorithm: CheckpointKeyAlgorithm } {
    return { pem: this.#pem, algorithm: this.#algorithm };
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
