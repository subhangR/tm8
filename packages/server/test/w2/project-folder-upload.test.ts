import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';

import {
  materializeProjectFolder,
  normalizeProjectFolderManifest,
} from '../../src/facade/services/w2/project-folder-upload.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('project folder upload server validation', () => {
  it('rejects traversal, separator confusion, NULs, absolute paths, and collisions', () => {
    for (const relativePath of ['/etc/passwd', '../x', 'a/../x', 'a\\b', 'a//b', 'a/./b', 'a\0b']) {
      expect(() => normalizeProjectFolderManifest([
        { kind: 'directory', relativePath },
      ]), relativePath).toThrow();
    }

    expect(() => normalizeProjectFolderManifest([
      { kind: 'file', relativePath: 'README', sizeBytes: 1, checksumSha256: sha(Buffer.of(1)), mime: 'text/plain' },
      { kind: 'file', relativePath: 'readme', sizeBytes: 1, checksumSha256: sha(Buffer.of(2)), mime: 'text/plain' },
    ])).toThrow(/collision/i);
    expect(() => normalizeProjectFolderManifest([
      { kind: 'file', relativePath: 'src', sizeBytes: 1, checksumSha256: sha(Buffer.of(1)), mime: 'text/plain' },
      { kind: 'file', relativePath: 'src/index.ts', sizeBytes: 1, checksumSha256: sha(Buffer.of(2)), mime: 'text/plain' },
    ])).toThrow(/parent|collision/i);
    expect(() => normalizeProjectFolderManifest([
      { kind: 'directory', relativePath: 'caf\u00e9' },
      { kind: 'directory', relativePath: 'cafe\u0301' },
    ])).toThrow(/collision/i);
  });

  it('preserves binary identity, nested paths, hidden files, zero-byte files, and empty directories', async () => {
    const allowed = await mkdtemp(join(tmpdir(), 'tm8-folder-upload-'));
    roots.push(allowed);
    const binary = Buffer.from([0, 255, 1, 128, 42]);
    const empty = Buffer.alloc(0);
    const manifest = normalizeProjectFolderManifest([
      { kind: 'directory', relativePath: 'empty' },
      { kind: 'file', relativePath: '.hidden', sizeBytes: empty.length, checksumSha256: sha(empty), mime: 'application/octet-stream' },
      { kind: 'file', relativePath: 'nested/deep/data.bin', sizeBytes: binary.length, checksumSha256: sha(binary), mime: 'application/octet-stream' },
    ]);

    const result = await materializeProjectFolder({
      folderUploadId: '11111111-1111-4111-8111-111111111111',
      destinationParent: allowed,
      rootName: 'imported',
      manifest,
      allowedRoots: [allowed],
      readBytes: async (relativePath) => relativePath === '.hidden' ? empty : binary,
    });

    expect(await readFile(join(result.workingDir, 'nested/deep/data.bin'))).toEqual(binary);
    expect(await readFile(join(result.workingDir, '.hidden'))).toEqual(empty);
    expect((await stat(join(result.workingDir, 'empty'))).isDirectory()).toBe(true);
    expect(result).toMatchObject({
      fileCount: 2,
      directoryCount: 3,
      totalBytes: 5,
      addedCount: 2,
      replacedCount: 0,
      createdRoot: true,
    });
  });

  it('rejects a non-directory root, a root symlink, and a parent symlink escaping the allowed root', async () => {
    const allowed = await mkdtemp(join(tmpdir(), 'tm8-folder-allowed-'));
    const outside = await mkdtemp(join(tmpdir(), 'tm8-folder-outside-'));
    roots.push(allowed, outside);
    await writeFile(join(allowed, 'taken'), 'i am a file');
    await symlink(outside, join(allowed, 'escape'));
    const manifest = normalizeProjectFolderManifest([{ kind: 'directory', relativePath: 'empty' }]);
    const call = (destinationParent: string, rootName: string) => materializeProjectFolder({
      folderUploadId: '11111111-1111-4111-8111-111111111111',
      destinationParent,
      rootName,
      manifest,
      allowedRoots: [allowed],
      readBytes: async () => Buffer.alloc(0),
    });

    await expect(call(allowed, 'taken')).rejects.toThrow(/not a directory/i);
    // A symlink named like the root must NOT be merged into whatever it targets.
    await expect(call(allowed, 'escape')).rejects.toThrow(/not a directory/i);
    await expect(call(join(allowed, 'escape'), 'escaped')).rejects.toThrow(/outside|root|forbidden/i);
  });

  it('merges into an existing root: replaces named paths, adds new ones, leaves the rest alone', async () => {
    const allowed = await mkdtemp(join(tmpdir(), 'tm8-folder-merge-'));
    roots.push(allowed);
    const existingRoot = join(allowed, 'imported');
    await mkdir(join(existingRoot, 'src'), { recursive: true });
    await writeFile(join(existingRoot, 'src/index.ts'), 'old');
    await writeFile(join(existingRoot, 'keep-me.txt'), 'untouched');

    const replacement = Buffer.from('new');
    const added = Buffer.from('added');
    const manifest = normalizeProjectFolderManifest([
      { kind: 'file', relativePath: 'src/index.ts', sizeBytes: replacement.length, checksumSha256: sha(replacement), mime: 'text/plain' },
      { kind: 'file', relativePath: 'src/added.ts', sizeBytes: added.length, checksumSha256: sha(added), mime: 'text/plain' },
    ]);

    const result = await materializeProjectFolder({
      folderUploadId: '22222222-2222-4222-8222-222222222222',
      destinationParent: allowed,
      rootName: 'imported',
      manifest,
      allowedRoots: [allowed],
      readBytes: async (relativePath) => relativePath === 'src/index.ts' ? replacement : added,
    });

    expect(result).toMatchObject({ addedCount: 1, replacedCount: 1, createdRoot: false });
    expect(await readFile(join(existingRoot, 'src/index.ts'), 'utf8')).toBe('new');
    expect(await readFile(join(existingRoot, 'src/added.ts'), 'utf8')).toBe('added');
    // The path the manifest never named is still there, byte for byte.
    expect(await readFile(join(existingRoot, 'keep-me.txt'), 'utf8')).toBe('untouched');
    // Staging is an implementation detail and must not survive the call.
    expect(await readdir(allowed)).toEqual(['imported']);
  });

  it('refuses to replace a directory with a file, and never writes through a symlinked subdirectory', async () => {
    const allowed = await mkdtemp(join(tmpdir(), 'tm8-folder-hostile-'));
    const outside = await mkdtemp(join(tmpdir(), 'tm8-folder-target-'));
    roots.push(allowed, outside);
    const existingRoot = join(allowed, 'imported');
    await mkdir(join(existingRoot, 'src'), { recursive: true });
    await symlink(outside, join(existingRoot, 'linked'));
    const bytes = Buffer.from('payload');

    await expect(materializeProjectFolder({
      folderUploadId: '33333333-3333-4333-8333-333333333333',
      destinationParent: allowed,
      rootName: 'imported',
      manifest: normalizeProjectFolderManifest([
        { kind: 'file', relativePath: 'src', sizeBytes: bytes.length, checksumSha256: sha(bytes), mime: 'text/plain' },
      ]),
      allowedRoots: [allowed],
      readBytes: async () => bytes,
    })).rejects.toThrow(/exists as a directory/i);

    await expect(materializeProjectFolder({
      folderUploadId: '44444444-4444-4444-8444-444444444444',
      destinationParent: allowed,
      rootName: 'imported',
      manifest: normalizeProjectFolderManifest([
        { kind: 'file', relativePath: 'linked/escaped.txt', sizeBytes: bytes.length, checksumSha256: sha(bytes), mime: 'text/plain' },
      ]),
      allowedRoots: [allowed],
      readBytes: async () => bytes,
    })).rejects.toThrow(/outside the destination root/i);

    await expect(stat(join(outside, 'escaped.txt'))).rejects.toThrow();
  });

  it('leaves a pre-existing root and its files intact when byte verification fails', async () => {
    const allowed = await mkdtemp(join(tmpdir(), 'tm8-folder-merge-fail-'));
    roots.push(allowed);
    const existingRoot = join(allowed, 'imported');
    await mkdir(existingRoot, { recursive: true });
    await writeFile(join(existingRoot, 'src.txt'), 'original');

    const expected = Buffer.from('expected');
    const uploaded = Buffer.from('tampered');

    await expect(materializeProjectFolder({
      folderUploadId: '55555555-5555-4555-8555-555555555555',
      destinationParent: allowed,
      rootName: 'imported',
      manifest: normalizeProjectFolderManifest([
        { kind: 'file', relativePath: 'src.txt', sizeBytes: uploaded.length, checksumSha256: sha(expected), mime: 'text/plain' },
      ]),
      allowedRoots: [allowed],
      readBytes: async () => uploaded,
    })).rejects.toThrow(/checksum mismatch/i);

    expect(await readFile(join(existingRoot, 'src.txt'), 'utf8')).toBe('original');
  });

  it('removes only its newly reserved destination when byte verification fails', async () => {
    const allowed = await mkdtemp(join(tmpdir(), 'tm8-folder-cleanup-'));
    roots.push(allowed);
    const expected = Buffer.from('expected');
    const uploaded = Buffer.from('tampered');
    const manifest = normalizeProjectFolderManifest([
      {
        kind: 'file',
        relativePath: 'nested/payload.bin',
        sizeBytes: uploaded.length,
        checksumSha256: sha(expected),
        mime: 'application/octet-stream',
      },
    ]);

    await expect(materializeProjectFolder({
      folderUploadId: '11111111-1111-4111-8111-111111111111',
      destinationParent: allowed,
      rootName: 'failed-import',
      manifest,
      allowedRoots: [allowed],
      readBytes: async () => uploaded,
    })).rejects.toThrow(/checksum mismatch/i);

    await expect(stat(join(allowed, 'failed-import'))).rejects.toThrow();
  });
});
