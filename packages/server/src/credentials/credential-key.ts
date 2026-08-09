/** Node-local 0600 key for the staging-compatible GitHub credential store. */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { SECRET_KEY_BYTES } from './secret-box.js';

export const CREDENTIAL_KEY_FILE = '.git-credential.key';
const KEY_FILE_MODE = 0o600;
const DATA_DIR_MODE = 0o700;
const cache = new Map<string, Promise<Buffer>>();

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === code;
}

export function credentialKeyPath(dataDir: string): string {
  return join(dataDir, CREDENTIAL_KEY_FILE);
}

async function create(dataDir: string): Promise<Buffer> {
  await mkdir(dataDir, { recursive: true, mode: DATA_DIR_MODE });
  await chmod(dataDir, DATA_DIR_MODE);
  const path = credentialKeyPath(dataDir);
  try {
    const handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      KEY_FILE_MODE,
    );
    try {
      await handle.writeFile(randomBytes(SECRET_KEY_BYTES));
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error;
  }

  const info = await stat(path);
  if ((info.mode & 0o777) !== KEY_FILE_MODE) await chmod(path, KEY_FILE_MODE);
  const key = await readFile(path);
  if (key.length !== SECRET_KEY_BYTES) {
    throw new Error(`credential key at ${path} has an invalid length`);
  }
  return key;
}

export function loadOrCreateCredentialKey(dataDir: string): Promise<Buffer> {
  const existing = cache.get(dataDir);
  if (existing) return existing;
  const pending = create(dataDir).catch((error: unknown) => {
    cache.delete(dataDir);
    throw error;
  });
  cache.set(dataDir, pending);
  return pending;
}

export function resetCredentialKeyCache(): void {
  cache.clear();
}
