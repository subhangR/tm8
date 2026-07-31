// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { CommandResult, FileUploadGrant } from '@tm8/contract';
import { createChatAttachmentUploadTask, safeUploadReason } from './chat-attachments';

function completedFile(): CommandResult {
  return {
    patches: [],
    entity: {
      id: 'file-1',
      spaceId: 'space-1',
      kind: 'file',
      title: 'plan.txt',
      parentId: null,
      position: 0,
      visibility: 'space',
      version: 1,
      activityAt: '2026-07-30T00:00:00.000Z',
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
      deletedAt: null,
      createdBy: { id: 'member-1', displayName: 'Ada', isAgent: false },
      counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
      badges: {},
      state: { kind: 'file', name: 'plan.txt', mimeType: 'text/plain', sizeBytes: 4 },
      content: { kind: 'file' },
      hierarchy: { parent: null, children: { items: [], nextCursor: null }, path: [] },
      connections: { incoming: [], outgoing: [], unresolvedHardDependencyCount: 0 },
      capabilities: {
        canEdit: true, canDelete: true, canAddChild: false, canLink: true,
        canPull: false, canReact: true, canGrantPoints: false, canComplete: false,
      },
    },
  } as CommandResult;
}

function harness() {
  const grant: FileUploadGrant = {
    uploadId: 'upload-1',
    uploadUrl: '/v2/files/uploads/upload-1/content',
    token: 'grant-1',
    expiresAt: '2026-07-30T12:00:00.000Z',
    maxSizeBytes: 1024,
  };
  const files = {
    uploadInit: vi.fn().mockResolvedValue(grant),
    putBytes: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(completedFile()),
    abort: vi.fn().mockResolvedValue({ patches: [] }),
  };
  let id = 0;
  return { files, grant, newMutationId: () => `mutation-${++id}` };
}

describe('canonical Chat attachment upload task', () => {
  it('hashes, grants, PUTs raw bytes, and completes to the canonical file entity', async () => {
    const h = harness();
    const file = new File(['plan'], 'plan.txt', { type: 'text/plain' });
    const task = createChatAttachmentUploadTask({
      files: h.files,
      file,
      spaceId: 'space-1',
      anchorId: 'session-1',
      newMutationId: h.newMutationId,
      checksum: vi.fn().mockResolvedValue('a'.repeat(64)),
    });

    await expect(task.result).resolves.toEqual({
      fileEntityId: 'file-1',
      name: 'plan.txt',
      mime: 'text/plain',
      sizeBytes: 4,
      maxSizeBytes: 1024,
    });
    expect(h.files.uploadInit).toHaveBeenCalledWith({
      clientMutationId: 'mutation-1',
      spaceId: 'space-1',
      entityId: 'session-1',
      name: 'plan.txt',
      mime: 'text/plain',
      sizeBytes: 4,
      checksumSha256: 'a'.repeat(64),
    });
    expect(h.files.putBytes).toHaveBeenCalledWith(h.grant, file);
    expect(h.files.complete).toHaveBeenCalledWith('upload-1', { clientMutationId: 'mutation-2' });
    expect(h.files.abort).not.toHaveBeenCalled();
  });

  it('best-effort aborts the grant after a byte-write failure and exposes only safe copy', async () => {
    const h = harness();
    h.files.putBytes.mockRejectedValue(new Error('s3://private-bucket/token'));
    const task = createChatAttachmentUploadTask({
      files: h.files,
      file: new File(['plan'], 'plan.txt', { type: 'text/plain' }),
      spaceId: 'space-1',
      anchorId: 'session-1',
      newMutationId: h.newMutationId,
      checksum: vi.fn().mockResolvedValue('b'.repeat(64)),
    });

    await expect(task.result).rejects.toThrow('s3://private-bucket/token');
    expect(h.files.abort).toHaveBeenCalledWith('upload-1', { clientMutationId: 'mutation-2' });
    expect(safeUploadReason(await task.result.catch((error) => error))).toBe('Upload failed. Try again.');
  });

  it('cancels through files.uploadAbort and never finalizes the file', async () => {
    const h = harness();
    let release!: () => void;
    h.files.putBytes.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const task = createChatAttachmentUploadTask({
      files: h.files,
      file: new File(['plan'], 'plan.txt', { type: 'text/plain' }),
      spaceId: 'space-1',
      anchorId: 'session-1',
      newMutationId: h.newMutationId,
      checksum: vi.fn().mockResolvedValue('c'.repeat(64)),
    });
    await vi.waitFor(() => expect(h.files.putBytes).toHaveBeenCalled());
    task.cancel();
    release();

    await expect(task.result).rejects.toMatchObject({ name: 'ChatUploadCancelledError' });
    expect(h.files.abort).toHaveBeenCalledTimes(1);
    expect(h.files.complete).not.toHaveBeenCalled();
  });
});
