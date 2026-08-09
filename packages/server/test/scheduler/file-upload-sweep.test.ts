/**
 * The upload-slot sweep TICK — the node half of the 094 doors.
 *
 * The doors' own behaviour is proven in test/db/file-upload-sweep.pg.test.ts;
 * here the contract between the tick and the doors is what matters:
 *  - a receipt is written ONLY for slots whose bytes were actually removed —
 *    one failing blob is retried next tick, never receipted, and never
 *    abandons the rest of its batch;
 *  - an idle node reports `skipped`, so scheduler status reads honestly;
 *  - ENOENT is success (remove() already swallows it): an expired slot whose
 *    PUT never arrived purges cleanly.
 */
import { describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import {
  createDeletedFileBlobPurgeJob,
  createFileUploadSweepJob,
  FILE_BLOB_PURGE_JOB_NAME,
  FILE_UPLOAD_SWEEP_JOB_NAME,
  runDeletedFileBlobPurgeTick,
  runFileUploadSweepTick,
} from '../../src/scheduler/jobs/file-uploads.js';

const CLAIMS: DbClaims = { identityId: 'node-owner', nodeAdmin: true, requestId: 'test' };

class RpcDb implements Db {
  readonly calls: Array<{ fn: string; args: readonly unknown[] }> = [];
  constructor(private readonly responses: Record<string, (args: readonly unknown[]) => unknown>) {}

  async rpc<T>(_claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    this.calls.push({ fn, args });
    const impl = this.responses[fn];
    if (!impl) throw new Error(`unexpected rpc ${fn}`);
    return impl(args) as T;
  }

  async query<R>(): Promise<R[]> {
    throw new Error('unexpected query');
  }

  tx<T>(_claims: DbClaims, _fn: (q: Querier) => Promise<T>): Promise<T> {
    throw new Error('unexpected tx');
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

function slot(id: string, spaceId = '22222222-2222-4222-8222-222222222222') {
  return { uploadId: id, spaceId, storagePath: `spaces/${spaceId}/${id}` };
}

describe('files.upload-slot-sweep tick', () => {
  it('purges offered bytes, receipts exactly the removed ones, and isolates a failing blob', async () => {
    const good = slot('11111111-aaaa-4aaa-8aaa-111111111111');
    const bad = slot('11111111-bbbb-4bbb-8bbb-222222222222');
    const removed: string[] = [];
    const db = new RpcDb({
      'public.sweep_file_upload_slots': () => ({ expired: 3, purgeable: [good, bad] }),
      'public.mark_file_upload_slots_purged': (args) => {
        expect(args[0]).toEqual([good.uploadId]);
        return 1;
      },
    });
    const outcome = await runFileUploadSweepTick({
      db,
      claims: async () => CLAIMS,
      blobStore: {
        async remove(storagePath) {
          if (storagePath === bad.storagePath) throw new Error('EACCES: no');
          removed.push(storagePath);
        },
      },
    });
    expect(removed).toEqual([good.storagePath]);
    expect(outcome).toMatchObject({ affected: 4, detail: { expired: 3, purged: 1, failed: 1 } });
    expect(db.calls.map((c) => c.fn)).toEqual([
      'public.sweep_file_upload_slots',
      'public.mark_file_upload_slots_purged',
    ]);
  });

  it('reports skipped when nothing is overdue and writes no receipt', async () => {
    const db = new RpcDb({
      'public.sweep_file_upload_slots': () => ({ expired: 0, purgeable: [] }),
    });
    const outcome = await runFileUploadSweepTick({
      db,
      claims: async () => CLAIMS,
      blobStore: { remove: async () => { throw new Error('must not be called'); } },
    });
    expect(outcome.skipped).toBe(true);
    expect(db.calls.map((c) => c.fn)).toEqual(['public.sweep_file_upload_slots']);
  });

  it('expiry alone (no staged bytes) is an affected outcome, not a skip', async () => {
    const db = new RpcDb({
      'public.sweep_file_upload_slots': () => ({ expired: 2, purgeable: [] }),
    });
    const outcome = await runFileUploadSweepTick({
      db,
      claims: async () => CLAIMS,
      blobStore: { remove: async () => undefined },
    });
    expect(outcome).toMatchObject({ affected: 2, detail: { expired: 2, purged: 0, failed: 0 } });
  });

  it('deleted-blob purge removes what the mark-first door names and reports failures honestly', async () => {
    const gone = {
      entityId: '33333333-aaaa-4aaa-8aaa-111111111111',
      spaceId: '22222222-2222-4222-8222-222222222222',
      storagePath: 'spaces/22222222-2222-4222-8222-222222222222/33333333-aaaa-4aaa-8aaa-111111111111',
    };
    const stuck = {
      ...gone,
      entityId: '33333333-bbbb-4bbb-8bbb-222222222222',
      storagePath: 'spaces/22222222-2222-4222-8222-222222222222/33333333-bbbb-4bbb-8bbb-222222222222',
    };
    const removed: string[] = [];
    const db = new RpcDb({
      'public.purge_deleted_file_blobs': (args) => {
        expect(args).toEqual([30 * 24 * 3600, 24 * 3600, 100]);
        return { purgeable: [gone, stuck] };
      },
    });
    const outcome = await runDeletedFileBlobPurgeTick({
      db,
      claims: async () => CLAIMS,
      blobStore: {
        async remove(storagePath) {
          if (storagePath === stuck.storagePath) throw new Error('EACCES');
          removed.push(storagePath);
        },
      },
    });
    expect(removed).toEqual([gone.storagePath]);
    expect(outcome).toMatchObject({ affected: 1, detail: { offered: 2, removed: 1, failed: 1 } });
  });

  it('deleted-blob purge skips when the door names nothing', async () => {
    const db = new RpcDb({ 'public.purge_deleted_file_blobs': () => ({ purgeable: [] }) });
    const outcome = await runDeletedFileBlobPurgeTick({
      db,
      claims: async () => CLAIMS,
      blobStore: { remove: async () => { throw new Error('must not be called'); } },
    });
    expect(outcome.skipped).toBe(true);
  });

  it('builds a named job on the shared runner cadence', () => {
    const job = createFileUploadSweepJob({
      db: new RpcDb({}),
      claims: async () => CLAIMS,
      blobStore: { remove: async () => undefined },
    });
    expect(job.name).toBe(FILE_UPLOAD_SWEEP_JOB_NAME);
    expect(job.intervalMs).toBe(10 * 60_000);
    expect(job.runOnStart).toBe(true);

    const purgeJob = createDeletedFileBlobPurgeJob({
      db: new RpcDb({}),
      claims: async () => CLAIMS,
      blobStore: { remove: async () => undefined },
    });
    expect(purgeJob.name).toBe(FILE_BLOB_PURGE_JOB_NAME);
    expect(purgeJob.intervalMs).toBe(24 * 60 * 60_000);
  });
});
