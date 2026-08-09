import type { SpaceFolderSkippedMember } from '@tm8/contract';

export const SPACE_FOLDER_MAX_MEMBERS = 50_000;
export const SPACE_FOLDER_MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
export const SPACE_FOLDER_MAX_PATH_BYTES = 1_024;

export interface ParsedSpaceFolderFile {
  path: string;
  bytes: Buffer;
}

export interface ParsedSpaceFolderArchive {
  directories: string[];
  files: ParsedSpaceFolderFile[];
  skipped: SpaceFolderSkippedMember[];
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_ZIP_COMMENT = 0xffff;
const decoder = new TextDecoder('utf-8', { fatal: true });

let crcTableValue: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (crcTableValue) return crcTableValue;
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  crcTableValue = table;
  return table;
}

export function crc32(bytes: Uint8Array): number {
  const table = crcTable();
  let value = 0xffffffff;
  for (const byte of bytes) value = table[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function skip(path: string, reason: SpaceFolderSkippedMember['reason'], detail: string): SpaceFolderSkippedMember {
  return { path, reason, detail };
}

function classifyPath(raw: string): SpaceFolderSkippedMember['reason'] | null {
  if (raw.length === 0) return 'empty-path';
  if (raw.startsWith('/')) return 'absolute-path';
  if (raw.includes('\\')) return 'backslash-path';
  if (/^[A-Za-z]:/.test(raw)) return 'absolute-path';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return 'control-character';
  const segments = raw.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return segments.some((segment) => segment === '.' || segment === '..')
      ? 'path-traversal'
      : 'empty-path';
  }
  if (Buffer.byteLength(raw, 'utf8') > SPACE_FOLDER_MAX_PATH_BYTES) return 'path-too-long';
  return null;
}

function collisionKey(path: string): string {
  return path.normalize('NFC').toLocaleLowerCase('en-US');
}

function addParents(path: string, directories: Set<string>): void {
  const segments = path.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    directories.add(segments.slice(0, index).join('/'));
  }
}

function findEnd(buffer: Buffer): number {
  const floor = Math.max(0, buffer.length - (22 + MAX_ZIP_COMMENT));
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD) return offset;
  }
  throw new Error('archive has no ZIP end-of-central-directory record');
}

/**
 * Parse the deliberately small upload dialect: one-disk, non-ZIP64 ZIP with
 * STORED members. Unsupported or hostile members are reported by name; a
 * corrupt directory structure rejects the archive as a whole.
 */
export function parseSpaceFolderArchive(
  buffer: Buffer,
  options: { maxMembers?: number; maxExpandedBytes?: number } = {},
): ParsedSpaceFolderArchive {
  const maxMembers = options.maxMembers ?? SPACE_FOLDER_MAX_MEMBERS;
  const maxExpandedBytes = options.maxExpandedBytes ?? SPACE_FOLDER_MAX_EXPANDED_BYTES;
  const end = findEnd(buffer);
  const disk = buffer.readUInt16LE(end + 4);
  const centralDisk = buffer.readUInt16LE(end + 6);
  const entriesOnDisk = buffer.readUInt16LE(end + 8);
  const entryCount = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  const commentLength = buffer.readUInt16LE(end + 20);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('multi-disk ZIP archives are not supported');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported');
  }
  if (end + 22 + commentLength !== buffer.length || centralOffset + centralSize !== end) {
    throw new Error('archive central directory bounds are invalid');
  }

  const files: ParsedSpaceFolderFile[] = [];
  const directories = new Set<string>();
  const skipped: SpaceFolderSkippedMember[] = [];
  const seen = new Map<string, string>();
  let expanded = 0;
  let cursor = centralOffset;

  for (let ordinal = 0; ordinal < entryCount; ordinal += 1) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== CENTRAL) {
      throw new Error('archive central directory is corrupt');
    }
    const madeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const expandedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const memberCommentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttrs = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + memberCommentLength;
    if (next > end) throw new Error('archive member metadata is truncated');

    let rawName: string;
    try {
      rawName = decoder.decode(buffer.subarray(cursor + 46, cursor + 46 + nameLength));
    } catch {
      skipped.push(skip('<invalid-utf8>', 'corrupt-member', 'member name is not valid UTF-8'));
      cursor = next;
      continue;
    }
    const directoryMarker = rawName.endsWith('/');
    const path = directoryMarker ? rawName.slice(0, -1) : rawName;
    const rejection = classifyPath(path);
    if (rejection) {
      skipped.push(skip(rawName, rejection, 'member path was refused exactly as supplied'));
      cursor = next;
      continue;
    }
    if (ordinal >= maxMembers) {
      skipped.push(skip(rawName, 'member-limit', `archive exceeds ${maxMembers} members`));
      cursor = next;
      continue;
    }
    const key = collisionKey(path);
    const previous = seen.get(key);
    if (previous !== undefined) {
      skipped.push(skip(rawName, 'duplicate-path', `collides with ${previous}`));
      cursor = next;
      continue;
    }
    seen.set(key, path);

    const platform = madeBy >>> 8;
    const unixMode = platform === 3 ? (externalAttrs >>> 16) & 0xffff : 0;
    const unixType = unixMode & 0o170000;
    const dosDirectory = (externalAttrs & 0x10) !== 0;
    const isDirectory = directoryMarker || dosDirectory || unixType === 0o040000;
    if (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) {
      skipped.push(skip(rawName, 'not-a-regular-file', 'links and special filesystem members are not imported'));
      cursor = next;
      continue;
    }
    if ((flags & 0x1) !== 0 || method !== 0 || compressedSize !== expandedSize) {
      skipped.push(skip(rawName, 'unsupported-compression', 'only unencrypted STORED ZIP members are accepted'));
      cursor = next;
      continue;
    }
    if (isDirectory) {
      if (expandedSize !== 0) {
        skipped.push(skip(rawName, 'corrupt-member', 'directory member declares content bytes'));
      } else {
        directories.add(path);
        addParents(path, directories);
      }
      cursor = next;
      continue;
    }
    if (expanded + expandedSize > maxExpandedBytes) {
      skipped.push(skip(rawName, 'size-limit', `expanded bytes exceed ${maxExpandedBytes}`));
      cursor = next;
      continue;
    }
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== LOCAL) {
      skipped.push(skip(rawName, 'corrupt-member', 'local file header is missing'));
      cursor = next;
      continue;
    }
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (localMethod !== 0 || dataEnd > centralOffset) {
      skipped.push(skip(rawName, 'corrupt-member', 'member content bounds are invalid'));
      cursor = next;
      continue;
    }
    const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    const centralName = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    if (!localName.equals(centralName)) {
      skipped.push(skip(rawName, 'corrupt-member', 'local and central member names disagree'));
      cursor = next;
      continue;
    }
    const bytes = buffer.subarray(dataOffset, dataEnd);
    if (crc32(bytes) !== expectedCrc) {
      skipped.push(skip(rawName, 'corrupt-member', 'CRC-32 verification failed'));
      cursor = next;
      continue;
    }
    files.push({ path, bytes: Buffer.from(bytes) });
    addParents(path, directories);
    expanded += expandedSize;
    cursor = next;
  }

  if (cursor !== end) throw new Error('archive central directory length is inconsistent');
  return {
    directories: [...directories].sort((left, right) => {
      const depth = left.split('/').length - right.split('/').length;
      return depth === 0 ? left.localeCompare(right) : depth;
    }),
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    skipped,
  };
}
