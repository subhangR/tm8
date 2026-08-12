/**
 * THE ONE ZIP WRITER, in two shapes over one set of record builders.
 *
 * PROVENANCE: the record layout is `facade/services/w2/artifacts.ts` lifted
 * verbatim — same frozen choices, same byte output. It moved because a SECOND
 * caller appeared (`projects.files.archive`, folder download), and the
 * alternative to lifting was a copy. A copied zip writer is a bad copy to own:
 * the two would drift on the central-directory offsets, which is the part no
 * one reads by hand, so the drift would surface as a corrupt archive in
 * somebody's Downloads folder rather than as a failing test.
 *
 * THE FROZEN CHOICES (artifacts design §9.6), unchanged by the lift: entries in
 * caller order, no directory entries, all timestamps fixed to 1980-01-01,
 * external attrs 0644, STORED (no compression), no extra fields, no comment.
 * Consequence: an archive's SHA-256 is a pure function of its entries, so
 * "export is deterministic" stays a byte-equality test rather than a claim.
 *
 * TWO SHAPES, and why both:
 *
 *   - `buildDeterministicZip(files)` — everything in memory, one Buffer out.
 *     Artifact bundles are small and their whole point is byte-equality, so
 *     buffering is free and the determinism test can hash the result.
 *
 *   - `createZipStream(entries)` — an async source in, a `Readable` out. A
 *     project subtree is not small and is not bounded by anything the caller
 *     controls, so buffering one would make folder download a memory attack on
 *     the node. Peak memory here is ONE ENTRY, not one archive.
 *
 * WHY STREAMING STILL BUFFERS EACH ENTRY: a STORED local file header carries
 * the CRC-32 and the size BEFORE the bytes, so a producer must know both
 * before it may emit the header. The alternative is bit 3 + data descriptors,
 * which some consumers (notably older Windows Explorer) handle badly. Holding
 * one file is the honest cost of an archive every unzipper can open.
 */
import { Readable } from 'node:stream';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_DATE_1980 = 0x0021; // 1980-01-01: ((0)<<9)|(1<<5)|1
const DOS_TIME_ZERO = 0x0000;
const UTF8_NAME_FLAG = 0x0800; // general-purpose bit 11: filename is UTF-8
/** The frozen external-attributes choice of §9.6: unix mode 0644, high word. */
const EXTERNAL_ATTRS_0644 = (0o644 << 16) >>> 0;

/**
 * ZIP32 ceilings. Past these the central directory silently wraps and produces
 * an archive that extracts to garbage, so they are REFUSALS, not warnings.
 * ZIP64 is the fix if a real tree ever needs it; until then a caller that
 * would overflow gets told which limit it hit.
 */
export const ZIP32_MAX_ENTRIES = 0xffff;
export const ZIP32_MAX_BYTES = 0xffffffff;

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipLimitError';
  }
}

interface EntryRecords {
  local: Buffer;
  central: Buffer;
  /** Bytes this entry contributes to the local section: header + name + data. */
  advance: number;
}

/** The per-entry record pair. The one place the layout is written down. */
function entryRecords(path: string, bytes: Buffer, offset: number): EntryRecords {
  const name = Buffer.from(path, 'utf8');
  const crc = crc32(bytes);
  const size = bytes.length;

  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);       // local file header signature
  lfh.writeUInt16LE(20, 4);               // version needed to extract (2.0)
  lfh.writeUInt16LE(UTF8_NAME_FLAG, 6);   // general purpose bit flag
  lfh.writeUInt16LE(0, 8);                // compression method: STORED
  lfh.writeUInt16LE(DOS_TIME_ZERO, 10);
  lfh.writeUInt16LE(DOS_DATE_1980, 12);
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(size, 18);            // compressed size == size (STORED)
  lfh.writeUInt32LE(size, 22);            // uncompressed size
  lfh.writeUInt16LE(name.length, 26);
  lfh.writeUInt16LE(0, 28);               // extra field length

  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);       // central directory header signature
  cdh.writeUInt16LE((3 << 8) | 20, 4);    // version made by: unix (3), 2.0
  cdh.writeUInt16LE(20, 6);               // version needed to extract
  cdh.writeUInt16LE(UTF8_NAME_FLAG, 8);
  cdh.writeUInt16LE(0, 10);               // compression method: STORED
  cdh.writeUInt16LE(DOS_TIME_ZERO, 12);
  cdh.writeUInt16LE(DOS_DATE_1980, 14);
  cdh.writeUInt32LE(crc, 16);
  cdh.writeUInt32LE(size, 20);
  cdh.writeUInt32LE(size, 24);
  cdh.writeUInt16LE(name.length, 28);
  cdh.writeUInt16LE(0, 30);               // extra field length
  cdh.writeUInt16LE(0, 32);               // file comment length
  cdh.writeUInt16LE(0, 34);               // disk number start
  cdh.writeUInt16LE(0, 36);               // internal file attributes
  cdh.writeUInt32LE(EXTERNAL_ATTRS_0644, 38);
  cdh.writeUInt32LE(offset, 42);          // relative offset of local header

  return {
    local: Buffer.concat([lfh, name, bytes]),
    central: Buffer.concat([cdh, name]),
    advance: lfh.length + name.length + size,
  };
}

function endOfCentralDirectory(count: number, centralSize: number, centralOffset: number): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);        // end of central directory signature
  eocd.writeUInt16LE(0, 4);                 // number of this disk
  eocd.writeUInt16LE(0, 6);                 // disk with the central directory
  eocd.writeUInt16LE(count, 8);             // entries on this disk
  eocd.writeUInt16LE(count, 10);            // total entries
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);    // offset of central directory
  eocd.writeUInt16LE(0, 20);                // comment length
  return eocd;
}

/**
 * Buffered build — byte-identical to what `artifacts.ts` produced before the
 * lift, which is what its determinism test asserts.
 */
export function buildDeterministicZip(
  files: ReadonlyArray<{ path: string; bytes: Buffer }>,
): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const records = entryRecords(file.path, file.bytes, offset);
    local.push(records.local);
    central.push(records.central);
    offset += records.advance;
  }
  const localBuf = Buffer.concat(local);
  const centralBuf = Buffer.concat(central);
  return Buffer.concat([
    localBuf,
    centralBuf,
    endOfCentralDirectory(files.length, centralBuf.length, localBuf.length),
  ]);
}

export interface ZipStreamEntry {
  /** Archive-relative POSIX path. Never absolute, never containing `..`. */
  path: string;
  bytes: Buffer;
}

/**
 * Streaming build. `entries` is pulled lazily, so the caller decides when each
 * file is read off disk and only one is resident at a time.
 *
 * A source that throws mid-archive DESTROYS the stream rather than closing it
 * cleanly. The alternative — ending the response normally — would hand the
 * user a short archive that unzips without complaint and is missing files,
 * which is the one failure an archive must never have. The HTTP layer turns a
 * destroyed stream into a severed connection, and a severed download is a
 * visible failure.
 */
export function createZipStream(entries: AsyncIterable<ZipStreamEntry>): Readable {
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;

  async function* generate(): AsyncGenerator<Buffer> {
    for await (const entry of entries) {
      const records = entryRecords(entry.path, entry.bytes, offset);
      offset += records.advance;
      count += 1;
      if (count > ZIP32_MAX_ENTRIES) {
        throw new ZipLimitError(`archive exceeds the ${ZIP32_MAX_ENTRIES}-entry zip32 limit`);
      }
      if (offset > ZIP32_MAX_BYTES) {
        throw new ZipLimitError(`archive exceeds the ${ZIP32_MAX_BYTES}-byte zip32 limit`);
      }
      central.push(records.central);
      yield records.local;
    }
    const centralBuf = Buffer.concat(central);
    yield centralBuf;
    yield endOfCentralDirectory(count, centralBuf.length, offset);
  }

  return Readable.from(generate());
}
