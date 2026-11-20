import { describe, expect, it, vi } from 'vitest';
import { createFixtureSeam } from '../data';
import { createFileUploadTask, safeUploadReason, UploadCancelledError } from './upload';

const transient = () => Object.assign(new Error('lost response'), { code: 'upstream_unavailable', retryable: true });

async function setup() {
  const seam = createFixtureSeam();
  const spaceId = (await seam.spaces())[0]!.id;
  const anchorId = (await seam.query({ spaceId })).page.items[0]!.id;
  const files = {
    ...seam.files,
    uploadInit: vi.fn(seam.files.uploadInit),
    putBytes: vi.fn(seam.files.putBytes),
    complete: vi.fn(seam.files.complete),
    abort: vi.fn(seam.files.abort),
  };
  const file = new File(['finished work'], 'result.txt', { type: 'text/plain' });
  const options = { files, file, spaceId, anchorId, checksum: async () => 'a'.repeat(64), retry: { sleep: async () => {} } };
  return { files, options };
}

describe('upload recovery through the file seam', () => {
  it('recovers init and bytes with stable mutation ids and one attachment', async () => {
    const { files, options } = await setup();
    files.uploadInit.mockRejectedValueOnce(transient());
    files.putBytes.mockRejectedValueOnce(transient());
    const uploaded = await createFileUploadTask(options).result;
    expect(uploaded.name).toBe('result.txt');
    expect(files.uploadInit.mock.calls[0]![0]).toEqual(files.uploadInit.mock.calls[1]![0]);
    expect(files.putBytes.mock.calls[0]![0]).toBe(files.putBytes.mock.calls[1]![0]);
    expect(files.complete).toHaveBeenCalledTimes(1);
    expect(files.abort).not.toHaveBeenCalled();
  });

  it('recovers a lost completion receipt without retransferring or creating a second entity', async () => {
    const { files, options } = await setup();
    let originalId: string | undefined;
    const complete = files.complete.getMockImplementation()!;
    let stored: Awaited<ReturnType<typeof complete>> | undefined;
    files.complete.mockImplementation(async (...args) => {
      if (stored) return stored;
      stored = await complete(...args);
      originalId = stored.entity!.id;
      throw transient(); // The fixture committed; simulate the wire losing its receipt.
    });
    const uploaded = await createFileUploadTask(options).result;
    expect(uploaded.fileEntityId).toBe(originalId);
    expect(files.complete.mock.calls[0]).toEqual(files.complete.mock.calls[1]);
    expect(files.putBytes).toHaveBeenCalledTimes(1);
    expect(files.abort).not.toHaveBeenCalled();
  });

  it('keeps a transiently failed completion for the existing manual retry to resume', async () => {
    const { files, options } = await setup();
    for (let i = 0; i < 4; i++) files.complete.mockRejectedValueOnce(transient());
    const task = createFileUploadTask(options);
    const error = await task.result.catch((e: unknown) => e);
    expect(safeUploadReason(error)).toContain('Try again to resume.');
    expect(files.abort).not.toHaveBeenCalled();
    const uploaded = await createFileUploadTask(options).result;
    expect(uploaded.name).toBe('result.txt');
    expect(files.uploadInit).toHaveBeenCalledTimes(1);
    expect(files.putBytes).toHaveBeenCalledTimes(1);
    expect(new Set(files.complete.mock.calls.map((call) => call[1].clientMutationId)).size).toBe(1);
  });

  it('shares a concurrent start and stops immediately on permanent refusal', async () => {
    const { files, options } = await setup();
    files.putBytes.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { code: 'forbidden', retryable: false }));
    const task = createFileUploadTask(options);
    expect(createFileUploadTask(options)).toBe(task);
    await expect(task.result).rejects.toHaveProperty('code', 'forbidden');
    expect(files.putBytes).toHaveBeenCalledTimes(1);
    expect(files.abort).toHaveBeenCalledTimes(1);
  });

  it('keeps a grant whose other writer still holds a lease for retry', async () => {
    const { files, options } = await setup();
    files.putBytes.mockRejectedValueOnce(Object.assign(new Error('writer in progress'), { code: 'conflict', retryable: false }));
    await expect(createFileUploadTask(options).result).resolves.toHaveProperty('name', 'result.txt');
    expect(files.putBytes).toHaveBeenCalledTimes(2);
    expect(files.abort).not.toHaveBeenCalled();
  });

  it('cancels during backoff, aborts once and never retries the bytes', async () => {
    const { files, options } = await setup();
    files.putBytes.mockRejectedValueOnce(transient());
    let retrying!: () => void;
    const waiting = new Promise<void>((resolve) => { retrying = resolve; });
    const task = createFileUploadTask({ ...options, retry: { onRetry: retrying } });
    const result = task.result.catch((e: unknown) => e);
    await waiting;
    task.cancel();
    expect(await result).toBeInstanceOf(UploadCancelledError);
    expect(files.abort).toHaveBeenCalledTimes(1);
    expect(files.putBytes).toHaveBeenCalledTimes(1);
  });
});
