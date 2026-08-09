// @vitest-environment jsdom
/**
 * The bounded upload queue — driven with controllable fake tasks, asserting
 * on SNAPSHOTS (what a screen would render), not on internal calls.
 */
import { describe, expect, it } from 'vitest';
import { UploadCancelledError, type FileUploadTask, type UploadedFile } from '../files/upload';
import type { ExplorerUploadCapability } from './port';
import { createUploadQueue } from './upload-queue';

interface Controlled {
  relativePath: string;
  resolve(): void;
  reject(error?: unknown): void;
  cancelled: boolean;
}

function controlledCapability(preservesPaths = false) {
  const started: Controlled[] = [];
  const capability: ExplorerUploadCapability = {
    preservesPaths,
    start(file, { relativePath }) {
      let settle!: { ok: (v: UploadedFile) => void; err: (e: unknown) => void };
      const result = new Promise<UploadedFile>((ok, err) => {
        settle = { ok, err };
      });
      const record: Controlled = {
        relativePath,
        resolve: () =>
          settle.ok({
            fileEntityId: 'e' as never,
            name: file.name,
            mime: 'text/plain',
            sizeBytes: file.size,
            maxSizeBytes: 1024,
          }),
        reject: (error) => settle.err(error ?? Object.assign(new Error('boom'), { code: 'forbidden' })),
        cancelled: false,
      };
      started.push(record);
      const task: FileUploadTask = {
        result,
        cancel() {
          record.cancelled = true;
          settle.err(new UploadCancelledError());
        },
      };
      return task;
    },
  };
  return { capability, started };
}

const pick = (name: string, relativePath = name) => ({
  file: new File(['abc'], name),
  relativePath,
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createUploadQueue', () => {
  it('starts at most `concurrency` uploads and pumps as items settle', async () => {
    const { capability, started } = controlledCapability();
    const queue = createUploadQueue(capability, { concurrency: 2 });
    queue.add([pick('a'), pick('b'), pick('c'), pick('d')]);
    expect(started).toHaveLength(2);
    expect(queue.snapshot().uploading).toBe(2);
    expect(queue.snapshot().queued).toBe(2);
    started[0]!.resolve();
    await tick();
    expect(started).toHaveLength(3);
    expect(queue.snapshot().done).toBe(1);
  });

  it('a failed item carries a SAFE reason and retry re-queues it', async () => {
    const { capability, started } = controlledCapability();
    const queue = createUploadQueue(capability, { concurrency: 1 });
    const [id] = queue.add([pick('a')]);
    started[0]!.reject();
    await tick();
    const failed = queue.snapshot().items[0]!;
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('You do not have permission to upload this file.');
    expect(failed.failureReason).not.toMatch(/boom/);
    queue.retry(id!);
    expect(queue.snapshot().items[0]!.status).toBe('uploading');
    expect(started).toHaveLength(2);
    expect(queue.snapshot().items[0]!.attempts).toBe(2);
  });

  it('cancel reaches an in-flight task; a queued item never starts', async () => {
    const { capability, started } = controlledCapability();
    const queue = createUploadQueue(capability, { concurrency: 1 });
    const [first, second] = queue.add([pick('a'), pick('b')]);
    queue.cancel(second!);
    queue.cancel(first!);
    await tick();
    expect(started).toHaveLength(1);
    expect(started[0]!.cancelled).toBe(true);
    const statuses = queue.snapshot().items.map((i) => i.status);
    expect(statuses).toEqual(['cancelled', 'cancelled']);
    expect(queue.snapshot().busy).toBe(false);
  });

  it('cancelAll settles everything and onItemDone fired only for real completions', async () => {
    const { capability, started } = controlledCapability();
    const queue = createUploadQueue(capability, { concurrency: 2 });
    const done: string[] = [];
    queue.onItemDone((item) => done.push(item.relativePath));
    queue.add([pick('a'), pick('b'), pick('c')]);
    started[0]!.resolve();
    await tick();
    queue.cancelAll();
    await tick();
    expect(done).toEqual(['a']);
    expect(queue.snapshot().done).toBe(1);
    expect(queue.snapshot().cancelled).toBe(2);
  });

  it('preserves the picker relative path on every item', () => {
    const { capability } = controlledCapability();
    const queue = createUploadQueue(capability, { concurrency: 1 });
    queue.add([pick('a.txt', 'a.txt')]);
    expect(queue.snapshot().items[0]!.relativePath).toBe('a.txt');
  });
});
