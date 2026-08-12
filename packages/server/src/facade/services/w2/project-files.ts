import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
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

// ---------------------------------------------------------------------------
// Folder archive — the whole-subtree read (`projects.files.archive`)
// ---------------------------------------------------------------------------

/**
 * ARCHIVE CEILINGS, deliberately larger than the picker's `MAX_PROJECT_FILES`
 * and deliberately finite. A picker cap of 500 exists so a wide directory
 * stays responsive; these exist so one request cannot walk an unbounded tree
 * or mint a 4 GiB response. Both are REFUSALS naming the limit, never silent
 * truncation: an archive missing files it did not mention is the one outcome a
 * download must never produce.
 */
export const MAX_ARCHIVE_FILES = 20_000;
export const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024; // 1 GiB of file bytes

/** The manifest an archive carries when the policy withheld anything. */
export const ARCHIVE_EXCLUSION_MANIFEST = '_tm8-excluded.txt';

export interface ArchivePlanEntry {
  /** Canonical absolute path on the node's disk. */
  absolutePath: string;
  /** POSIX path inside the archive, always under a single root directory. */
  archivePath: string;
  sizeBytes: number;
  /** Device+inode as the walk saw them — the read re-checks both. */
  dev: number;
  ino: number;
}

export interface ArchivePlan {
  /** Basename of the subtree, used for the archive root and the filename. */
  rootName: string;
  /** The PROJECT root the policy is judged against — never the subtree. */
  rootPath: string;
  entries: ArchivePlanEntry[];
  totalBytes: number;
  /** Archive-relative paths the policy withheld, with the reason, in order. */
  excluded: Array<{ path: string; reason: string }>;
}

/**
 * Walk a subtree and decide EVERYTHING before a single byte is written.
 *
 * The walk is separate from the streaming for one reason: once a response's
 * headers are on the wire an error can no longer be an error, only a severed
 * connection. So every refusal this operation can raise — outside the project,
 * over a ceiling, unreadable root — is raised here, while a typed error still
 * reaches the client as a typed error. The walk only stats; the bytes are read
 * later, one file at a time.
 *
 * Withheld files are OMITTED and RECORDED. A secret silently dropped from an
 * archive is indistinguishable from a secret that was never there, and the
 * difference matters to whoever unzips it.
 */
export async function planProjectArchive(
  workingDir: string,
  requestedPath: string | undefined,
  rawRoots?: readonly string[],
  // Injectable so the ceiling behaviour is testable without building a 20,000
  // file tree — a limit that can only be reached by exhausting it in earnest
  // is a limit nobody ever tests.
  limits?: { maxFiles?: number; maxBytes?: number },
): Promise<ArchivePlan> {
  const maxFiles = limits?.maxFiles ?? MAX_ARCHIVE_FILES;
  const maxBytes = limits?.maxBytes ?? MAX_ARCHIVE_BYTES;
  const { root } = await browsableWorkingDir(workingDir, rawRoots);
  const subtree = await directoryInProject(root, requestedPath);
  const rootName = basename(subtree) || 'project';

  const entries: ArchivePlanEntry[] = [];
  const excluded: Array<{ path: string; reason: string }> = [];
  let totalBytes = 0;

  const walk = async (dir: string, prefix: string): Promise<void> => {
    let rows;
    try {
      rows = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        excluded.push({ path: prefix || rootName, reason: 'directory is not readable' });
        return;
      }
      throw new CollabError('upstream_unavailable', `could not list directory: ${dir}`);
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    for (const row of rows) {
      const absolute = join(dir, row.name);
      const archivePath = prefix === '' ? row.name : `${prefix}/${row.name}`;
      // Symlinks are skipped for the same reason listing skips them: the
      // canonical target may lie outside the project, and an archive that
      // silently escaped its root would be a jail break with a .zip on it.
      if (row.isSymbolicLink()) {
        excluded.push({ path: archivePath, reason: 'symbolic link' });
        continue;
      }
      if (row.isDirectory()) {
        if (EXCLUDED_DIRECTORY_NAMES.has(row.name)) {
          excluded.push({ path: archivePath, reason: 'excluded directory' });
          continue;
        }
        const secret = secretReason(root, absolute);
        if (secret !== null) {
          excluded.push({ path: archivePath, reason: secret });
          continue;
        }
        // The dirent above came from the PARENT's readdir; the recursion below
        // re-resolves `absolute` BY NAME. Between the two, the entry can be
        // renamed away and replaced with a symlink pointing outside the
        // project — and the walk would follow it, because nothing re-checks
        // containment after `directoryInProject` ran once at the start.
        // Demonstrated: a 5 ms swap put an outside file in the archive with an
        // EMPTY exclusion list. So the invariant is re-established here, on the
        // resolved path, immediately before descending.
        let resolvedDir: string;
        try {
          resolvedDir = await realpath(absolute);
        } catch {
          excluded.push({ path: archivePath, reason: 'unreadable' });
          continue;
        }
        if (!containedBy(root, resolvedDir)) {
          excluded.push({ path: archivePath, reason: 'resolves outside the project' });
          continue;
        }
        await walk(resolvedDir, archivePath);
        continue;
      }
      if (!row.isFile()) continue;
      const secret = secretReason(root, absolute);
      if (secret !== null) {
        excluded.push({ path: archivePath, reason: secret });
        continue;
      }
      if (await withinTm8DataDir(absolute)) {
        excluded.push({ path: archivePath, reason: 'tm8 data directory' });
        continue;
      }
      let info;
      try {
        info = await stat(absolute);
      } catch {
        excluded.push({ path: archivePath, reason: 'unreadable' });
        continue;
      }
      entries.push({
        absolutePath: absolute,
        archivePath: `${rootName}/${archivePath}`,
        sizeBytes: info.size,
        // Identity, carried so the READ can prove it opened the same file the
        // walk approved. See `projectArchiveEntries`.
        dev: info.dev,
        ino: info.ino,
      });
      totalBytes += info.size;
      if (entries.length > maxFiles) {
        throw new CollabError(
          'payload_too_large',
          `this folder holds more than ${maxFiles} files, which is the archive limit`,
        );
      }
      if (totalBytes > maxBytes) {
        throw new CollabError(
          'payload_too_large',
          `this folder is larger than ${maxBytes} bytes, which is the archive limit`,
        );
      }
    }
  };

  await walk(subtree, '');
  return { rootName, rootPath: root, entries, totalBytes, excluded };
}

/**
 * The plan's bytes, one file at a time, RE-VERIFIED as they are read.
 *
 * Read errors become an EXCLUSION note rather than a thrown error: by the time
 * this runs the response is already streaming, so the only honest ways to
 * report a late failure are a severed connection or a line in the manifest,
 * and a file that vanished between the walk and the read does not deserve to
 * kill the whole archive.
 *
 * `root` is optional only so existing callers keep compiling; the service
 * always passes it, and without it the re-check degrades to O_NOFOLLOW plus
 * the inode identity check.
 */
export async function* projectArchiveEntries(
  plan: ArchivePlan,
  root?: string,
): AsyncGenerator<{ path: string; bytes: Buffer }> {
  const lateExclusions: Array<{ path: string; reason: string }> = [];
  for (const entry of plan.entries) {
    let bytes: Buffer;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // O_NOFOLLOW, exactly as `readProjectFile` opens. The plan walk ran
      // seconds ago over a live filesystem, so "the walk approved this path"
      // is not the same statement as "this path is still that file". Without
      // the flag, a regular file swapped to a symlink between plan and read
      // was followed — demonstrated laundering `.env` into an archive whose
      // own manifest said `.env` had been withheld.
      handle = await open(entry.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      // Identity re-check: same device, same inode, still a regular file, same
      // size. A swap that beat O_NOFOLLOW (a hardlink, or a replaced parent
      // directory) changes the inode, and `readFile`-by-path cannot see that.
      if (!info.isFile() || info.dev !== entry.dev || info.ino !== entry.ino) {
        lateExclusions.push({ path: entry.archivePath, reason: 'changed while archiving' });
        continue;
      }
      // And the secret policy again, on the path as it stands now — §4.2's
      // rule is that the check runs on the RESOLVED path every time, not once.
      if (root !== undefined) {
        const resolved = await realpath(entry.absolutePath);
        if (!containedBy(root, resolved) || secretReason(root, resolved) !== null) {
          lateExclusions.push({ path: entry.archivePath, reason: 'withheld on re-check' });
          continue;
        }
      }
      bytes = await handle.readFile();
    } catch {
      lateExclusions.push({ path: entry.archivePath, reason: 'disappeared while archiving' });
      continue;
    } finally {
      await handle?.close().catch(() => undefined);
    }
    yield { path: entry.archivePath, bytes };
  }

  // ALWAYS emitted, even when nothing was withheld. An archive that omits the
  // manifest when the list is empty lets a file the project itself contains,
  // named `_tm8-excluded.txt`, be the only one present and read as
  // authoritative. A receipt that is sometimes absent is not a receipt.
  const excluded = [...plan.excluded, ...lateExclusions];
  const taken = new Set(plan.entries.map((entry) => entry.archivePath));
  let manifestPath = `${plan.rootName}/${ARCHIVE_EXCLUSION_MANIFEST}`;
  // A real file may already occupy that name. Two zip entries at one path
  // extract to whichever came last, silently destroying the user's file.
  for (let n = 2; taken.has(manifestPath); n += 1) {
    manifestPath = `${plan.rootName}/_tm8-excluded (${n}).txt`;
  }
  const rows = excluded.map(
    // JSON-quoted, because a filename may contain a tab or a newline and an
    // unescaped one forges a row: a symlink named
    // `boring.txt\tsymbolic link\nsanitised.txt\treviewed and safe` produced a
    // fully-formed fake entry in this manifest.
    (item) => `${JSON.stringify(item.path)}\t${JSON.stringify(item.reason)}`,
  );
  const manifest = [
    excluded.length === 0
      ? 'Nothing was withheld from this archive.'
      : 'These paths were NOT included in this archive.',
    'Paths and reasons are JSON-quoted so a filename cannot forge a row.',
    '',
    ...rows,
    '',
  ].join('\n');
  yield { path: manifestPath, bytes: Buffer.from(manifest, 'utf8') };
}
