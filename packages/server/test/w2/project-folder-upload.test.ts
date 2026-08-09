import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, stat, symlink } from 'node:fs/promises';
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
    expect(result).toMatchObject({ fileCount: 2, directoryCount: 3, totalBytes: 5 });
  });

  it('rejects an existing destination and a server parent symlink that escapes the allowed root', async () => {
    const allowed = await mkdtemp(join(tmpdir(), 'tm8-folder-allowed-'));
    const outside = await mkdtemp(join(tmpdir(), 'tm8-folder-outside-'));
    roots.push(allowed, outside);
    await mkdir(join(allowed, 'taken'));
    await symlink(outside, join(allowed, 'escape'));
    const manifest = normalizeProjectFolderManifest([{ kind: 'directory', relativePath: 'empty' }]);

    await expect(materializeProjectFolder({
      folderUploadId: '11111111-1111-4111-8111-111111111111',
      destinationParent: allowed,
      rootName: 'taken',
      manifest,
      allowedRoots: [allowed],
      readBytes: async () => Buffer.alloc(0),
    })).rejects.toThrow(/exists|conflict/i);

    await expect(materializeProjectFolder({
      folderUploadId: '11111111-1111-4111-8111-111111111111',
      destinationParent: join(allowed, 'escape'),
      rootName: 'escaped',
      manifest,
      allowedRoots: [allowed],
      readBytes: async () => Buffer.alloc(0),
    })).rejects.toThrow(/outside|root|forbidden/i);
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
