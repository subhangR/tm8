import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  CollabError,
  FILE_MAX_SIZE_BYTES_DEFAULT,
  SHA256_HEX_RE,
} from '@tm8/contract';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STORAGE_PATH_RE = /^(spaces)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const GRANT_KEY_FILE = '.file-upload-grant.key';
const GRANT_KEY_BYTES = 32;

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === code;
}

function uuid(value: string, field: string): string {
  const normalized = value.toLowerCase();
  if (!UUID_RE.test(normalized)) {
    throw new CollabError('invalid_input', `${field} must be a uuid`);
  }
  return normalized;
}

function checksum(value: string): string {
  if (!SHA256_HEX_RE.test(value)) {
    throw new CollabError('invalid_input', 'checksum must be a lowercase sha-256 digest');
  }
  return value;
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export interface W2BlobStoreOptions {
  readonly dataDir: string;
  readonly maxSizeBytes?: number;
}

export interface WriteUploadInput {
  readonly stream: AsyncIterable<Uint8Array>;
  readonly storagePath: string;
  readonly expectedSpaceId: string;
  readonly expectedSizeBytes: number;
  readonly expectedChecksumSha256: string;
  /** Internal content-addressed stores may preserve a zero-byte file. */
  readonly allowEmpty?: boolean;
}

export interface VerifiedBlob {
  readonly sizeBytes: number;
  readonly checksumSha256: string;
}

/**
 * The one filesystem authority for G07.
 *
 * Callers pass only database storage keys in the frozen
 * `spaces/<spaceId>/<server uuid>` shape. Client filenames never reach a path
 * API, and every directory is realpath-checked before I/O so a local symlink
 * cannot turn an otherwise-valid storage key into an escape from dataDir.
 */
export class W2BlobStore {
  readonly dataDir: string;
  readonly blobRoot: string;
  readonly maxSizeBytes: number;

  private grantKeyPromise: Promise<Buffer> | undefined;

  constructor(options: W2BlobStoreOptions) {
    this.dataDir = resolve(options.dataDir);
    this.blobRoot = resolve(this.dataDir, 'blobs');
    const max = options.maxSizeBytes ?? FILE_MAX_SIZE_BYTES_DEFAULT;
    if (!Number.isSafeInteger(max) || max <= 0) {
      throw new Error(`file max size must be a positive safe integer`);
    }
    this.maxSizeBytes = max;
    if (!contained(this.dataDir, this.blobRoot)) {
      throw new Error('blob root must resolve beneath dataDir');
    }
  }

  storagePath(spaceId: string, blobId: string): string {
    return `spaces/${uuid(spaceId, 'spaceId')}/${uuid(blobId, 'blobId')}`;
  }

  async grantToken(uploadId: string): Promise<string> {
    const key = await this.grantKey();
    return createHmac('sha256', key)
      .update(`tm8:file-upload:${uuid(uploadId, 'uploadId')}`, 'utf8')
      .digest('base64url');
  }

  async writeUpload(input: WriteUploadInput): Promise<VerifiedBlob> {
    const expectedSize = input.expectedSizeBytes;
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || (!input.allowEmpty && expectedSize === 0)) {
      throw new CollabError(
        'invalid_input',
        input.allowEmpty
          ? 'declared upload size must be a non-negative integer'
          : 'declared upload size must be a positive integer',
      );
    }
    if (expectedSize > this.maxSizeBytes) {
      throw new CollabError('payload_too_large', 'declared upload exceeds the file size limit');
    }
    const expectedChecksum = checksum(input.expectedChecksumSha256);
    const path = await this.resolveStoragePath(input.storagePath, input.expectedSpaceId);
    const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.upload`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let linked = false;

    try {
      handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      const hash = createHash('sha256');
      let total = 0;
      let overflowed = false;

      for await (const value of input.stream) {
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > expectedSize || total > this.maxSizeBytes) {
          overflowed = true;
          continue;
        }
        hash.update(chunk);
        await handle.writeFile(chunk);
      }

      if (overflowed) {
        throw new CollabError('payload_too_large', 'uploaded bytes exceed the declared or maximum size');
      }
      if (total !== expectedSize) {
        throw new CollabError('invalid_input', 'uploaded bytes are incomplete');
      }
      const actualChecksum = hash.digest('hex');
      if (actualChecksum !== expectedChecksum) {
        throw new CollabError('invalid_input', 'uploaded bytes do not match the declared checksum');
      }

      await handle.sync();
      await handle.close();
      handle = undefined;

      // A same-directory hard link is an atomic no-overwrite publication.
      // `rename` would silently replace an already-staged blob on POSIX.
      await link(temp, path);
      linked = true;
      await unlink(temp);
      return { sizeBytes: total, checksumSha256: actualChecksum };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      if (linked) await unlink(path).catch(() => undefined);
      if (isErrno(error, 'EEXIST')) {
        throw new CollabError('conflict', 'upload bytes are already staged');
      }
      throw error;
    }
  }

  async verify(
    storagePath: string,
    expectedSpaceId: string,
    expectedSizeBytes: number,
    expectedChecksumSha256: string,
  ): Promise<VerifiedBlob> {
    const path = await this.resolveStoragePath(storagePath, expectedSpaceId);
    const expectedChecksum = checksum(expectedChecksumSha256);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      if (!info.isFile() || info.size !== expectedSizeBytes) {
        throw new CollabError('invalid_input', 'uploaded bytes are incomplete');
      }
      const hash = createHash('sha256');
      const stream = handle.createReadStream({ autoClose: false });
      for await (const chunk of stream) hash.update(chunk as Buffer);
      const actualChecksum = hash.digest('hex');
      if (actualChecksum !== expectedChecksum) {
        throw new CollabError('invalid_input', 'uploaded bytes do not match the declared checksum');
      }
      return { sizeBytes: info.size, checksumSha256: actualChecksum };
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        throw new CollabError('not_found', 'uploaded bytes are not available');
      }
      if (isErrno(error, 'ELOOP')) {
        throw new CollabError('invalid_input', 'blob path may not be a symbolic link');
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async read(storagePath: string, expectedSpaceId: string): Promise<Buffer> {
    const path = await this.resolveStoragePath(storagePath, expectedSpaceId);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      if (!info.isFile()) throw new CollabError('not_found', 'blob is not a regular file');
      return await handle.readFile();
    } catch (error) {
      if (isErrno(error, 'ENOENT')) throw new CollabError('not_found', 'blob bytes are not available');
      if (isErrno(error, 'ELOOP')) throw new CollabError('invalid_input', 'blob path may not be a symbolic link');
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async remove(storagePath: string, expectedSpaceId: string): Promise<void> {
    const path = await this.resolveStoragePath(storagePath, expectedSpaceId);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new CollabError('invalid_input', 'blob cleanup target is not a regular file');
      }
      await unlink(path);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return;
      throw error;
    }
  }

  private async resolveStoragePath(storagePath: string, expectedSpaceId: string): Promise<string> {
    const match = STORAGE_PATH_RE.exec(storagePath);
    const expectedSpace = uuid(expectedSpaceId, 'spaceId');
    if (!match || match[2] !== expectedSpace) {
      throw new CollabError('invalid_input', 'invalid or cross-Space blob storage path');
    }

    const root = await this.ensureSpaceDirectory(expectedSpace);
    const path = resolve(root, match[3]!);
    if (!contained(root, path) || dirname(path) !== root) {
      throw new CollabError('invalid_input', 'blob storage path escapes its Space directory');
    }
    return path;
  }

  private async ensureSpaceDirectory(spaceId: string): Promise<string> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.dataDir, 0o700);
    await mkdir(this.blobRoot, { recursive: true, mode: 0o700 });
    const dataReal = await realpath(this.dataDir);
    const rootReal = await realpath(this.blobRoot);
    if (rootReal !== resolve(dataReal, 'blobs')) {
      throw new CollabError('invalid_input', 'blob root escapes the data directory');
    }
    const spacesDir = resolve(this.blobRoot, 'spaces');
    await mkdir(spacesDir, { recursive: true, mode: 0o700 });
    const spacesReal = await realpath(spacesDir);
    if (spacesReal !== resolve(rootReal, 'spaces')) {
      throw new CollabError('invalid_input', 'blob spaces directory escapes the blob root');
    }

    const spaceDir = resolve(spacesDir, spaceId);
    await mkdir(spaceDir, { recursive: true, mode: 0o700 });
    const spaceReal = await realpath(spaceDir);
    if (spaceReal !== resolve(spacesReal, spaceId)) {
      throw new CollabError('invalid_input', 'blob Space directory escapes the blob root');
    }
    return spaceReal;
  }

  private grantKey(): Promise<Buffer> {
    this.grantKeyPromise ??= this.loadOrCreateGrantKey();
    return this.grantKeyPromise;
  }

  private async loadOrCreateGrantKey(): Promise<Buffer> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.dataDir, 0o700);
    const path = join(this.dataDir, GRANT_KEY_FILE);
    try {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        const key = randomBytes(GRANT_KEY_BYTES);
        await handle.writeFile(key);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }
    const key = await readFile(path);
    if (key.length !== GRANT_KEY_BYTES) {
      throw new Error('file upload grant key has an invalid length');
    }
    return key;
  }
}

export function createW2BlobStore(options: W2BlobStoreOptions): W2BlobStore {
  return new W2BlobStore(options);
}
