/**
 * W7b: the remote_ref watcher is a clock around `poll_remote_refs` (274). The
 * SQL half — referenced ids only, signed-in links only, the system actor — is
 * celled in db/remote-refs.pg.test.ts; this pins the job's own contract.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DbClaims } from '../../src/db/types.js';
import {
  createRemoteRefWatcherJob,
  REMOTE_REF_WATCHER_JOB_NAME,
  runRemoteRefWatcherTick,
} from '../../src/scheduler/jobs/remote-ref-watcher.js';

const ownerClaims = { identityId: 'identity-owner', nodeAdmin: true, requestId: 'remote-ref-watcher' } as DbClaims;

describe('W7b remote_ref watcher job', () => {
  it('polls once per tick under the node-owner claims, with the batch size', async () => {
    const rpc = vi.fn(async () => ({ polled: 4, changed: 1 }));
    const outcome = await runRemoteRefWatcherTick({ db: { rpc } as never, claims: async () => ownerClaims, batchSize: 50 });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0]).toEqual([ownerClaims, 'poll_remote_refs', [50]]);
    expect(outcome).toEqual({ affected: 1, detail: { polled: 4, changed: 1 } });
  });

  it('nothing to poll is a skip with a reason, never a silent no-op', async () => {
    const rpc = vi.fn(async (..._args: unknown[]) => ({ polled: 0, changed: 0 }));
    expect(await runRemoteRefWatcherTick({ db: { rpc } as never, claims: async () => ownerClaims }))
      .toEqual({ skipped: true, reason: 'no remote_ref on a signed-in link' });
    expect(rpc.mock.calls[0]?.[2]).toEqual([200]);
  });

  it('a refused poll (not node admin) propagates, so the scheduler records the failure', async () => {
    const rpc = vi.fn(async () => { throw Object.assign(new Error('node admin only'), { details: { sqlstate: '42501' } }); });
    await expect(runRemoteRefWatcherTick({ db: { rpc } as never, claims: async () => ownerClaims }))
      .rejects.toThrow('node admin only');
  });

  it('registers as a scheduled job that runs at boot', () => {
    const job = createRemoteRefWatcherJob({ db: { rpc: vi.fn() } as never, claims: async () => ownerClaims });
    expect(job).toMatchObject({ name: REMOTE_REF_WATCHER_JOB_NAME, intervalMs: 30_000, runOnStart: true });
  });
});
