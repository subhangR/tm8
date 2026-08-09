/**
 * A STORE-ONLY ZIP WRITER, with no dependency.
 *
 * SHARED SURFACE. Lane D consumes this module for Space creation, so that the
 * repository has ONE archive encoder rather than two with subtly different path
 * and CRC behaviour. Import it as
 * `import { buildStoreOnlyZip, zipBlob, safeArchivePath } from '../files-browser/zip'`.
 * Anything that changes a byte of the output belongs in this file and in its
 * suite, never in a caller.
 *
 * WHY THIS EXISTS AND IS NOT `jszip`. Measured on 2026-08-09: `packages/tm8-ui`
 * carries no archiver at all — not jszip, fflate, pako or client-zip, in
 * `package.json` or in `node_modules`. Adding one edits `package.json` and
 * `bun.lock`, which are shared-repo surface this lane does not own. A
 * store-only archive needs no compressor, so the dependency question
 * disappears: method 0 is in the original PKWARE spec, every expander reads it,
 * and Lane B has been instructed to accept it.
 *
 * WHAT "STORE-ONLY" COSTS AND WHY IT IS ACCEPTABLE. The archive is the
 * transport for ONE upload, not a stored artifact — the server expands it and
 * keeps the files. Bytes on the wire are the only cost, and the upload reports
 * them honestly, so the user is never misled about the size of what they send.
 *
 * TWO THINGS THIS FILE REFUSES TO DO QUIETLY:
 *
 *   1. It never REWRITES a member name. An earlier draft filtered `..` and `.`
 *      segments out of a path, which turns `../etc/passwd` into `etc/passwd` —
 *      a DIFFERENT FILE, written without complaint, at a path the user never
 *      chose. A name that is not safe as given is REJECTED as given, and the
 *      caller surfaces it in `skipped[]`.
 *   2. It never emits an archive whose 32-bit fields cannot address its own
 *      payload. A corrupt archive that uploads successfully is the worst
 *      outcome available, because the user is told it worked.
 */

/** The 32-bit fields of a non-ZIP64 archive cannot address past this. */
export const ZIP_MAX_TOTAL_BYTES = 0xffffffff;
/** The end-of-central-directory entry counts are u16. */
export const ZIP_MAX_ENTRIES = 0xffff;
/** The file-name length field is u16, and it counts UTF-8 BYTES, not characters. */
export const ZIP_MAX_NAME_BYTES = 0xffff;

export class ZipTooLargeError extends Error {
  constructor(readonly limit: 'bytes' | 'entries') {
    super(
      limit === 'bytes'
        ? 'This folder is larger than a single archive can address (4 GiB).'
        : 'This folder holds more than 65,535 entries, which one archive cannot address.',
    );
    this.name = 'ZipTooLargeError';
  }
}

/**
 * Thrown when a caller hands the writer a name it will not encode. This is a
 * PROGRAMMING error by the time it reaches here — `rejectArchivePath` exists so
 * callers can classify the same names into `skipped[]` first — and it throws
 * rather than dropping the entry so a bad name can never leave silently.
 */
export class ZipInvalidPathError extends Error {
  constructor(readonly path: string, readonly reason: ArchivePathRejection) {
    super(`Refusing to archive ${JSON.stringify(path)}: ${reason}`);
    this.name = 'ZipInvalidPathError';
  }
}

let table: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (table) return table;
  const next = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    next[i] = c >>> 0;
  }
  table = next;
  return next;
}

/** CRC-32/ISO-HDLC, the checksum every zip entry carries. */
export function crc32(bytes: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type ArchivePathRejection =
  | 'absolute'
  | 'traversal'
  | 'empty-segment'
  | 'backslash'
  | 'drive-letter'
  | 'control-character'
  | 'name-too-long';

/**
 * Classifies a member name. `null` means "safe exactly as written"; anything
 * else is the reason it is refused, and the name is NOT repaired.
 *
 * ZIP-SLIP IS REFUSED HERE, ON THE WAY IN. The expander must defend itself too
 * — a client check is not a server's security boundary — but a client that
 * knowingly writes `../` into an archive is producing a hostile file, and this
 * one will not. A backslash is refused rather than translated because
 * `a\b.txt` is a legal single filename on POSIX, so "translating" it would
 * invent a directory the user does not have.
 */
export function rejectArchivePath(raw: string): ArchivePathRejection | null {
  if (raw.startsWith('/')) return 'absolute';
  if (raw.includes('\\')) return 'backslash';
  if (/^[a-zA-Z]:/.test(raw)) return 'drive-letter';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return 'control-character';
  const segments = raw.split('/');
  if (segments.length === 0) return 'empty-segment';
  for (const segment of segments) {
    if (segment === '') return 'empty-segment';
    if (segment === '.' || segment === '..') return 'traversal';
  }
  if (new TextEncoder().encode(raw).length > ZIP_MAX_NAME_BYTES) return 'name-too-long';
  return null;
}

/** `raw` when it is safe exactly as written, `null` when it must be refused. */
export function safeArchivePath(raw: string): string | null {
  return rejectArchivePath(raw) === null ? raw : null;
}

export interface ZipEntry {
  /** Archive-relative path, `/`-separated. Refused, never repaired, if unsafe. */
  path: string;
  /**
   * A DIRECTORY member carries no bytes and is written with a trailing `/`.
   * It exists so an EMPTY directory survives the round trip — without it, a
   * folder the user uploaded comes back missing structure they can see in their
   * own file manager, with nothing anywhere saying so.
   */
  kind?: 'file' | 'directory';
  bytes?: Uint8Array;
  modifiedAt?: Date;
}

const NO_BYTES = new Uint8Array(0);

function dosTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear();
  // The DOS epoch is 1980; a clock before it would encode as a negative year.
  const dosYear = year < 1980 ? 0 : year - 1980;
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: (dosYear << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Builds the archive. Returns the BYTES rather than a `Blob` so the suite can
 * assert the LAYOUT — signatures, offsets, the checksum — instead of asserting
 * that a blob exists, which would prove nothing about whether an expander can
 * read it.
 *
 * STRICT: an unsafe path throws. Callers that must tolerate one filter with
 * `rejectArchivePath` first and report what they dropped.
 */
export function buildStoreOnlyZip(entries: readonly ZipEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  if (entries.length > ZIP_MAX_ENTRIES) throw new ZipTooLargeError('entries');

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const rejection = rejectArchivePath(entry.path);
    if (rejection !== null) throw new ZipInvalidPathError(entry.path, rejection);

    const isDir = entry.kind === 'directory';
    const memberName = isDir ? `${entry.path}/` : entry.path;
    const name = encoder.encode(memberName);
    if (name.length > ZIP_MAX_NAME_BYTES) {
      // The trailing `/` can push a name that just fit over the u16 edge.
      throw new ZipInvalidPathError(entry.path, 'name-too-long');
    }

    const bytes = isDir ? NO_BYTES : (entry.bytes ?? NO_BYTES);
    const size = bytes.length;
    if (offset + 30 + name.length + size > ZIP_MAX_TOTAL_BYTES) throw new ZipTooLargeError('bytes');

    // A zero-byte file is a real file: CRC of nothing is 0, both sizes are 0,
    // and it must still get a local header and a central record or it vanishes.
    const sum = isDir ? 0 : crc32(bytes);
    const stamp = dosTime(entry.modifiedAt ?? new Date());

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed to extract
    lv.setUint16(6, 0x0800, true); // bit 11: the name is UTF-8
    lv.setUint16(8, 0, true); // method 0 — STORED
    lv.setUint16(10, stamp.time, true);
    lv.setUint16(12, stamp.date, true);
    lv.setUint32(14, sum, true);
    lv.setUint32(18, size, true); // compressed == uncompressed when stored
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, stamp.time, true);
    cv.setUint16(14, stamp.date, true);
    cv.setUint32(16, sum, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    // MS-DOS directory bit. Expanders that ignore the trailing `/` use this;
    // nothing here is ever marked executable.
    cv.setUint32(38, isDir ? 0x10 : 0, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, bytes);
    centrals.push(central);
    offset += local.length + size;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const parts = [...locals, ...centrals, end];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

export function zipBlob(entries: readonly ZipEntry[]): Blob {
  return new Blob([buildStoreOnlyZip(entries)], { type: 'application/zip' });
}
