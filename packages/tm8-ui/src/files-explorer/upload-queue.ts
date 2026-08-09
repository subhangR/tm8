/**
 * THE EXPLORER UPLOAD QUEUE — many files, one honest ledger.
 *
 * `files/upload.ts` owns ONE canonical grant lifecycle; this module owns the
 * MANY: bounded concurrency, per-item retry/cancel, and progress a screen can
 * subscribe to. It performs no transport of its own — every byte still moves
 * through the port's `ExplorerUploadCapability`, which is `createFileUploadTask`
 * under the real seam.
 *
 * CONCURRENCY IS BOUNDED (default 3): a directory drop can be thousands of
 * files, and an unbounded fan-out would open thousands of grants at once —
 * the server's grant slots and the browser's connection pool both say no.
 * The bound is per-queue and deliberately small; it is a courtesy to the
 * node, not a throughput optimisation.
 *
 * PROGRESS IS PHASE-HONEST, not percent-fake: the underlying task exposes no
 * byte counter (a fetch PUT cannot report upload progress), so an item is
 * `queued → uploading → done | failed | cancelled` and the queue's headline
 * counts phases. Inventing a moving bar over a number nobody measures is the
 * D7.2 lie in animation form.
 */
import type { FileUploadTask } from '../files/upload';
import { safeUploadReason, UploadCancelledError } from '../files/upload';
import type { ExplorerUploadCapability } from './port';

export type UploadItemStatus = 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled';

export interface UploadQueueItem {
  id: string;
  name: string;
  /** Root-relative destination path, preserved from the picker/drop. */
  relativePath: string;
  sizeBytes: number;
  status: UploadItemStatus;
  /** Safe copy only — never server prose or transport paths. */
  failureReason: string | null;
  /** How many times this item has been retried. */
  attempts: number;
}

export interface UploadQueueSnapshot {
  items: UploadQueueItem[];
  queued: number;
  uploading: number;
  done: number;
  failed: number;
  cancelled: number;
  /** True while anything is queued or in flight. */
  busy: boolean;
}

export interface UploadQueue {
  snapshot(): UploadQueueSnapshot;
  subscribe(cb: (snap: UploadQueueSnapshot) => void): () => void;
  /** Add files; returns their item ids. `relativePath` keeps picker structure. */
  add(files: ReadonlyArray<{ file: File; relativePath: string }>): string[];
  retry(itemId: string): void;
  cancel(itemId: string): void;
  cancelAll(): void;
  /** Fires once per item that completes successfully. */
  onItemDone(cb: (item: UploadQueueItem) => void): () => void;
}

export function createUploadQueue(
  capability: ExplorerUploadCapability,
  opts?: { concurrency?: number },
): UploadQueue {
  const concurrency = Math.max(1, opts?.concurrency ?? 3);
  const items: UploadQueueItem[] = [];
  const filesById = new Map<string, File>();
  const tasksById = new Map<string, FileUploadTask>();
  const listeners = new Set<(snap: UploadQueueSnapshot) => void>();
  const doneListeners = new Set<(item: UploadQueueItem) => void>();
  let inFlight = 0;
  let nextId = 0;

  function snapshot(): UploadQueueSnapshot {
    const count = (status: UploadItemStatus) => items.filter((i) => i.status === status).length;
    const queued = count('queued');
    const uploading = count('uploading');
    return {
      items: items.map((i) => ({ ...i })),
      queued,
      uploading,
      done: count('done'),
      failed: count('failed'),
      cancelled: count('cancelled'),
      busy: queued > 0 || uploading > 0,
    };
  }

  function emit() {
    const snap = snapshot();
    for (const cb of listeners) cb(snap);
  }

  function pump() {
    while (inFlight < concurrency) {
      const item = items.find((i) => i.status === 'queued');
      if (!item) return;
      const file = filesById.get(item.id);
      if (!file) {
        item.status = 'failed';
        item.failureReason = 'File is no longer available to upload.';
        continue;
      }
      item.status = 'uploading';
      item.attempts += 1;
      inFlight += 1;
      const task = capability.start(file, { relativePath: item.relativePath });
      tasksById.set(item.id, task);
      void task.result
        .then(() => {
          item.status = 'done';
          item.failureReason = null;
          for (const cb of doneListeners) cb({ ...item });
        })
        .catch((error: unknown) => {
          if (error instanceof UploadCancelledError || item.status === 'cancelled') {
            item.status = 'cancelled';
            item.failureReason = null;
          } else {
            item.status = 'failed';
            item.failureReason = safeUploadReason(error);
          }
        })
        .finally(() => {
          inFlight -= 1;
          tasksById.delete(item.id);
          emit();
          pump();
        });
    }
  }

  return {
    snapshot,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    add(files) {
      const ids: string[] = [];
      for (const { file, relativePath } of files) {
        const id = `u${nextId++}`;
        ids.push(id);
        filesById.set(id, file);
        items.push({
          id,
          name: file.name,
          relativePath,
          sizeBytes: file.size,
          status: 'queued',
          failureReason: null,
          attempts: 0,
        });
      }
      emit();
      pump();
      return ids;
    },
    retry(itemId) {
      const item = items.find((i) => i.id === itemId);
      if (!item || (item.status !== 'failed' && item.status !== 'cancelled')) return;
      item.status = 'queued';
      item.failureReason = null;
      emit();
      pump();
    },
    cancel(itemId) {
      const item = items.find((i) => i.id === itemId);
      if (!item) return;
      if (item.status === 'queued') {
        item.status = 'cancelled';
        emit();
        return;
      }
      if (item.status === 'uploading') {
        item.status = 'cancelled';
        tasksById.get(itemId)?.cancel();
        emit();
      }
    },
    cancelAll() {
      for (const item of items) {
        if (item.status === 'queued') item.status = 'cancelled';
        else if (item.status === 'uploading') {
          item.status = 'cancelled';
          tasksById.get(item.id)?.cancel();
        }
      }
      emit();
    },
    onItemDone(cb) {
      doneListeners.add(cb);
      return () => doneListeners.delete(cb);
    },
  };
}
