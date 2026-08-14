/**
 * The clipboard handoff directory.
 *
 * When tm8 is used from a browser, the clipboard lives on the viewer's machine
 * and the agent process lives on this node. Every agent tool we support reads
 * files by *path*, so a pasted file has to make the trip: take the bytes,
 * write them somewhere the agent can open, hand back an absolute path.
 * Injecting that short path (never base64) is what makes the bridge
 * agent-agnostic — Claude Code, Codex and a plain shell all read a file.
 *
 * WIDENED FROM IMAGES TO THE AGENT-READABLE SET (R2). This accepted four image
 * types, which meant a terminal user could paste a screenshot and not a PDF,
 * a CSV, or the log file they were being asked about — while the chat composer
 * beside it took all four. The allowlist is now `isAgentReadableMime` from
 * `@tm8/contract`, the SAME predicate the UI filters pastes with, imported
 * rather than restated: two hand-kept copies of "what agents read" diverge on
 * exactly the type nobody tested, which is why that file exists.
 *
 * WHAT STOPS THIS BEING AN ARBITRARY FILE WRITE, now that "the bytes must
 * sniff as one of four images" is gone. It was never only the sniff: the
 * directory is fixed and containment-checked, the filename is GENERATED (the
 * client's name is never used, only its extension, and only after
 * sanitisation), the size is capped while streaming, and the caller had to be
 * able to see the session under RLS before anything reached here. What the
 * byte inspection still does is catch a LIE: a declared type that disagrees
 * with the content, and an executable declaring itself as text. Those two
 * checks are kept and the rest of the format list is not re-encoded here.
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

import { AGENT_READABLE_BARE_EXTENSIONS, CollabError, isAgentReadableMime } from '@tm8/contract';

export const CLIPBOARD_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export type ClipboardImageMimeType = (typeof CLIPBOARD_IMAGE_MIME_TYPES)[number];

/**
 * Extensions for the types that arrive WITHOUT a usable filename. The client
 * sends the original name when it has one (a dragged `notes.md` keeps `md`);
 * this table is what a pasted screenshot — which has no name at all — gets.
 * Deliberately short: an unknown type falls back to its own sanitised
 * subtype, which is a worse extension than a curated one and a much better
 * one than a wrong one.
 */
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/xml': 'xml',
  'application/x-yaml': 'yaml',
  'application/yaml': 'yaml',
  'application/rtf': 'rtf',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/css': 'css',
};

/**
 * A ZIP container is not one format. `.docx`, `.xlsx`, `.pptx` and every
 * OpenDocument file are ZIPs, so `PK\x03\x04` cannot be refused outright and
 * cannot be resolved to a type on its own — the DECLARED type is the only
 * thing that separates a readable document from an archive of anything.
 */
const ZIP_CONTAINER_PREFIXES = [
  'application/vnd.openxmlformats-officedocument.',
  'application/vnd.oasis.opendocument.',
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_BUCKET_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 10 MB, matching the ceiling browsers comfortably hold in a paste buffer. */
export const CLIPBOARD_MAX_BYTES_DEFAULT = 10 * 1024 * 1024;
/** Date buckets older than this are removed on boot. */
export const CLIPBOARD_RETENTION_DAYS_DEFAULT = 30;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * What the leading bytes SAY this is, when they say anything at all.
 *
 * `mime` is set only for formats a signature identifies exactly. `family`
 * carries the two answers that are about a shape rather than a type:
 * `'zip'`, which is a container a readable document and an archive share, and
 * `'executable'`, which nothing readable ever is.
 *
 * Most of the readable set has NO signature — a `.md`, a `.csv`, a `.py` are
 * all just text — so "unidentified" is now the ordinary case and cannot be a
 * refusal. See the header for what actually bounds this directory.
 */
export interface SniffedClipboardContent {
  mime?: string;
  family?: 'zip' | 'executable';
}

const ELF_SIGNATURE = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export function sniffClipboardContent(data: Buffer): SniffedClipboardContent {
  const image = sniffImageMimeType(data);
  if (image) return { mime: image };
  if (data.length >= 5 && data.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { mime: 'application/pdf' };
  }
  if (data.length >= 4 && data.subarray(0, 4).equals(ZIP_SIGNATURE)) return { family: 'zip' };
  if (data.length >= 4 && data.subarray(0, 4).equals(ELF_SIGNATURE)) return { family: 'executable' };
  // `MZ` — a DOS/PE header. Two bytes is a weak signal on its own, so it is
  // only read as an executable at the very start of the content.
  if (data.length >= 2 && data[0] === 0x4d && data[1] === 0x5a) return { family: 'executable' };
  // Mach-O, all four magics (32/64-bit, both byte orders).
  if (data.length >= 4) {
    const magic = data.readUInt32BE(0);
    if (magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcefaedfe || magic === 0xcffaedfe) {
      return { family: 'executable' };
    }
  }
  return {};
}

/**
 * Identify an image by its leading bytes.
 *
 * Kept exactly as it was, and still the strongest evidence available for the
 * four formats it knows: a client is free to declare any Content-Type, so a
 * declared type that DISAGREES with a signature is a lie the store refuses.
 * What changed is its role — it is no longer the whole allowlist.
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

/**
 * The ONE allowlist, imported rather than restated (R2). `application/
 * octet-stream` is called out because it is what a browser reports for every
 * file it cannot type — a `.py`, a `.toml`, a `.log` — so it is not a refusal
 * on its own; the filename decides those, below.
 */
function isAccepted(value: string): boolean {
  return isAgentReadableMime(value);
}

const GENERIC_MIME_TYPES = new Set(['application/octet-stream', 'binary/octet-stream']);

/**
 * The extension to write, in the order the evidence deserves.
 *
 * THE CLIENT'S NAME IS NEVER THE FILENAME — only a candidate extension, and
 * only if it survives `[a-z0-9]{1,8}`. That sanitisation is what makes using
 * it safe at all: no separator, no dot, no traversal can pass it, and the
 * base name is generated here regardless.
 */
function extensionFor(mime: string, filename: string | undefined): string {
  const named = extensionOfName(filename);
  if (named) return named;
  const known = EXTENSION_BY_MIME[mime];
  if (known) return known;
  /* Last resort: the subtype itself, stripped of structured-syntax suffixes
     (`application/ld+json` → `ld`) and of anything a path could use. An
     agent opening `…-a1b2.plain` reads it fine; the extension is a courtesy
     to the human reading the path, not a format declaration. */
  const subtype = mime.split('/')[1]?.split('+')[0] ?? '';
  const safe = subtype.replace(/[^a-z0-9]/g, '').slice(0, 8);
  return safe === '' ? 'bin' : safe;
}

function extensionOfName(filename: string | undefined): string | null {
  if (!filename) return null;
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return null;
  const raw = filename.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(raw) ? raw : null;
}

/**
 * WHAT THIS FILE IS, and whether we will take it — the whole acceptance rule,
 * in one place so the refusals can be read against each other.
 *
 * The order is evidence-first, and each step exists for a case that actually
 * happens:
 *
 *  1. An EXECUTABLE is refused whatever it claims to be. Nothing in the
 *     readable set has these magics, so a match here is always a lie, and it
 *     is the lie that matters most on a directory an agent process reads.
 *  2. A SIGNATURE WINS over a declaration. A ZIP renamed `notes.txt` and
 *     pasted as `text/plain` is refused as a mismatch rather than written
 *     with a `.txt` an agent would then try to read as prose.
 *  3. A ZIP is resolved BY ITS DECLARATION, because `.docx` and an archive of
 *     anything share the signature exactly (see `ZIP_CONTAINER_PREFIXES`).
 *  4. WITHOUT a signature — the ordinary case for text, which is most of the
 *     set — the declared type governs, and `application/octet-stream` (what a
 *     browser reports for every source and config file) falls through to the
 *     filename's extension.
 */
function resolveMimeType(data: Buffer, input: ClipboardStoreInput): string {
  const sniffed = sniffClipboardContent(data);
  if (sniffed.family === 'executable') {
    throw new CollabError('invalid_input', 'content is an executable; agents cannot read one');
  }

  const declared = input.declaredMimeType ? normalizeMimeType(input.declaredMimeType) : '';
  const generic = declared === '' || GENERIC_MIME_TYPES.has(declared);

  if (sniffed.mime) {
    if (!generic && declared !== sniffed.mime) {
      throw new CollabError(
        'invalid_input',
        `declared type ${declared} does not match content (${sniffed.mime})`,
      );
    }
    return sniffed.mime;
  }

  if (sniffed.family === 'zip') {
    const container = ZIP_CONTAINER_PREFIXES.some((prefix) => declared.startsWith(prefix));
    if (!container) {
      throw new CollabError(
        'invalid_input',
        declared === ''
          ? 'content is an archive; agents cannot read one'
          : `declared type ${declared} does not match content (an archive)`,
      );
    }
    return declared;
  }

  if (!generic) {
    if (!isAccepted(declared)) {
      throw new CollabError(
        'invalid_input',
        `unsupported type: ${declared}. agents cannot read this file type`,
      );
    }
    return declared;
  }

  /* No signature and no usable declaration: the NAME is the only evidence
     left, and only the short curated list is trusted — an unknown extension
     with no MIME stays refused rather than guessed at, the same rule the
     contract's own bare-extension fallback states. */
  const extension = extensionOfName(input.declaredFilename);
  if (extension && AGENT_READABLE_BARE_EXTENSIONS.includes(extension)) return 'text/plain';
  throw new CollabError(
    'invalid_input',
    'content type could not be established; agents cannot read an unidentified file',
  );
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
  /** Content-Type declared by the client. A hint; a signature overrides it. */
  readonly declaredMimeType?: string | undefined;
  /**
   * The name the file had on the viewer's machine, when it had one — a pasted
   * screenshot does not. USED FOR ITS EXTENSION ONLY (see `extensionFor`), so
   * a dragged `deploy.sh` keeps `sh` and stays legible to whoever reads the
   * path out of the terminal. It is also the evidence that types a file the
   * browser reported as `application/octet-stream`, which is what every
   * source and config file arrives as.
   */
  readonly declaredFilename?: string | undefined;
  readonly spaceId: string;
}

export interface StoredClipboardFile {
  /** Absolute path ON THIS NODE — the string written into the PTY. */
  readonly path: string;
  readonly filename: string;
  /** The type the store RESOLVED — a signature's answer, or the declared one. */
  readonly mimeType: string;
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

  async store(input: ClipboardStoreInput): Promise<StoredClipboardFile> {
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

    const mimeType = resolveMimeType(data, input);

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

    const extension = extensionFor(mimeType, input.declaredFilename);
    const filename = `${clipboardStamp()}-${randomBytes(2).toString('hex')}.${extension}`;
    const path = join(bucket, filename);
    // `wx` — never overwrite. The name carries 4 hex of entropy inside a
    // one-second window, so a collision means something is wrong and silently
    // replacing another paste would be the worse answer.
    await writeFile(path, data, { flag: 'wx', mode: 0o644 });

    return { path, filename, mimeType, bytes: data.length };
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
