/**
 * The credential-session ending sweep TICK (360). The door's own behaviour —
 * which rows it reaps and which it keeps — is proven against real Postgres in
 * test/db/credential-service.pg.test.ts; here: the tick calls the node-admin
 * door with the grace and batch, runs at boot, and reads honestly when idle.
 */
import { describe, expect, it } from 'vitest';

import type { DbClaims } from '../../src/db/types.js';
import {
  createCredentialSessionEndingSweepJob,
  CREDENTIAL_SESSION_ENDING_SWEEP_JOB_NAME,
  runCredentialSessionEndingSweepTick,
} from '../../src/scheduler/jobs/credential-session-ending-sweep.js';

const claims: DbClaims = { identityId: 'owner', nodeAdmin: true, requestId: 'credential-session-ending-sweep' };

function fakeDb(reaped: string[]) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  return {
    calls,
    db: {
      rpc: async <T,>(_claims: DbClaims, fn: string, args: unknown[] = []): Promise<T> => {
        calls.push({ fn, args });
        return { reaped } as T;
      },
    },
  };
}

describe('credential-session ending sweep tick', () => {
  it('calls the node-admin door with the grace and batch, and counts what it reaped', async () => {
    const { db, calls } = fakeDb(['a', 'b']);
    const outcome = await runCredentialSessionEndingSweepTick({ db, claims: async () => claims });
    expect(calls).toEqual([{ fn: 'public.credential_session_ending_sweep', args: ['600 seconds', 200] }]);
    expect(outcome).toEqual({ affected: 2, detail: { reaped: 2 } });
  });

  it('reports skipped when nothing was left live past its lease', async () => {
    const { db } = fakeDb([]);
    const outcome = await runCredentialSessionEndingSweepTick({ db, claims: async () => claims, graceSeconds: 60 });
    expect(outcome).toMatchObject({ skipped: true });
  });

  it('runs at boot, so a restart clears what the last run left', () => {
    const job = createCredentialSessionEndingSweepJob({ db: fakeDb([]).db, claims: async () => claims });
    expect(job.name).toBe(CREDENTIAL_SESSION_ENDING_SWEEP_JOB_NAME);
    expect(job.runOnStart).toBe(true);
  });
});
