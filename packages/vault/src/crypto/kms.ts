import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import { zeroize } from '../secret-material.js';

/**
 * Key-encryption-key providers (brief MSG 4: "a KMS KEK that never leaves the KMS").
 *
 * The broker is the only process configured with a provider. A provider must
 * fail CLOSED: an unreachable KMS throws `KmsUnavailableError`, and the broker
 * turns that into vault "no-use mode" (failure case 5). Nothing buffers
 * plaintext while waiting for it.
 *
 * `productionGrade` is false for `local-dev`. The broker refuses to start a
 * non-production-grade provider unless the vault mode is `dev` or `pre_review`,
 * and `pre_review` holds test secrets only.
 */
export interface WrappedDek {
  kekId: string;
  ciphertext: Buffer;
}

export interface KmsProvider {
  readonly kind: 'local-dev' | 'gcp-kms' | 'vault-transit' | 'test-fake';
  readonly productionGrade: boolean;
  readonly activeKekId: string;
  wrap(dek: Buffer, aad: Buffer): Promise<WrappedDek>;
  unwrap(wrapped: WrappedDek, aad: Buffer): Promise<Buffer>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

export class KmsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KmsUnavailableError';
  }
}

export class KmsRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KmsRefusedError';
  }
}

const LOCAL_NONCE = 12;
const LOCAL_TAG = 16;

/**
 * DEVELOPMENT AND PRE-REVIEW ONLY. The KEK is a 32-byte file outside Postgres
 * and outside the DB backups, so acceptance test 14 (stolen DB plus backups
 * yields nothing) still holds structurally. The file sits on the broker host,
 * though, so anyone with that host has the key. That is why it is never
 * production-grade.
 */
export class LocalDevKms implements KmsProvider {
  readonly kind = 'local-dev' as const;
  readonly productionGrade = false;
  readonly activeKekId: string;
  #kek: Buffer;

  private constructor(kek: Buffer) {
    this.#kek = kek;
    const tag = createHmac('sha256', kek).update('tm8-vault-local-kek-id').digest('hex').slice(0, 16);
    this.activeKekId = `local-dev:${tag}`;
  }

  /** For tests: an in-memory KEK that dies with the process. */
  static ephemeral(): LocalDevKms {
    return new LocalDevKms(randomBytes(32));
  }

  /**
   * Loads the KEK from `path`, creating it (O_EXCL, 0600) when absent. The file
   * is refused when it is a symlink, has the wrong size, or is readable by
   * anyone but its owner.
   */
  static fromFile(path: string): LocalDevKms {
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const created = randomBytes(32);
      const out = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        writeSync(out, created);
      } finally {
        closeSync(out);
      }
      return new LocalDevKms(created);
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== 32) throw new KmsRefusedError('local KEK file must be a 32-byte regular file');
      if ((stat.mode & 0o077) !== 0) throw new KmsRefusedError('local KEK file must not be group- or world-accessible');
      const kek = Buffer.alloc(32);
      if (readSync(fd, kek, 0, 32, 0) !== 32) throw new KmsRefusedError('short read on local KEK file');
      return new LocalDevKms(kek);
    } finally {
      closeSync(fd);
    }
  }

  async wrap(dek: Buffer, aad: Buffer): Promise<WrappedDek> {
    const nonce = randomBytes(LOCAL_NONCE);
    const cipher = createCipheriv('aes-256-gcm', this.#kek, nonce, { authTagLength: LOCAL_TAG });
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(dek), cipher.final()]);
    return { kekId: this.activeKekId, ciphertext: Buffer.concat([nonce, body, cipher.getAuthTag()]) };
  }

  async unwrap(wrapped: WrappedDek, aad: Buffer): Promise<Buffer> {
    if (wrapped.kekId !== this.activeKekId) throw new KmsRefusedError('unknown KEK id');
    const raw = wrapped.ciphertext;
    if (raw.length !== LOCAL_NONCE + 32 + LOCAL_TAG) throw new KmsRefusedError('malformed wrapped DEK');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#kek, raw.subarray(0, LOCAL_NONCE), { authTagLength: LOCAL_TAG });
      decipher.setAAD(aad);
      decipher.setAuthTag(raw.subarray(raw.length - LOCAL_TAG));
      return Buffer.concat([decipher.update(raw.subarray(LOCAL_NONCE, raw.length - LOCAL_TAG)), decipher.final()]);
    } catch {
      throw new KmsRefusedError('wrapped DEK failed authentication');
    }
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: 'local-dev KEK (not production-grade)' };
  }

  /** Test hook: forget the KEK, as if the KMS were gone. */
  destroyForTest(): void {
    zeroize(this.#kek);
    this.#kek = randomBytes(32);
  }
}

/** A provider that is down. For failure-case 5 tests and for the broker's no-use mode. */
export class UnavailableKms implements KmsProvider {
  readonly kind = 'test-fake' as const;
  readonly productionGrade = false;
  constructor(readonly activeKekId = 'unavailable') {}
  async wrap(): Promise<WrappedDek> {
    throw new KmsUnavailableError('KMS unavailable');
  }
  async unwrap(): Promise<Buffer> {
    throw new KmsUnavailableError('KMS unavailable');
  }
  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: false, detail: 'KMS unavailable' };
  }
}
