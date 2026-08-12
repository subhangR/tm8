/**
 * The orphaned-agent-credential sweep TICK — the node half of the 100 doors.
 *
 * The doors themselves are proven in test/db/phase0-containment.pg.test.ts.
 * What matters here is the contract between the tick and the doors, and one
 * ordering property that is easy to get backwards:
 *
 *  - the PTY table is read AFTER the database, so a session that spawns during
 *    the round trip is treated as live and spared. Erring toward "leave it
 *    alone" is right for a credential its owner may still be using; the next
 *    tick catches it if it really is dead.
 *  - an idle node reports `skipped`, so scheduler status reads honestly rather
 *    than claiming work it did not do.
 *  - the live set handed to the revoke door is the PTY's, never the database's
 *    — that is the whole safety property, since `work_sessions.status` is
 *    writable by any space member.
 */
import { describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import {
  AGENT_SESSION_SWEEP_JOB_NAME,
  createAgentSessionSweepJob,
  runAgentSessionSweepTick,
  type LiveSessionSource,
} from '../../src/scheduler/jobs/agent-sessions.js';

const NODE_ID = 'node-a:4610';
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

  async query<R>(): Promise<R[]> { throw new Error('unexpected query'); }
  tx<T>(_c: DbClaims, _f: (q: Querier) => Promise<T>): Promise<T> { throw new Error('unexpected tx'); }
  end(): Promise<void> { return Promise.resolve(); }
}

const ptyWith = (ids: string[]): LiveSessionSource => ({ liveSessionIds: () => ids });

function options(db: Db, pty: LiveSessionSource) {
  return { db, pty, nodeId: NODE_ID, claims: async () => CLAIMS };
}

describe('identity.agent-session-sweep tick', () => {
  it('revokes the credentials whose PTY is gone and spares the ones that are live', async () => {
    const db = new RpcDb({
      'public.live_agent_session_work_ids': () => ['s-live', 's-dead-1', 's-dead-2'],
      'public.revoke_orphaned_agent_sessions': () => ({
        revoked: 2, workSessionIds: ['s-dead-1', 's-dead-2'],
      }),
    });

    const outcome = await runAgentSessionSweepTick(options(db, ptyWith(['s-live'])));

    expect(outcome).toMatchObject({ affected: 2 });
    expect(outcome.detail).toMatchObject({ outstanding: 3, live: 1, revoked: 2 });

    // The live set passed to the door is the PTY's, and the node id bounds it.
    const revoke = db.calls.find((c) => c.fn === 'public.revoke_orphaned_agent_sessions');
    expect(revoke?.args[0]).toBe(NODE_ID);
    expect(revoke?.args[1]).toEqual(['s-live']);
  });

  it('does not call the revoke door at all when every credential has a live PTY', async () => {
    const db = new RpcDb({
      'public.live_agent_session_work_ids': () => ['s-a', 's-b'],
      'public.revoke_orphaned_agent_sessions': () => {
        throw new Error('must not revoke when nothing is orphaned');
      },
    });

    const outcome = await runAgentSessionSweepTick(options(db, ptyWith(['s-a', 's-b'])));

    expect(outcome).toMatchObject({ skipped: true });
    expect(db.calls.map((c) => c.fn)).toEqual(['public.live_agent_session_work_ids']);
  });

  it('reports skipped without touching the PTY when this node holds no credentials', async () => {
    const db = new RpcDb({
      'public.live_agent_session_work_ids': () => [],
      'public.revoke_orphaned_agent_sessions': () => { throw new Error('must not revoke'); },
    });
    const pty: LiveSessionSource = {
      liveSessionIds: () => { throw new Error('must not read the PTY table'); },
    };

    expect(await runAgentSessionSweepTick(options(db, pty))).toMatchObject({ skipped: true });
  });

  it('revokes everything when the node holds no PTYs — the boot repair', async () => {
    const db = new RpcDb({
      'public.live_agent_session_work_ids': () => ['s-a', 's-b', 's-c'],
      'public.revoke_orphaned_agent_sessions': () => ({ revoked: 3, workSessionIds: [] }),
    });

    const outcome = await runAgentSessionSweepTick(options(db, ptyWith([])));

    expect(outcome).toMatchObject({ affected: 3 });
    const revoke = db.calls.find((c) => c.fn === 'public.revoke_orphaned_agent_sessions');
    expect(revoke?.args[1]).toEqual([]);
  });

  it('spares a session that spawns between the database read and the PTY read', async () => {
    // The ordering property. `s-new` is not in the door's answer because it did
    // not exist when that query ran, but it IS live by the time the PTY is read
    // — and the revoke door is told it is live, so it is never a victim.
    const db = new RpcDb({
      'public.live_agent_session_work_ids': () => ['s-old'],
      'public.revoke_orphaned_agent_sessions': () => ({ revoked: 1, workSessionIds: ['s-old'] }),
    });

    await runAgentSessionSweepTick(options(db, ptyWith(['s-new'])));

    const revoke = db.calls.find((c) => c.fn === 'public.revoke_orphaned_agent_sessions');
    expect(revoke?.args[1]).toContain('s-new');
  });

  it('runs on start, because a restarted node holds no PTYs', () => {
    const job = createAgentSessionSweepJob(options(new RpcDb({}), ptyWith([])));
    expect(job.name).toBe(AGENT_SESSION_SWEEP_JOB_NAME);
    expect(job.runOnStart).toBe(true);
    expect(job.intervalMs).toBe(5 * 60_000);
  });
});
