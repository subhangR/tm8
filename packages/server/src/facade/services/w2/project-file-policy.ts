import { basename, isAbsolute, relative, sep } from 'node:path';
import { realpath } from 'node:fs/promises';

/**
 * What a live filesystem browser must never hand out, even inside an allowed
 * root. The jail in `project-directories.ts` answers "is this path inside the
 * project?"; this module answers the different question "is this path a
 * SECRET?" — and the two are enforced independently, because a project working
 * directory legitimately contains its own `.env`.
 *
 * The policy is applied to the CANONICAL path (after symlink resolution), so
 * an innocently named symlink pointing at a secret is refused by what it
 * resolves to, not admitted by what it is called.
 */

/**
 * Directory names that mark everything beneath them as withheld. These are
 * credential homes: offering any file under them is offering a credential.
 */
const SECRET_DIRECTORY_SEGMENTS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.gcloud',
  '.kube',
  '.docker',
]);

/**
 * `.git` itself stays browsable — HEAD, refs and hooks are honest project
 * context — but these two files carry remotes-with-embedded-tokens and stored
 * credentials respectively.
 */
const SECRET_GIT_FILES = new Set(['config', 'credentials']);

/** Exact basenames that are secrets wherever they appear. */
const SECRET_BASENAMES = new Set([
  '.netrc',
  '.npmrc',
  '.pgpass',
  'credentials',
  'credentials.json',
  'service-account.json',
]);

/** Basename patterns that are secrets wherever they appear. */
const SECRET_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/, // .env, .env.local, .env.production — all of them
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/,
  /\.(pem|p12|pfx|keystore|jks)$/,
];

/**
 * Directory rows a listing omits: never secrets, but never useful in a picker,
 * and `node_modules` in particular turns a 500-row cap into pure noise.
 */
export const EXCLUDED_DIRECTORY_NAMES = new Set(['node_modules']);

export function isSecretBasename(name: string): boolean {
  return SECRET_BASENAMES.has(name) || SECRET_BASENAME_PATTERNS.some((p) => p.test(name));
}

/**
 * Why a canonical path is withheld, or null when it is not. `root` scopes the
 * segment walk so a secret-looking directory ABOVE the jail (say the root
 * itself lives under `/home/x/.aws-tools`) does not poison everything in it.
 */
export function secretReason(root: string, canonicalPath: string): string | null {
  const offset = relative(root, canonicalPath);
  const segments = offset === '' ? [] : offset.split(sep);
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (SECRET_DIRECTORY_SEGMENTS.has(segment)) {
      return `${segment} holds credentials`;
    }
    if (segment === '.git' && i + 1 < segments.length && SECRET_GIT_FILES.has(segments[i + 1]!)) {
      return `.git/${segments[i + 1]} can hold credentials`;
    }
  }
  const name = basename(canonicalPath);
  if (isSecretBasename(name)) return `${name} is a secret file`;
  return null;
}

let canonicalDataDir: { raw: string; resolved: string | null } | undefined;

/**
 * The node's own data directory — credential store, grant keys, session
 * manifests, blobs — is denied ALWAYS, independent of how roots are
 * configured: `TM8_PROJECT_ROOTS` defaults to the whole home directory, which
 * contains it. The ONE exception is `<dataDir>/worktrees`: tm8 itself
 * materializes agent worktrees there and links them as projects, so that
 * subtree is legitimate project ground.
 *
 * Resolved lazily and cached per raw value, because it never moves within a
 * process but tests point it somewhere scratch.
 */
export async function withinTm8DataDir(
  canonicalPath: string,
  rawDataDir: string | undefined = process.env.TM8_DATA_DIR,
): Promise<boolean> {
  const raw = rawDataDir ?? defaultDataDir();
  if (!raw || !isAbsolute(raw)) return false;
  if (canonicalDataDir?.raw !== raw) {
    let resolved: string | null;
    try {
      resolved = await realpath(raw);
    } catch {
      resolved = null; // A data dir that does not exist cannot be leaked from.
    }
    canonicalDataDir = { raw, resolved };
  }
  const resolved = canonicalDataDir.resolved;
  if (!resolved) return false;
  if (!contains(resolved, canonicalPath)) return false;
  return !contains(`${resolved}${sep}worktrees`, canonicalPath);
}

function contains(root: string, candidate: string): boolean {
  const offset = relative(root, candidate);
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset));
}

/** Mirrors packages/cli's default; the server config computes the same shape. */
function defaultDataDir(): string | undefined {
  const home = process.env.HOME;
  return home ? `${home}/.local/share/tm8/data` : undefined;
}

/** Test seam: forget the cached canonical data dir. */
export function resetDataDirCache(): void {
  canonicalDataDir = undefined;
}
