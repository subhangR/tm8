import { KmsRefusedError, KmsUnavailableError, type KmsProvider, type WrappedDek } from '../crypto/kms.js';
import { crc32c, matchesCrc32c } from './crc32c.js';
import { baseUrl, decodeBase64, jsonObject, request, timeoutMs } from './http.js';
import type { TokenSource } from './token.js';

export interface KmsConnectionOptions {
  kmsBaseUrl?: string;
  tokens: TokenSource;
  timeoutMs?: number;
}

export function requireKeyName(name: string, version = false): void {
  const key = /^projects\/[A-Za-z0-9_-]+\/locations\/[A-Za-z0-9_-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+$/;
  const versioned = /^projects\/[A-Za-z0-9_-]+\/locations\/[A-Za-z0-9_-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+\/cryptoKeyVersions\/[1-9]\d*$/;
  if (!(version ? versioned : key).test(name)) throw new KmsRefusedError('KMS request refused');
}

/** Shared KMS status mapping; never retain an upstream exception as a cause. */
export class KmsClient {
  readonly #base: string;
  readonly #timeout: number;
  readonly #tokens: TokenSource;

  constructor(options: KmsConnectionOptions) {
    try {
      this.#base = baseUrl(options.kmsBaseUrl ?? 'https://cloudkms.googleapis.com');
      this.#timeout = timeoutMs(options.timeoutMs);
      this.#tokens = options.tokens;
    } catch { throw new KmsUnavailableError('KMS unavailable'); }
  }

  async call(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    let status: number;
    let bytes: Buffer;
    try {
      const response = await request({
        url: `${this.#base}/v1/${path}`, method, timeoutMs: this.#timeout, tokens: this.#tokens,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      status = response.status;
      bytes = response.bytes;
    } catch { throw new KmsUnavailableError('KMS unavailable'); }
    if ([400, 403, 404].includes(status)) throw new KmsRefusedError('KMS request refused');
    if (status < 200 || status >= 300) throw new KmsUnavailableError('KMS unavailable');
    try { return jsonObject(bytes); }
    catch { throw new KmsUnavailableError('KMS unavailable'); }
  }
}

export class GcpKmsProvider implements KmsProvider {
  readonly kind = 'gcp-kms' as const;
  readonly activeKekId: string;
  readonly #client: KmsClient;
  #productionGrade = false;

  private constructor(keyName: string, options: KmsConnectionOptions) {
    requireKeyName(keyName);
    this.activeKekId = keyName;
    this.#client = new KmsClient(options);
  }

  static async connect(options: KmsConnectionOptions & { keyName: string }): Promise<GcpKmsProvider> {
    const provider = new GcpKmsProvider(options.keyName, options);
    await provider.#readKey();
    return provider;
  }

  get productionGrade(): boolean { return this.#productionGrade; }

  async #readKey(): Promise<boolean> {
    const key = await this.#client.call(this.activeKekId, 'GET');
    const primary = key.primary;
    if (typeof key.purpose !== 'string' || !primary || typeof primary !== 'object' || Array.isArray(primary)) {
      throw new KmsUnavailableError('KMS unavailable');
    }
    const version = primary as Record<string, unknown>;
    const usable = key.purpose === 'ENCRYPT_DECRYPT' && version.state === 'ENABLED';
    this.#productionGrade = usable && version.protectionLevel === 'HSM';
    return usable;
  }

  async wrap(dek: Buffer, aad: Buffer): Promise<WrappedDek> {
    const result = await this.#client.call(`${this.activeKekId}:encrypt`, 'POST', {
      plaintext: dek.toString('base64'), additionalAuthenticatedData: aad.toString('base64'),
      plaintextCrc32c: String(crc32c(dek)), additionalAuthenticatedDataCrc32c: String(crc32c(aad)),
    });
    try {
      const ciphertext = decodeBase64(result.ciphertext);
      if (!ciphertext.length || result.verifiedPlaintextCrc32c !== true || result.verifiedAdditionalAuthenticatedDataCrc32c !== true ||
          !matchesCrc32c(ciphertext, result.ciphertextCrc32c)) throw new Error();
      return { kekId: this.activeKekId, ciphertext };
    } catch { throw new KmsUnavailableError('KMS unavailable'); }
  }

  async unwrap(wrapped: WrappedDek, aad: Buffer): Promise<Buffer> {
    if (wrapped.kekId !== this.activeKekId) throw new KmsRefusedError('KMS request refused');
    const result = await this.#client.call(`${this.activeKekId}:decrypt`, 'POST', {
      ciphertext: wrapped.ciphertext.toString('base64'), additionalAuthenticatedData: aad.toString('base64'),
      ciphertextCrc32c: String(crc32c(wrapped.ciphertext)), additionalAuthenticatedDataCrc32c: String(crc32c(aad)),
    });
    let plaintext: Buffer | undefined;
    try {
      plaintext = decodeBase64(result.plaintext);
      if (!matchesCrc32c(plaintext, result.plaintextCrc32c)) throw new Error();
      return plaintext;
    } catch {
      plaintext?.fill(0);
      throw new KmsUnavailableError('KMS unavailable');
    }
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try { return { ok: await this.#readKey() }; }
    catch { this.#productionGrade = false; return { ok: false, detail: 'KMS unavailable' }; }
  }
}
