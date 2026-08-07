/**
 * The node's credential-encryption key: 32 random bytes in a 0600 file under
 * the server's data directory, and the ONLY thing that can turn a stored
 * `account_git_credentials` row back into a token.
 *
 * This is a deliberate copy of `loadOrCreateGrantKey` in
 * `../files/w2-blob-store.ts`, not a shared abstraction, and the duplication is
 * the point: the two keys must never become one. A single key would mean a
 * file-upload grant forgery and a stolen GitHub token are the same compromise.
 *
 * `O_CREAT | O_EXCL` is what makes concurrent first-boot safe — two processes
 * racing to create it produce one key, not two, and the loser reads the winner's
 * bytes instead of overwriting them. Memoised per data directory because the
 * key is read on every spawn, and a filesystem read per spawn is a syscall this
 * process does not need to repeat.
 */
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { SECRET_KEY_BYTES } from './secret-box.js';

/** Sits beside `.file-upload-grant.key`, and is never the same key. */
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
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, KEY_FILE_MODE);
    try {
      await handle.writeFile(randomBytes(SECRET_KEY_BYTES));
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error;
  }

  // Repair a key file that predates this mode, or that an operator copied in
  // with a permissive umask. Fail-closed would be worse than fixing it: a node
  // that refuses to boot because of its own historical file mode helps nobody.
  const info = await stat(path);
  if ((info.mode & 0o777) !== KEY_FILE_MODE) await chmod(path, KEY_FILE_MODE);

  const key = await readFile(path);
  if (key.length !== SECRET_KEY_BYTES) {
    throw new Error(`credential key at ${path} has an invalid length`);
  }
  return key;
}

/**
 * Resolve this node's credential key, creating it on first use.
 *
 * Rejects rather than silently generating a fresh key when the file exists but
 * is the wrong size — regenerating would render every stored credential
 * undecryptable while looking like a successful boot.
 */
export function loadOrCreateCredentialKey(dataDir: string): Promise<Buffer> {
  const existing = cache.get(dataDir);
  if (existing) return existing;
  const pending = create(dataDir).catch((error: unknown) => {
    // A failed load must not be cached: the next attempt should retry the disk,
    // not replay an error from a transient condition that has since cleared.
    cache.delete(dataDir);
    throw error;
  });
  cache.set(dataDir, pending);
  return pending;
}

/** Test seam. Production never needs to forget a key it already read. */
export function resetCredentialKeyCache(): void {
  cache.clear();
}
