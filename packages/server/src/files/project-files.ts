import { Dirent } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';

import {
  CollabError,
  type FileBrowseEntry,
  type FileBrowseView,
  type FileReadView,
  type FileRefusal,
  type FileRefusalReason,
} from '@tm8/contract';

/**
 * The node's REAL filesystem, root-jailed to one project's working directory.
 *
 * FILES-DESIGN §4. Four independent defenses, none of which relies on another
 * being correct:
 *   §4.1 containment  — realpath + separator-boundary prefix check
 *   §4.2 masking      — secret-named files are listed but never read
 *   §4.3 bounds       — entry cap, byte cap, and NEVER recursive
 *   §4.4 content-type — nothing is ever inline-able on the app origin
 *
 * Nothing here mints an entity or touches the blob store. These are pure reads.
 */

/** §4.3 — a directory answers at most this many entries, then says so. */
export const MAX_ENTRIES = 1000;

/** §4.3 — inline content ceiling. Above this the read refuses by name. */
export const MAX_INLINE_BYTES = 5 * 1024 * 1024;

/** Bytes sampled when deciding whether a file is binary. */
const BINARY_SNIFF_BYTES = 8192;

/**
 * §4.2 — files whose bytes are withheld even though they sit inside the jail.
 *
 * This is DEFENSE IN DEPTH, not a security boundary, and is not claimed as one:
 * the boundary is "only registered projects are browsable" (§3) plus containment
 * (§4.1). What this buys is that a browser UI does not turn "spawn an agent and
 * cat the file" into one click.
 *
 * Matched case-insensitively against the basename AND against every path
 * segment, so `.ssh/id_rsa` is caught by the directory as well as the file.
 */
const SECRET_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/i,             // .env, .env.local, .env.production
  /^\.ssh$/i,
  /^\.aws$/i,
  /^\.gnupg$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.pgpass$/i,
  /^\.git-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^.*(secret|credential)s?\.(json|ya?ml|toml|ini|txt|env)$/i,
  /^(secrets?|credentials?)$/i,
];

/**
 * `.git/config` carries push URLs, which routinely embed access tokens. The
 * whole `.git` directory is NOT masked — browsing history metadata is useful
 * and harmless — so this is matched on the full relative path, not a basename.
 */
const SECRET_PATHS: RegExp[] = [
  /(^|\/)\.git\/config$/i,
  /(^|\/)\.git\/credentials$/i,
];

const MIME_BY_EXT: Record<string, string> = {
  '.ts': 'text/x-typescript', '.tsx': 'text/x-typescript',
  '.js': 'text/javascript', '.jsx': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain',
  '.html': 'text/html', '.css': 'text/css', '.scss': 'text/x-scss',
  '.sql': 'application/sql', '.sh': 'application/x-sh', '.py': 'text/x-python',
  '.rs': 'text/x-rust', '.go': 'text/x-go', '.java': 'text/x-java',
  '.rb': 'text/x-ruby', '.yml': 'text/yaml', '.yaml': 'text/yaml',
  '.toml': 'text/x-toml', '.ini': 'text/plain', '.xml': 'application/xml',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

export function mimeForPath(path: string): string | null {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? null;
}

function refusal(reason: FileRefusalReason, detail: string): FileRefusal {
  return { reason, detail };
}

/** True when any segment of `relPath`, or the whole path, looks like a secret. */
export function isSecretPath(relPath: string): boolean {
  if (SECRET_PATHS.some((pattern) => pattern.test(relPath))) return true;
  return relPath
    .split('/')
    .filter((segment) => segment.length > 0)
    .some((segment) => SECRET_PATTERNS.some((pattern) => pattern.test(segment)));
}

/**
 * §4.1 step 2 — reject hostile shapes BEFORE the filesystem is touched.
 *
 * Answers a normalised, POSIX-separated, relative path; '' means the root.
 * Throws rather than sanitising: silently rewriting `../../etc` into something
 * safe would hide an attack from every log.
 */
export function normalizeRelPath(input: string | undefined | null): string {
  const raw = (input ?? '').trim();
  if (raw.length === 0) return '';
  if (raw.includes('\u0000')) {
    throw new CollabError('invalid_input', 'path contains a NUL byte');
  }
  // Windows separators are normalised first so `..\..` cannot slip past the
  // segment check on a POSIX host.
  const unified = raw.replace(/\\/g, '/');
  if (unified.startsWith('/')) {
    throw new CollabError('invalid_input', 'path must be relative to the project root');
  }
  const segments: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw new CollabError('invalid_input', 'path may not contain a ".." segment');
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * §4.1 steps 1, 3 and 4 — containment against the RESOLVED path.
 *
 * The separator boundary is the point of step 4: a jail of `/data/project` must
 * not admit `/data/project-secrets`, which a bare `startsWith` would accept.
 *
 * Resolving with `realpath` is what defeats a symlink pointing out of the tree —
 * a symlink is not refused for existing, only for ESCAPING.
 */
export async function resolveWithinRoot(
  rootReal: string,
  relPath: string,
): Promise<{ ok: true; absolute: string } | { ok: false; refusal: FileRefusal }> {
  const candidate = relPath.length === 0 ? rootReal : join(rootReal, relPath);
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, refusal: refusal('not-a-file', 'no such path in this project') };
    }
    if (code === 'ELOOP') {
      return { ok: false, refusal: refusal('outside-root', 'path is a symlink loop') };
    }
    return { ok: false, refusal: refusal('unreadable', 'path could not be resolved') };
  }
  if (resolved !== rootReal && !resolved.startsWith(rootReal + sep)) {
    // Deliberately does NOT echo `resolved` — telling a caller where their
    // symlink landed is a filesystem oracle for paths outside the jail.
    return {
      ok: false,
      refusal: refusal('outside-root', 'path resolves outside the project root'),
    };
  }
  return { ok: true, absolute: resolved };
}

/** Resolve the jail itself once. A project whose workingDir is gone says so. */
export async function resolveRoot(workingDir: string): Promise<string> {
  try {
    return await realpath(resolve(workingDir));
  } catch {
    throw new CollabError(
      'not_found',
      'the project working directory does not exist on this node',
    );
  }
}

function entryKind(dirent: Dirent): 'dir' | 'file' | 'other' {
  if (dirent.isDirectory()) return 'dir';
  if (dirent.isFile()) return 'file';
  return 'other';
}

/**
 * One directory. NEVER recursive (§4.3) — the client walks, exactly as a human
 * browsing does, so no single request can be made unbounded.
 */
export async function browseDirectory(
  rootReal: string,
  relPath: string,
): Promise<Omit<FileBrowseView, 'root'>> {
  const resolved = await resolveWithinRoot(rootReal, relPath);
  if (!resolved.ok) {
    throw new CollabError(
      resolved.refusal.reason === 'not-a-file' ? 'not_found' : 'forbidden',
      resolved.refusal.detail,
    );
  }

  let dirents: Dirent[];
  try {
    dirents = await readdir(resolved.absolute, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR') {
      throw new CollabError('invalid_input', 'that path is a file, not a directory');
    }
    if (code === 'EACCES') {
      throw new CollabError('forbidden', 'the node cannot read that directory');
    }
    throw new CollabError('not_found', 'no such directory in this project');
  }

  // Directories first, then case-insensitive by name — the ordering every file
  // browser uses, applied BEFORE the cap so truncation is deterministic rather
  // than dependent on the order the filesystem happened to return.
  dirents.sort((left, right) => {
    const leftDir = left.isDirectory() ? 0 : 1;
    const rightDir = right.isDirectory() ? 0 : 1;
    if (leftDir !== rightDir) return leftDir - rightDir;
    return left.name.localeCompare(right.name, 'en', { sensitivity: 'base' });
  });

  const totalEntries = dirents.length;
  const capped = dirents.slice(0, MAX_ENTRIES);

  const entries: FileBrowseEntry[] = await Promise.all(
    capped.map(async (dirent): Promise<FileBrowseEntry> => {
      const childRel = relPath.length === 0 ? dirent.name : `${relPath}/${dirent.name}`;
      const symlink = dirent.isSymbolicLink();
      const kind = entryKind(dirent);
      // lstat, never stat: metadata is reported for the LINK, so a symlink
      // pointing outside the jail never has its target measured here. Reading
      // it still goes through resolveWithinRoot and still refuses.
      let sizeBytes: number | null = null;
      let modifiedAt: string | null = null;
      try {
        const stats = await lstat(join(resolved.absolute, dirent.name));
        sizeBytes = kind === 'dir' ? null : stats.size;
        modifiedAt = stats.mtime.toISOString();
      } catch {
        // A file that vanished between readdir and lstat is reported without
        // metadata rather than failing the whole listing.
      }
      const masked = isSecretPath(childRel);
      return {
        name: dirent.name,
        kind,
        sizeBytes,
        modifiedAt,
        mimeType: kind === 'file' ? mimeForPath(dirent.name) : null,
        masked,
        maskReason: masked ? 'secret-pattern' : null,
        symlink,
      };
    }),
  );

  const parentPath =
    relPath.length === 0
      ? null
      : relPath.includes('/')
        ? relPath.slice(0, relPath.lastIndexOf('/'))
        : '';

  return {
    path: relPath,
    parentPath,
    entries,
    totalEntries,
    truncated: totalEntries > capped.length,
  };
}

/** A NUL in the first few KiB is the standard, cheap binary tell. */
function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

/**
 * One file's content, or a NAMED refusal (§5.1). Never a silent empty body: a
 * caller must be able to tell "this file is empty" from "you may not read it".
 */
export async function readFileContent(
  rootReal: string,
  relPath: string,
): Promise<FileReadView> {
  const empty = (
    refusalValue: FileRefusal,
    sizeBytes = 0,
  ): FileReadView => ({
    path: relPath,
    mimeType: mimeForPath(relPath),
    sizeBytes,
    encoding: 'none',
    text: null,
    base64: null,
    refusal: refusalValue,
  });

  // §4.2 is checked BEFORE the path is resolved, so a secret file's existence
  // is never confirmed or denied by the shape of the failure.
  if (isSecretPath(relPath)) {
    return empty(refusal('secret-pattern', 'this file is withheld by the secret-name policy'));
  }

  const resolved = await resolveWithinRoot(rootReal, relPath);
  if (!resolved.ok) return empty(resolved.refusal);

  let stats;
  try {
    stats = await lstat(resolved.absolute);
  } catch {
    return empty(refusal('unreadable', 'the file could not be measured'));
  }
  if (!stats.isFile()) {
    return empty(refusal('not-a-file', 'that path is not a regular file'));
  }
  if (stats.size > MAX_INLINE_BYTES) {
    return empty(
      refusal('too-large', `file is ${stats.size} bytes; the inline ceiling is ${MAX_INLINE_BYTES}`),
      stats.size,
    );
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(resolved.absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return empty(
      refusal('unreadable', code === 'EACCES' ? 'the node cannot read that file' : 'the file could not be read'),
      stats.size,
    );
  }

  const mimeType = mimeForPath(relPath);
  if (looksBinary(buffer)) {
    // Images/audio/video are still worth returning — the UI can render them
    // from a data URL without ever giving the bytes a document context.
    if (mimeType && /^(image|audio|video)\//.test(mimeType) && mimeType !== 'image/svg+xml') {
      return {
        path: relPath,
        mimeType,
        sizeBytes: stats.size,
        encoding: 'base64',
        text: null,
        base64: buffer.toString('base64'),
        refusal: null,
      };
    }
    return empty(
      refusal('binary-not-previewable', 'this file is binary and has no inline preview'),
      stats.size,
    );
  }

  return {
    path: relPath,
    mimeType,
    sizeBytes: stats.size,
    encoding: 'utf8',
    text: buffer.toString('utf8'),
    base64: null,
    refusal: null,
  };
}

export function basenameOf(path: string): string {
  return basename(path);
}
