/**
 * The clipboard handoff directory.
 *
 * When tm8 is used from a browser, the clipboard lives on the viewer's machine
 * and the agent process lives on this node. Every agent tool we support reads
 * images by *path*, so a pasted screenshot has to make the trip: take the
 * bytes, write them somewhere the agent can open, hand back an absolute path.
 * Injecting that short path (never base64) is what makes the bridge
 * agent-agnostic — Claude Code, Codex and a plain shell all read a file.
 *
 * This is deliberately NOT the blob store. `W2BlobStore` is content-addressed,
 * extensionless and 0700/0600 because it holds space-scoped durable content
 * whose path is never revealed. A clipboard image is the opposite on every
 * axis: it is a transient hand-off whose whole purpose is to have a readable
 * path with a real extension. Conflating the two would either leak blob paths
 * or hand the agent a file it cannot identify.
 *
 * Layout: `<clipboardDir>/<space8>/<YYYY-MM-DD>/<hhmmss>-<rand>.<ext>`
 *
 * `<space8>` is the first 8 characters of the Space id — a BUCKET, not an
 * identity. Authorization happened before anything reached this module (the
 * caller had to be able to see the session under RLS); this level only keeps
 * one Space's pastes from crowding another's, and stays short because the path
 * is typed into a terminal a human is looking at. Date-bucketing is what makes
 * retention a directory removal instead of a scan.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { CollabError } from '@tm8/contract';

export const CLIPBOARD_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export type ClipboardImageMimeType = (typeof CLIPBOARD_IMAGE_MIME_TYPES)[number];

const EXTENSION_BY_MIME: Record<ClipboardImageMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_BUCKET_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 10 MB, matching the ceiling browsers comfortably hold in a paste buffer. */
export const CLIPBOARD_MAX_BYTES_DEFAULT = 10 * 1024 * 1024;
/** Date buckets older than this are removed on boot. */
export const CLIPBOARD_RETENTION_DAYS_DEFAULT = 30;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Identify an image by its leading bytes.
 *
 * A client is free to declare any Content-Type, so the declared type is a HINT
 * and the bytes are the truth. Anything we cannot positively identify as one of
 * the four accepted formats is refused — this is the guard that stops the
 * handoff directory from becoming a way to write arbitrary files onto the node.
 */
export function sniffImageMimeType(data: Buffer): ClipboardImageMimeType | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  // JPEG: SOI marker followed by any marker byte.
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data.length >= 6) {
    const header = data.subarray(0, 6).toString('latin1');
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif';
  }
  // WEBP: a RIFF container whose form type is WEBP.
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** Normalize common aliases so `image/jpg` does not read as a mismatch. */
function normalizeMimeType(value: string): string {
  const base = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return base === 'image/jpg' ? 'image/jpeg' : base;
}

function isAccepted(value: string): value is ClipboardImageMimeType {
  return (CLIPBOARD_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

/** Local date bucket (`YYYY-MM-DD`). Local, not UTC: it groups a human's day. */
export function clipboardDateBucket(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export interface ClipboardStoreOptions {
  /** Absolute handoff root. Resolved by `resolveClipboardDir`. */
  readonly clipboardDir: string;
  readonly maxBytes?: number;
  readonly retentionDays?: number;
}

export interface ClipboardStoreInput {
  readonly data: Buffer;
  /** Content-Type declared by the client. A hint; the bytes decide. */
  readonly declaredMimeType?: string | undefined;
  readonly spaceId: string;
}

export interface StoredClipboardImage {
  /** Absolute path ON THIS NODE — the string written into the PTY. */
  readonly path: string;
  readonly filename: string;
  readonly mimeType: ClipboardImageMimeType;
  readonly bytes: number;
}

export class ClipboardStore {
  readonly clipboardDir: string;
  readonly maxBytes: number;
  readonly retentionDays: number;

  constructor(options: ClipboardStoreOptions) {
    this.clipboardDir = resolve(options.clipboardDir);
    if (!isAbsolute(this.clipboardDir)) {
      throw new Error('clipboard directory must be absolute');
    }
    const max = options.maxBytes ?? CLIPBOARD_MAX_BYTES_DEFAULT;
    if (!Number.isSafeInteger(max) || max <= 0) {
      throw new Error('clipboard max size must be a positive safe integer');
    }
    this.maxBytes = max;
    const days = options.retentionDays ?? CLIPBOARD_RETENTION_DAYS_DEFAULT;
    if (!Number.isSafeInteger(days) || days < 0) {
      throw new Error('clipboard retention days must be a non-negative safe integer');
    }
    this.retentionDays = days;
  }

  async store(input: ClipboardStoreInput): Promise<StoredClipboardImage> {
    const { data } = input;
    if (!data || data.length === 0) {
      throw new CollabError('invalid_input', 'an image is required');
    }
    if (data.length > this.maxBytes) {
      throw new CollabError(
        'payload_too_large',
        `image exceeds the maximum size of ${this.maxBytes} bytes`,
      );
    }
    if (!UUID_RE.test(input.spaceId)) {
      throw new CollabError('invalid_input', 'spaceId must be a uuid');
    }

    const sniffed = sniffImageMimeType(data);
    if (!sniffed) {
      throw new CollabError('invalid_input', 'content is not a recognized image format');
    }
    if (input.declaredMimeType) {
      const declared = normalizeMimeType(input.declaredMimeType);
      if (!isAccepted(declared)) {
        throw new CollabError(
          'invalid_input',
          `unsupported image type: ${declared}. allowed: ${CLIPBOARD_IMAGE_MIME_TYPES.join(', ')}`,
        );
      }
      if (declared !== sniffed) {
        throw new CollabError(
          'invalid_input',
          `declared type ${declared} does not match content (${sniffed})`,
        );
      }
    }

    const bucket = join(
      this.clipboardDir,
      input.spaceId.toLowerCase().slice(0, 8),
      clipboardDateBucket(),
    );
    if (!contained(this.clipboardDir, bucket)) {
      throw new CollabError('invalid_input', 'clipboard path escapes the clipboard directory');
    }
    // 0755/0644, unlike the blob store's 0700/0600. This directory exists to be
    // READ by an agent process, and tying that to "the agent happens to run as
    // the same user as the server" is a coincidence, not a design.
    await mkdir(bucket, { recursive: true, mode: 0o755 });

    const filename = `${clipboardStamp()}-${randomBytes(2).toString('hex')}.${EXTENSION_BY_MIME[sniffed]}`;
    const path = join(bucket, filename);
    // `wx` — never overwrite. The name carries 4 hex of entropy inside a
    // one-second window, so a collision means something is wrong and silently
    // replacing another paste would be the worse answer.
    await writeFile(path, data, { flag: 'wx', mode: 0o644 });

    return { path, filename, mimeType: sniffed, bytes: data.length };
  }

  /**
   * Remove date buckets older than the retention window.
   *
   * Whole-directory removal, which is the entire reason the layout is
   * date-bucketed. Returns how many buckets went, for the boot log.
   */
  async sweepExpired(now: Date = new Date()): Promise<number> {
    if (this.retentionDays === 0) return 0;
    const cutoff = new Date(now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000);
    const oldest = clipboardDateBucket(cutoff);

    let spaces: string[];
    try {
      spaces = await readdir(this.clipboardDir);
    } catch {
      return 0; // Nothing pasted on this node yet.
    }

    let removed = 0;
    for (const space of spaces) {
      const spaceDir = join(this.clipboardDir, space);
      if (!contained(this.clipboardDir, spaceDir)) continue;
      let buckets: string[];
      try {
        buckets = await readdir(spaceDir);
      } catch {
        continue;
      }
      for (const bucket of buckets) {
        // String comparison is correct for `YYYY-MM-DD` and needs no parsing.
        if (!DATE_BUCKET_RE.test(bucket) || bucket >= oldest) continue;
        await rm(join(spaceDir, bucket), { recursive: true, force: true }).catch(() => undefined);
        removed += 1;
      }
    }
    return removed;
  }
}

/** `hhmmss`, so a human scanning the directory sees when a paste happened. */
function clipboardStamp(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function createClipboardStore(options: ClipboardStoreOptions): ClipboardStore {
  return new ClipboardStore(options);
}
