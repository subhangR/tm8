/**
 * The file-upload slot sweep — 006's expiry function finally gets a caller.
 *
 * An upload is a three-step lifecycle (init → raw PUT → complete), and every
 * step can be the last one a client performs. Complete and abort clean up
 * after themselves; a client that simply vanishes leaves a `pending` slot and,
 * if the PUT finished, staged bytes on disk that no code path would ever
 * remove. This job closes that leak:
 *
 *   1. `public.sweep_file_upload_slots` (094) marks overdue pending slots
 *      `expired` and returns a bounded batch of expired/aborted slots whose
 *      bytes have not been purged.
 *   2. The node removes each slot's staged bytes from the blob store —
 *      idempotently; a slot that never staged bytes is an ENOENT, which is
 *      success.
 *   3. `public.mark_file_upload_slots_purged` writes the receipt, so a slot
 *      is offered at most until its bytes are provably gone.
 *
 * Per-slot failure isolation: one unremovable blob (say, a permissions error)
 * skips its receipt and is retried next tick; it never abandons the rest of
 * the batch.
 */

import type { Db, DbClaims } from '../../db/types.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const FILE_UPLOAD_SWEEP_JOB_NAME = 'files.upload-slot-sweep';

/** The two blob-store capabilities this job needs; the full store satisfies it. */
export interface SweepBlobStore {
  remove(storagePath: string, expectedSpaceId: string): Promise<void>;
}

export interface FileUploadSweepOptions {
  db: Db;
  /** Node-owner claims — the sweep doors are node-admin only. */
  claims: () => Promise<DbClaims>;
  blobStore: SweepBlobStore;
  /** Slots per tick. */
  batchSize?: number;
  intervalMs?: number;
  runOnStart?: boolean;
}

interface PurgeableSlot {
  uploadId: string;
  spaceId: string;
  storagePath: string;
}

function normalizePurgeable(raw: unknown): PurgeableSlot[] {
  if (!Array.isArray(raw)) return [];
  const out: PurgeableSlot[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (
      typeof row.uploadId !== 'string'
      || typeof row.spaceId !== 'string'
      || typeof row.storagePath !== 'string'
    ) continue;
    out.push({ uploadId: row.uploadId, spaceId: row.spaceId, storagePath: row.storagePath });
  }
  return out;
}

/** One tick, exported so tests and `scheduler.runNow` drive it without a timer. */
export async function runFileUploadSweepTick(
  options: FileUploadSweepOptions,
  signal?: AbortSignal,
  log?: (message: string) => void,
): Promise<JobOutcome> {
  const claims = await options.claims();
  const swept = await options.db.rpc<{ expired?: unknown; purgeable?: unknown }>(
    claims,
    'public.sweep_file_upload_slots',
    [options.batchSize ?? 100],
  );
  const expired = typeof swept?.expired === 'number' ? swept.expired : 0;
  const purgeable = normalizePurgeable(swept?.purgeable);
  if (expired === 0 && purgeable.length === 0) {
    return { skipped: true, reason: 'no overdue upload slots and no staged bytes to purge' };
  }

  const purgedIds: string[] = [];
  const problems: string[] = [];
  for (const slot of purgeable) {
    if (signal?.aborted) break;
    try {
      // ENOENT inside remove() is success: an expired slot whose PUT never
      // arrived has no bytes, and that is exactly the state we want.
      await options.blobStore.remove(slot.storagePath, slot.spaceId);
      purgedIds.push(slot.uploadId);
    } catch (error) {
      // Skipping the receipt re-offers this slot next tick.
      problems.push(`${slot.uploadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (purgedIds.length > 0) {
    await options.db.rpc(claims, 'public.mark_file_upload_slots_purged', [purgedIds]);
  }
  if (problems.length > 0) {
    log?.(`files.upload-slot-sweep: ${problems.length} blob(s) could not be removed: ${
      problems.slice(0, 5).join('; ')}`);
  }

  return {
    affected: expired + purgedIds.length,
    detail: {
      expired,
      purged: purgedIds.length,
      failed: problems.length,
    },
  };
}

// --- deleted-file blob purge -------------------------------------------------

export const FILE_BLOB_PURGE_JOB_NAME = 'files.deleted-blob-purge';

export interface FileBlobPurgeOptions {
  db: Db;
  claims: () => Promise<DbClaims>;
  blobStore: SweepBlobStore;
  /** Soft-delete grace before bytes are reclaimed. Default 30 days. */
  graceSeconds?: number;
  /** How long marked rows are re-offered so a crashed unlink is repaired. */
  retrySeconds?: number;
  batchSize?: number;
  intervalMs?: number;
  runOnStart?: boolean;
}

interface PurgeableBlob {
  entityId: string;
  spaceId: string;
  storagePath: string;
}

function normalizeBlobs(raw: unknown): PurgeableBlob[] {
  if (!Array.isArray(raw)) return [];
  const out: PurgeableBlob[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (
      typeof row.entityId !== 'string'
      || typeof row.spaceId !== 'string'
      || typeof row.storagePath !== 'string'
    ) continue;
    out.push({ entityId: row.entityId, spaceId: row.spaceId, storagePath: row.storagePath });
  }
  return out;
}

/**
 * One purge tick. The 094 door MARKS rows purged before returning them (so a
 * concurrent restore can never resurrect a file whose bytes we are about to
 * unlink), and re-offers recently marked rows; removal here is idempotent, so
 * both the happy path and the crash-repair path are the same loop.
 */
export async function runDeletedFileBlobPurgeTick(
  options: FileBlobPurgeOptions,
  signal?: AbortSignal,
  log?: (message: string) => void,
): Promise<JobOutcome> {
  const claims = await options.claims();
  const result = await options.db.rpc<{ purgeable?: unknown }>(
    claims,
    'public.purge_deleted_file_blobs',
    [options.graceSeconds ?? 30 * 24 * 3600, options.retrySeconds ?? 24 * 3600, options.batchSize ?? 100],
  );
  const purgeable = normalizeBlobs(result?.purgeable);
  if (purgeable.length === 0) {
    return { skipped: true, reason: 'no soft-deleted file blobs past their grace window' };
  }

  let removed = 0;
  const problems: string[] = [];
  for (const blob of purgeable) {
    if (signal?.aborted) break;
    try {
      await options.blobStore.remove(blob.storagePath, blob.spaceId);
      removed += 1;
    } catch (error) {
      problems.push(`${blob.entityId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (problems.length > 0) {
    log?.(`files.deleted-blob-purge: ${problems.length} blob(s) could not be removed: ${
      problems.slice(0, 5).join('; ')}`);
  }
  return { affected: removed, detail: { offered: purgeable.length, removed, failed: problems.length } };
}

export function createDeletedFileBlobPurgeJob(options: FileBlobPurgeOptions): ScheduledJob {
  return {
    name: FILE_BLOB_PURGE_JOB_NAME,
    // Daily, like the retention family it belongs beside — a purge with a
    // 30-day grace gains nothing from running hot.
    intervalMs: options.intervalMs ?? 24 * 60 * 60_000,
    jitterRatio: 0.1,
    runOnStart: options.runOnStart ?? true,
    timeoutMs: 10 * 60_000,
    async run(ctx: JobContext): Promise<JobOutcome> {
      return runDeletedFileBlobPurgeTick(options, ctx.signal, (m) => { ctx.logger.warn(m); });
    },
  };
}

export function createFileUploadSweepJob(options: FileUploadSweepOptions): ScheduledJob {
  return {
    name: FILE_UPLOAD_SWEEP_JOB_NAME,
    // Slots live 15 minutes; a 10-minute cadence bounds zombie pending slots
    // to roughly one grant lifetime without polling an idle node hard.
    intervalMs: options.intervalMs ?? 10 * 60_000,
    jitterRatio: 0.1,
    runOnStart: options.runOnStart ?? true,
    timeoutMs: 2 * 60_000,
    async run(ctx: JobContext): Promise<JobOutcome> {
      return runFileUploadSweepTick(options, ctx.signal, (m) => { ctx.logger.warn(m); });
    },
  };
}
