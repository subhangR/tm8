import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path';

import {
  CollabError,
  type ProjectDirectoryEntry,
  type ProjectFileEntry,
  type ProjectFileListing,
  type ProjectFileReadResult,
} from '@tm8/contract';

import {
  canonicalDirectory,
  canonicalRoots,
  containedBy,
  requireAllowed,
} from './project-directories.js';
import {
  EXCLUDED_DIRECTORY_NAMES,
  secretReason,
  withinTm8DataDir,
} from './project-file-policy.js';

/** A picker should stay responsive even when opened on a very wide directory. */
export const MAX_PROJECT_FILES = 500;

/**
 * Inline read ceiling, deliberately distinct from — and smaller than — the
 * attach ceiling: an attach streams to the blob store, an inline read buffers
 * into a JSON body.
 */
export const MAX_INLINE_READ_BYTES = 5 * 1_024 * 1_024;

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
    .filter((entry) => entry.isDirectory() && !EXCLUDED_DIRECTORY_NAMES.has(entry.name))
    .map((entry) => ({ name: entry.name, path: join(current, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const allFiles: ProjectFileEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(current, entry.name);
    // A secret row is OMITTED rather than flagged: a picker must not offer
    // what read and attach will refuse. `path` here is already canonical up to
    // the entry name (readdir of a canonical dir, symlink entries excluded).
    if (secretReason(root, path) !== null || (await withinTm8DataDir(path))) continue;
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
  await refuseSecrets(root, canonical);

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

/**
 * The secret check runs on the RESOLVED path — an innocently named symlink to
 * `.env` is refused by what it points at, not admitted by what it is called.
 * The message names the file WITHHELD, distinct from empty and from absent.
 */
async function refuseSecrets(root: string, canonical: string): Promise<void> {
  const reason = secretReason(root, canonical);
  if (reason) throw new CollabError('forbidden', `file is withheld: ${reason}`);
  if (await withinTm8DataDir(canonical)) {
    throw new CollabError('forbidden', 'file is withheld: tm8 data directory');
  }
}

/**
 * MIME for an INLINE read. Never a type a UI would render as active content:
 * SVG scripts and HTML both execute in the viewer's origin if inlined.
 */
function inlineSafeMime(path: string): string {
  const mime = mimeForPath(path);
  return mime === 'image/svg+xml' || mime === 'text/html' ? 'text/plain' : mime;
}

/**
 * Read one file inline for a viewer.
 *
 * TOCTOU: the containment and secret checks run on the realpath-resolved
 * canonical path, and the subsequent open uses `O_NOFOLLOW` with every read
 * going through that ONE handle. A swap-to-symlink between resolve and open —
 * the classic race — makes the open fail instead of silently following the
 * new target; a swap AFTER open is harmless because the handle pins the inode
 * that was checked.
 */
export async function readProjectFile(
  workingDir: string,
  requestedPath: string,
  inlineMaxBytes: number = MAX_INLINE_READ_BYTES,
  rawRoots?: readonly string[],
): Promise<Omit<ProjectFileReadResult, 'projectId'>> {
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
  await refuseSecrets(root, canonical);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ELOOP' || code === 'EMLINK') {
        // The final component became a symlink after it was resolved — the
        // race this flag exists to catch.
        throw new CollabError('forbidden', 'file changed to a symlink while being read');
      }
      if (code === 'ENOENT') throw new CollabError('not_found', `no such file: ${requestedPath}`);
      if (code === 'EACCES' || code === 'EPERM') {
        throw new CollabError('forbidden', `file is not readable: ${requestedPath}`);
      }
      throw new CollabError('upstream_unavailable', `could not read file: ${requestedPath}`);
    }

    const info = await handle.stat();
    if (!info.isFile()) {
      throw new CollabError('invalid_input', `not a regular file: ${requestedPath}`);
    }
    const truncated = info.size > inlineMaxBytes;
    const buffer = Buffer.alloc(Math.min(info.size, inlineMaxBytes));
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const bytes = filled === buffer.length ? buffer : buffer.subarray(0, filled);

    return {
      path: canonical,
      name: basename(canonical),
      mime: inlineSafeMime(canonical),
      sizeBytes: info.size,
      ...encodeContent(bytes),
      truncated,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function encodeContent(bytes: Buffer): { encoding: 'utf8' | 'base64'; content: string } {
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!content.includes('\u0000')) return { encoding: 'utf8', content };
  } catch {
    // Fall through to base64.
  }
  return { encoding: 'base64', content: bytes.toString('base64') };
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
