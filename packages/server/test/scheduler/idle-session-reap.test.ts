/**
 * Idle reaping — a paused conversation must stop costing a process.
 *
 * The row already guarantees the conversation: `session resume` relaunches the
 * agent with the full prior conversation restored. The PROCESS guarantees only
 * that scrollback is attachable, and it costs the agent's whole resident
 * context to do it. Measured on a live node: fourteen `idle` sessions at
 * 408–487 MB each, 6.2 GB, none of them doing anything.
 *
 * These pin the three things that make reaping safe rather than merely
 * effective: it takes only `idle`, it never touches a row whose process is
 * already gone, and it says nothing at all when it is switched off.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createIdleSessionReapJob,
  resolveIdleReapMinutes,
} from '../../src/scheduler/jobs/idle-sessions.js';

const CTX = { now: () => new Date() } as never;

function db(rows: Array<{ entity_id: string; idle_minutes: number }>) {
  return {
    query: vi.fn().mockResolvedValue(rows),
    tx: vi.fn(),
    rpc: vi.fn(),
    end: vi.fn(),
  } as never;
}

function execution(live: string[]) {
  return {
    hasSession: (id: string) => live.includes(id),
    terminate: vi.fn().mockResolvedValue(undefined),
  };
}

const claims = async () => ({ identityId: 'id_owner', nodeAdmin: true, requestId: 'r' });

describe('resolveIdleReapMinutes', () => {
  it('is OFF unless a node opts in', () => {
    expect(resolveIdleReapMinutes({})).toBe(0);
    expect(resolveIdleReapMinutes({ TM8_SESSION_IDLE_REAP_MINUTES: '' })).toBe(0);
    expect(resolveIdleReapMinutes({ TM8_SESSION_IDLE_REAP_MINUTES: 'off' })).toBe(0);
    expect(resolveIdleReapMinutes({ TM8_SESSION_IDLE_REAP_MINUTES: '0' })).toBe(0);
  });

  it('never turns a typo into a SHORTER window', () => {
    // The dangerous direction: a malformed value that reaped after one minute
    // would kill sessions nobody asked it to. Off is the safe reading.
    expect(resolveIdleReapMinutes({ TM8_SESSION_IDLE_REAP_MINUTES: 'sixty' })).toBe(0);
    expect(resolveIdleReapMinutes({ TM8_SESSION_IDLE_REAP_MINUTES: '-5' })).toBe(0);
    expect(resolveIdleReapMinutes({ TM8_SESSION_IDLE_REAP_MINUTES: '30' })).toBe(30);
  });
});

describe('the idle session reaper', () => {
  it('does nothing, and says why, when it is switched off', async () => {
    const exec = execution(['s1']);
    const job = createIdleSessionReapJob({
      db: db([{ entity_id: 's1', idle_minutes: 99 }]),
      claims, execution: exec, idleMinutes: 0,
    });

    const outcome = await job.run(CTX);

    expect(outcome.skipped).toBe(true);
    expect(outcome.reason).toMatch(/off/);
    expect(exec.terminate).not.toHaveBeenCalled();
  });

  it('reaps an idle session and keeps the conversation, saying so in the reason', async () => {
    const exec = execution(['s1']);
    const job = createIdleSessionReapJob({
      db: db([{ entity_id: 's1', idle_minutes: 42 }]),
      claims, execution: exec, idleMinutes: 30,
    });

    const outcome = await job.run(CTX);

    expect(outcome.affected).toBe(1);
    expect(exec.terminate).toHaveBeenCalledTimes(1);
    const reason = exec.terminate.mock.calls[0]?.[2]?.reason as string;
    // The reason a human reads on the card must tell them nothing was lost.
    expect(reason).toMatch(/42m idle/);
    expect(reason).toMatch(/resume/);
  });

  it('leaves a row whose process is already gone to ghost reconciliation', async () => {
    // That row is a ghost, and its honest explanation is a node restart — not
    // "idle". Overwriting the reason would make a crash look like a timeout.
    const exec = execution([]);
    const job = createIdleSessionReapJob({
      db: db([{ entity_id: 'ghost', idle_minutes: 500 }]),
      claims, execution: exec, idleMinutes: 30,
    });

    const outcome = await job.run(CTX);

    expect(exec.terminate).not.toHaveBeenCalled();
    expect(outcome.affected).toBe(0);
    expect(outcome.detail?.['skippedAsGhosts']).toBe(1);
  });

  it('reports a refusal instead of counting it as nothing to do', async () => {
    // The failure mode that hid ghost reconciliation for weeks: a swept-nothing
    // and a refused-everything both reading as zero.
    const exec = execution(['s1']);
    exec.terminate = vi.fn().mockRejectedValue(new Error('not a member of this space'));
    const job = createIdleSessionReapJob({
      db: db([{ entity_id: 's1', idle_minutes: 40 }]),
      claims, execution: exec, idleMinutes: 30,
    });

    const outcome = await job.run(CTX);

    expect(outcome.affected).toBe(0);
    expect(outcome.detail?.['failures']).toHaveLength(1);
    expect(String((outcome.detail?.['failures'] as string[])[0])).toMatch(/not a member/);
  });

  it('asks the database for idle rows only, never running ones', async () => {
    // The guarantee that matters most: a long turn is not an abandoned one, and
    // this job must never be why a working agent died.
    const database = db([]);
    const job = createIdleSessionReapJob({
      db: database, claims, execution: execution([]), idleMinutes: 30,
    });

    await job.run(CTX);

    const sql = String((database as never as { query: { mock: { calls: unknown[][] } } }).query.mock.calls[0]?.[1]);
    expect(sql).toContain("status = 'idle'");
    expect(sql).not.toContain("'running'");
    expect(sql).not.toContain("'spawning'");
  });
});
