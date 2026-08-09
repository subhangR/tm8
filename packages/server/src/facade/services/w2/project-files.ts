import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path';

import {
  CollabError,
  type ProjectDirectoryEntry,
  type ProjectFileContent,
  type ProjectFileEntry,
  type ProjectFileListing,
  type ProjectFileRefusalReason,
} from '@tm8/contract';

import {
  canonicalDirectory,
  canonicalRoots,
  containedBy,
  requireAllowed,
} from './project-directories.js';

/** A picker should stay responsive even when opened on a very wide directory. */
export const MAX_PROJECT_FILES = 500;

/**
 * Deliberately small and closed. Everything unlisted is
 * `application/octet-stream`: a wrong content type on a stored blob is worse
 * than an unspecific one, because `files.download` echoes it back.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tar': 'application/x-tar',
  '.toml': 'text/plain',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.zip': 'application/zip',
};

/**
 * `.ts` is text/plain, not video/mp2t: a TypeScript source file is the
 * overwhelmingly likelier meaning inside a project folder, and guessing video
 * would make the browser try to play it.
 */
export function mimeForPath(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Canonicalize the project's own working directory and confirm it is still
 * browsable. A project row can name any path — only `ensureWorkingDir`
 * onboarding constrains it — so the root check is applied here too, every
 * request, rather than trusted from creation time.
 */
async function browsableWorkingDir(workingDir: string, rawRoots?: readonly string[]): Promise<{
  root: string;
  roots: string[];
}> {
  const roots = await canonicalRoots(rawRoots ? [...rawRoots] : undefined);
  const root = await canonicalDirectory(workingDir);
  requireAllowed(root, roots);
  return { root, roots };
}

/** Resolve a requested directory to a canonical path inside the project folder. */
async function directoryInProject(root: string, requestedPath: string | undefined): Promise<string> {
  const raw = requestedPath?.trim();
  if (!raw) return root;
  const current = await canonicalDirectory(raw);
  if (!containedBy(root, current)) {
    throw new CollabError('forbidden', 'path is outside the project working directory');
  }
  return current;
}

/**
 * Read one directory inside a connected project folder.
 *
 * Symlinks are omitted from both lists rather than followed: a symlink row
 * would let a picker offer a path whose canonical target lies outside the
 * project, and refusing it at listing time is clearer than refusing it at
 * attach time.
 */
export async function listProjectFiles(
  workingDir: string,
  requestedPath: string | undefined,
  maxSizeBytes: number,
  rawRoots?: readonly string[],
): Promise<Omit<ProjectFileListing, 'projectId'>> {
  const { root } = await browsableWorkingDir(workingDir, rawRoots);
  const current = await directoryInProject(root, requestedPath);

  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new CollabError('forbidden', `directory is not readable: ${current}`);
    }
    throw new CollabError('upstream_unavailable', `could not list directory: ${current}`);
  }

  const directories: ProjectDirectoryEntry[] = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: join(current, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const allFiles: ProjectFileEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(current, entry.name);
    let info;
    try {
      info = await stat(path);
    } catch {
      // A file that vanished or became unreadable between readdir and stat is
      // simply not offered; one bad row must not fail the whole listing.
      continue;
    }
    allFiles.push({
      name: entry.name,
      path,
      sizeBytes: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
      mime: mimeForPath(entry.name),
      attachable: info.size > 0 && info.size <= maxSizeBytes,
    });
  }
  allFiles.sort((a, b) => a.name.localeCompare(b.name));

  const parent = dirname(current);
  return {
    workingDir: root,
    path: current,
    parentPath: current === root || parent === current ? null : parent,
    separator: sep as '/' | '\\',
    directories: directories.slice(0, MAX_PROJECT_FILES),
    files: allFiles.slice(0, MAX_PROJECT_FILES),
    truncated: directories.length > MAX_PROJECT_FILES || allFiles.length > MAX_PROJECT_FILES,
    maxSizeBytes,
  };
}

export interface ResolvedProjectFile {
  /** Canonical path — what is actually opened. */
  readonly path: string;
  readonly name: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
}

/**
 * Canonicalize, authorize and hash one file for attachment.
 *
 * The digest is taken from a real read of the canonical path, so the value
 * handed to the upload ledger describes the bytes this node actually saw. The
 * blob store then re-hashes the same file while writing and refuses a
 * mismatch, which is what makes a file edited mid-attach fail closed instead of
 * being stored under a stale checksum.
 */
export async function resolveProjectFile(
  workingDir: string,
  requestedPath: string,
  maxSizeBytes: number,
  rawRoots?: readonly string[],
): Promise<ResolvedProjectFile> {
  if (!isAbsolute(requestedPath)) {
    throw new CollabError('invalid_input', 'project file path must be absolute');
  }
  const { root } = await browsableWorkingDir(workingDir, rawRoots);

  let canonical: string;
  try {
    canonical = await realpath(requestedPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new CollabError('not_found', `no such file: ${requestedPath}`);
    if (code === 'EACCES' || code === 'EPERM') {
      throw new CollabError('forbidden', `file is not readable: ${requestedPath}`);
    }
    throw new CollabError('upstream_unavailable', `could not read file: ${requestedPath}`);
  }
  if (!containedBy(root, canonical) || canonical === root) {
    throw new CollabError('forbidden', 'file is outside the project working directory');
  }

  const info = await statRegularFile(canonical);
  if (info.size === 0) {
    throw new CollabError('invalid_input', 'an empty file cannot be attached');
  }
  if (info.size > maxSizeBytes) {
    throw new CollabError('payload_too_large', 'file exceeds the configured size limit');
  }

  return {
    path: canonical,
    name: basename(canonical),
    mime: mimeForPath(canonical),
    sizeBytes: info.size,
    checksumSha256: await hashFile(canonical),
  };
}

async function statRegularFile(path: string): Promise<{ size: number }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new CollabError('invalid_input', `not a regular file: ${path}`);
    }
    return { size: info.size };
  } catch (error) {
    if (error instanceof CollabError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new CollabError('not_found', `no such file: ${path}`);
    if (code === 'EACCES' || code === 'EPERM') {
      throw new CollabError('forbidden', `file is not readable: ${path}`);
    }
    throw new CollabError('upstream_unavailable', `could not read file: ${path}`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new CollabError('forbidden', `file is not readable: ${path}`);
    }
    throw new CollabError('upstream_unavailable', `could not read file: ${path}`);
  }
  return hash.digest('hex');
}

/** Bytes for the blob store, read from the canonical path resolved above. */
export function projectFileStream(path: string): AsyncIterable<Uint8Array> {
  return createReadStream(path);
}

// --- reading one file's CONTENT (FILES-DESIGN) ------------------------------

/**
 * The inline VIEW ceiling, which is NOT the attach ceiling.
 *
 * `maxSizeBytes` above governs what may be copied into the blob store (512 MiB
 * by default). Rendering that inline would be a denial of service against the
 * browser, so viewing gets its own, much smaller bound. Two different questions,
 * two different limits.
 */
export const MAX_INLINE_BYTES = 5 * 1024 * 1024;

/** A NUL in the first few KiB is the standard, cheap binary tell. */
const BINARY_SNIFF_BYTES = 8192;

/**
 * Files whose bytes are withheld even though they sit inside the project.
 *
 * DEFENSE IN DEPTH, not a security boundary, and not claimed as one: the
 * boundary is the working-directory containment `resolveProjectFile` and
 * `directoryInProject` already enforce. What this buys is that a VIEWER does
 * not turn "spawn an agent and cat the file" into one click — which matters
 * more here than for the attach picker, because reading is the whole point.
 *
 * Matched case-insensitively on each path segment, so `.ssh/id_rsa` is caught
 * by the directory as well as by the file.
 */
const SECRET_SEGMENTS: RegExp[] = [
  /^\.env(\..*)?$/i,
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
 * whole `.git` directory is NOT withheld — history metadata is useful and
 * harmless — so these match on a trailing path shape, not on a segment.
 */
const SECRET_TAILS: RegExp[] = [
  /(^|[/\\])\.git[/\\]config$/i,
  /(^|[/\\])\.git[/\\]credentials$/i,
];

export function isSecretProjectPath(path: string): boolean {
  if (SECRET_TAILS.some((pattern) => pattern.test(path))) return true;
  return path
    .split(/[/\\]+/)
    .filter((segment) => segment.length > 0)
    .some((segment) => SECRET_SEGMENTS.some((pattern) => pattern.test(segment)));
}

function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

export type ProjectFileReadResult = Omit<ProjectFileContent, 'projectId'>;

function withheld(
  path: string,
  reason: ProjectFileRefusalReason,
  detail: string,
  sizeBytes = 0,
): ProjectFileReadResult {
  return {
    path,
    mime: mimeForPath(path),
    sizeBytes,
    encoding: 'none',
    text: null,
    base64: null,
    refusal: { reason, detail },
    maxInlineBytes: MAX_INLINE_BYTES,
  };
}

/**
 * Read one file inside a connected project folder, or answer a NAMED refusal.
 *
 * Containment is `browsableWorkingDir` + `containedBy` on the CANONICAL path —
 * the same pair `resolveProjectFile` uses, deliberately reused rather than
 * reimplemented, so there is exactly one jail in this module and it cannot
 * drift into two that disagree.
 */
export async function readProjectFile(
  workingDir: string,
  requestedPath: string,
  rawRoots?: readonly string[],
): Promise<ProjectFileReadResult> {
  if (!isAbsolute(requestedPath)) {
    throw new CollabError('invalid_input', 'project file path must be absolute');
  }
  // Checked BEFORE the path is resolved, so a secret file's existence is never
  // confirmed or denied by the shape of the failure.
  if (isSecretProjectPath(requestedPath)) {
    return withheld(requestedPath, 'secret-pattern', 'this file is withheld by the secret-name policy');
  }

  const { root } = await browsableWorkingDir(workingDir, rawRoots);

  let canonical: string;
  try {
    canonical = await realpath(requestedPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return withheld(requestedPath, 'not-a-file', 'no such file in this project');
    if (code === 'ELOOP') return withheld(requestedPath, 'outside-root', 'path is a symlink loop');
    return withheld(requestedPath, 'unreadable', 'the file could not be resolved');
  }
  if (!containedBy(root, canonical) || canonical === root) {
    // Deliberately does NOT echo `canonical`: telling a caller where their
    // symlink landed is a filesystem oracle for paths outside the project.
    return withheld(requestedPath, 'outside-root', 'path resolves outside the project working directory');
  }
  // Re-checked on the RESOLVED path: a symlink named innocently must not be a
  // way to read `.env` through the policy above.
  if (isSecretProjectPath(canonical)) {
    return withheld(requestedPath, 'secret-pattern', 'this file is withheld by the secret-name policy');
  }

  let info: { size: number };
  try {
    info = await statRegularFile(canonical);
  } catch (error) {
    if (error instanceof CollabError && error.code === 'invalid_input') {
      return withheld(requestedPath, 'not-a-file', 'that path is not a regular file');
    }
    if (error instanceof CollabError && error.code === 'forbidden') {
      return withheld(requestedPath, 'unreadable', 'the node cannot read that file');
    }
    return withheld(requestedPath, 'not-a-file', 'no such file in this project');
  }
  if (info.size > MAX_INLINE_BYTES) {
    return withheld(
      requestedPath, 'too-large',
      `file is ${info.size} bytes; the inline ceiling is ${MAX_INLINE_BYTES}`,
      info.size,
    );
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(canonical);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return withheld(
      requestedPath, 'unreadable',
      code === 'EACCES' ? 'the node cannot read that file' : 'the file could not be read',
      info.size,
    );
  }

  const mime = mimeForPath(requestedPath);
  if (looksBinary(buffer)) {
    // Renderable media still travels — base64 into an <img>/<audio> gives the
    // bytes no document context. SVG is excluded because it IS a document.
    if (/^(image|audio|video)\//.test(mime) && mime !== 'image/svg+xml') {
      return {
        path: requestedPath,
        mime,
        sizeBytes: info.size,
        encoding: 'base64',
        text: null,
        base64: buffer.toString('base64'),
        refusal: null,
        maxInlineBytes: MAX_INLINE_BYTES,
      };
    }
    return withheld(
      requestedPath, 'binary-not-previewable',
      'this file is binary and has no inline preview', info.size,
    );
  }

  return {
    path: requestedPath,
    mime,
    sizeBytes: info.size,
    encoding: 'utf8',
    text: buffer.toString('utf8'),
    base64: null,
    refusal: null,
    maxInlineBytes: MAX_INLINE_BYTES,
  };
}
