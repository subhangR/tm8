import { describe, expect, it } from 'vitest';

import {
  PROJECT_FOLDER_UPLOAD_MAX_DIRECTORIES,
  PROJECT_FOLDER_UPLOAD_MAX_FILES,
  PROJECT_FOLDER_UPLOAD_MAX_PATH_BYTES,
  PROJECT_FOLDER_UPLOAD_MAX_TOTAL_BYTES,
  ProjectFolderUploadAbortInputSchema,
  ProjectFolderUploadCompleteInputSchema,
  ProjectFolderUploadGrantSchema,
  ProjectFolderUploadInitInputSchema,
  ProjectFolderUploadResultSchema,
  bindPath,
  getOperation,
} from '../src/index.js';

describe('client-machine project folder upload contract', () => {
  it('names a distinct init / complete / abort lifecycle', () => {
    expect(getOperation('projects.folderUploads.init')).toMatchObject({
      method: 'POST',
      path: '/v2/spaces/:spaceId/project-folder-uploads',
      kind: 'command',
      status: 'v1',
    });
    expect(bindPath('projects.folderUploads.complete', { folderUploadId: 'folder-1' }))
      .toBe('/v2/project-folder-uploads/folder-1/complete');
    expect(bindPath('projects.folderUploads.abort', { folderUploadId: 'folder-1' }))
      .toBe('/v2/project-folder-uploads/folder-1/abort');
  });

  it('accepts only relative POSIX manifest paths and permits empty files/directories', () => {
    const base = {
      clientMutationId: 'folder:init:1',
      projectName: 'Website',
      destinationParent: '/srv/projects',
      rootName: 'website',
      trust: 'untrusted' as const,
    };
    expect(ProjectFolderUploadInitInputSchema.parse({
      ...base,
      entries: [
        { kind: 'directory', relativePath: '.empty' },
        {
          kind: 'file',
          relativePath: 'assets/logo.bin',
          sizeBytes: 0,
          checksumSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          mime: 'application/octet-stream',
        },
      ],
    }).entries).toHaveLength(2);

    for (const relativePath of [
      '/etc/passwd',
      '../escape',
      'a/../escape',
      'a\\b.txt',
      'a//b.txt',
      'a/./b.txt',
      'nul\0byte',
    ]) {
      expect(ProjectFolderUploadInitInputSchema.safeParse({
        ...base,
        entries: [{ kind: 'directory', relativePath }],
      }).success, relativePath).toBe(false);
    }
  });

  it('publishes bounded grants and a project/root confirmation', () => {
    expect(PROJECT_FOLDER_UPLOAD_MAX_FILES).toBeGreaterThan(0);
    expect(PROJECT_FOLDER_UPLOAD_MAX_DIRECTORIES).toBeGreaterThan(0);
    expect(PROJECT_FOLDER_UPLOAD_MAX_TOTAL_BYTES).toBeGreaterThan(0);
    expect(PROJECT_FOLDER_UPLOAD_MAX_PATH_BYTES).toBeGreaterThan(0);

    expect(ProjectFolderUploadGrantSchema.safeParse({
      folderUploadId: '11111111-1111-4111-8111-111111111111',
      expiresAt: '2026-08-09T00:00:00.000Z',
      maxFiles: PROJECT_FOLDER_UPLOAD_MAX_FILES,
      maxDirectories: PROJECT_FOLDER_UPLOAD_MAX_DIRECTORIES,
      maxTotalBytes: PROJECT_FOLDER_UPLOAD_MAX_TOTAL_BYTES,
      maxPathBytes: PROJECT_FOLDER_UPLOAD_MAX_PATH_BYTES,
      files: [{
        relativePath: 'logo.bin',
        uploadId: '22222222-2222-4222-8222-222222222222',
        uploadUrl: '/v2/files/uploads/22222222-2222-4222-8222-222222222222/content',
        token: 'grant',
        expiresAt: '2026-08-09T00:00:00.000Z',
        maxSizeBytes: 512,
      }],
    }).success).toBe(true);

    expect(ProjectFolderUploadCompleteInputSchema.safeParse({ clientMutationId: 'folder:complete:1' }).success)
      .toBe(true);
    expect(ProjectFolderUploadAbortInputSchema.safeParse({ clientMutationId: 'folder:abort:1' }).success)
      .toBe(true);
    expect(ProjectFolderUploadResultSchema.safeParse({
      folderUploadId: '11111111-1111-4111-8111-111111111111',
      spaceId: '22222222-2222-4222-8222-222222222222',
      project: {
        id: '33333333-3333-4333-8333-333333333333',
        name: 'Website',
        workingDir: '/srv/projects/website',
        trust: 'untrusted',
        defaults: {},
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
      },
      rootName: 'website',
      fileCount: 1,
      directoryCount: 1,
      totalBytes: 0,
      replacedCount: 0,
    }).success).toBe(true);
  });
});
