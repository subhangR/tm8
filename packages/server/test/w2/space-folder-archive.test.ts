import { describe, expect, it } from 'vitest';

import { crc32, parseSpaceFolderArchive } from '../../src/files/space-folder-archive.js';

interface ZipMember {
  name: string;
  bytes?: string;
  method?: number;
  unixMode?: number;
}

function zip(members: ZipMember[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let localOffset = 0;

  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8');
    const bytes = Buffer.from(member.bytes ?? '', 'utf8');
    const method = member.method ?? 0;
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30 + name.length + bytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    bytes.copy(local, 30 + name.length);
    locals.push(local);

    const record = Buffer.alloc(46 + name.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(
      (member.unixMode ?? (member.name.endsWith('/') ? 0o040755 : 0o100644)) * 0x10000,
      38,
    );
    record.writeUInt32LE(localOffset, 42);
    name.copy(record, 46);
    central.push(record);
    localOffset += local.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe('parseSpaceFolderArchive', () => {
  it('preserves regular files, zero-byte files, parents, and empty directories', () => {
    const parsed = parseSpaceFolderArchive(zip([
      { name: 'src/index.ts', bytes: 'export {};' },
      { name: 'empty.txt' },
      { name: 'assets/' },
    ]));

    expect(parsed.directories).toEqual(['assets', 'src']);
    expect(parsed.files.map(({ path, bytes }) => [path, bytes.toString('utf8')])).toEqual([
      ['empty.txt', ''],
      ['src/index.ts', 'export {};'],
    ]);
    expect(parsed.skipped).toEqual([]);
  });

  it('names every hostile or unsupported member it refuses', () => {
    const parsed = parseSpaceFolderArchive(zip([
      { name: '../secret.txt', bytes: 'no' },
      { name: '/absolute.txt', bytes: 'no' },
      { name: 'Readme.md', bytes: 'one' },
      { name: 'README.md', bytes: 'two' },
      { name: 'link', bytes: 'target', unixMode: 0o120777 },
      { name: 'compressed.txt', bytes: 'bytes', method: 8 },
    ]));

    expect(parsed.files.map(({ path }) => path)).toEqual(['Readme.md']);
    expect(parsed.skipped.map(({ path, reason }) => [path, reason])).toEqual([
      ['../secret.txt', 'path-traversal'],
      ['/absolute.txt', 'absolute-path'],
      ['README.md', 'duplicate-path'],
      ['link', 'not-a-regular-file'],
      ['compressed.txt', 'unsupported-compression'],
    ]);
  });

  it('refuses corrupt bytes and enforces member and expanded-byte ceilings', () => {
    const corrupt = zip([{ name: 'bad.txt', bytes: 'payload' }]);
    corrupt[37] = corrupt[37]! ^ 0xff;
    expect(parseSpaceFolderArchive(corrupt).skipped[0]).toMatchObject({
      path: 'bad.txt', reason: 'corrupt-member',
    });

    const limited = parseSpaceFolderArchive(zip([
      { name: 'first.txt', bytes: '12' },
      { name: 'second.txt', bytes: '34' },
      { name: 'third.txt', bytes: '56' },
    ]), { maxMembers: 2, maxExpandedBytes: 3 });
    expect(limited.files.map(({ path }) => path)).toEqual(['first.txt']);
    expect(limited.skipped.map(({ path, reason }) => [path, reason])).toEqual([
      ['second.txt', 'size-limit'],
      ['third.txt', 'member-limit'],
    ]);
  });

  it('rejects a structurally incomplete archive as a whole', () => {
    expect(() => parseSpaceFolderArchive(Buffer.from('not a zip'))).toThrow(/end-of-central-directory/);
  });
});
