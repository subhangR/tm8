// The task_state loop's DECISION (prompt v2.0 spec §4, Q16), and the drain's
// contract with 207's doors.
//
// The invariant is the forge loops' one, restated for tasks: a session is told
// ONLY about a change it did not make, and ONLY while it can still act on it.

import { describe, expect, it } from 'vitest';

import type { Db, DbClaims } from '../../src/db/types.js';
import {
  decideTaskStateNudge,
  deliverPendingTaskNudges,
  normalizePendingTaskNudges,
  runTaskNudgeTick,
  taskStateBody,
  type PendingTaskNudge,
} from '../../src/tracking/task-nudges.js';

const SESSION = '44444444-4444-7444-8444-444444444444';
const TASK = '55555555-5555-7555-8555-555555555555';
const TEAMMATE = '66666666-6666-7666-8666-666666666666';
const HUMAN = '77777777-7777-7777-8777-777777777777';
const CLAIMS = { identityId: 'owner', nodeAdmin: false, requestId: 't' } as unknown as DbClaims;

function row(over: Partial<PendingTaskNudge> = {}): PendingTaskNudge {
  return {
    pendingId: '88888888-8888-7888-8888-888888888888',
    spaceId: '11111111-1111-7111-8111-111111111111',
    workSessionId: SESSION,
    taskId: TASK,
    loopKind: 'task_state',
    cause: 'cancelled',
    status: 'cancelled',
    actorId: HUMAN,
    teammateId: TEAMMATE,
    sessionStatus: 'running',
    attempts: 0,
    ...over,
  };
}

interface Call { fn: string; args: readonly unknown[] }

function fakeDb(results: Record<string, unknown>): { db: Db; calls: Call[] } {
  const calls: Call[] = [];
  const db = {
    rpc: async (_c: DbClaims, fn: string, args: readonly unknown[] = []) => {
      calls.push({ fn, args });
      const value = results[fn];
      if (value instanceof Error) throw value;
      return value ?? {};
    },
  } as unknown as Db;
  return { db, calls };
}

describe('decideTaskStateNudge', () => {
  it('tells a live session its task was cancelled by someone else', () => {
    expect(decideTaskStateNudge(row())).toEqual({
      send: true,
      body: `Task ${TASK} is now cancelled: stop and report.`,
    });
  });

  it('tells a live session its task was completed by someone else', () => {
    expect(decideTaskStateNudge(row({ cause: 'completed', status: 'done' }))).toEqual({
      send: true,
      body: `Task ${TASK} is now done: stop and report.`,
    });
  });

  it('tells a live session its teammate was unassigned', () => {
    expect(decideTaskStateNudge(row({ cause: 'unassigned', status: null }))).toEqual({
      send: true,
      body: `You were unassigned from task ${TASK}: stop and report.`,
    });
  });

  it('does not nudge a session about its own completion', () => {
    expect(decideTaskStateNudge(row({ cause: 'completed', status: 'done', actorId: TEAMMATE })))
      .toEqual({ send: false, reason: 'own_transition' });
  });

  it('does not nudge a session about its own cancellation or unassignment', () => {
    expect(decideTaskStateNudge(row({ actorId: TEAMMATE })).send).toBe(false);
    expect(decideTaskStateNudge(row({ cause: 'unassigned', status: null, actorId: TEAMMATE })).send)
      .toBe(false);
  });

  it('treats a write with no actor (a system path) as someone else', () => {
    expect(decideTaskStateNudge(row({ cause: 'completed', status: 'done', actorId: null })).send)
      .toBe(true);
  });

  it.each(['exited', 'failed', null])('does not nudge a session whose status is %s', (status) => {
    expect(decideTaskStateNudge(row({ sessionStatus: status })))
      .toEqual({ send: false, reason: 'session_not_live' });
  });

  it.each(['spawning', 'running', 'idle'])('nudges a %s session', (status) => {
    expect(decideTaskStateNudge(row({ sessionStatus: status })).send).toBe(true);
  });

  it('declines the loops S3 has not implemented yet', () => {
    expect(decideTaskStateNudge(row({ loopKind: 'closure' })))
      .toEqual({ send: false, reason: 'unsupported_loop' });
  });

  it('adds no prose beyond the fixed sentence', () => {
    expect(taskStateBody(row()).split('\n')).toHaveLength(1);
  });
});

describe('deliverPendingTaskNudges', () => {
  it('settles a suppressed row with its reason and posts nothing', async () => {
    const { db, calls } = fakeDb({});
    const result = await deliverPendingTaskNudges(db, CLAIMS, [row({ actorId: TEAMMATE })]);
    expect(result.suppressed).toBe(1);
    expect(calls.map((c) => c.fn)).toEqual(['public.settle_pending_task_nudge']);
    expect(calls[0]!.args).toEqual([row().pendingId, 'own_transition', null]);
  });

  it('posts once with a key per (session, task, loop), then dispatches the routes', async () => {
    const { db, calls } = fakeDb({
      'public.post_task_nudge': { posted: true, messageId: 'm1', workSessionId: SESSION },
      'public.w2_record_session_message_routes': [{ route: 1 }],
    });
    const dispatched: unknown[] = [];
    const result = await deliverPendingTaskNudges(db, CLAIMS, [row()], async (d) => {
      dispatched.push(d);
    });
    expect(result.delivered).toBe(1);
    const post = calls.find((c) => c.fn === 'public.post_task_nudge')!;
    expect(post.args[2]).toBe(`task-nudge:task_state:${SESSION}:${TASK}`);
    expect(dispatched).toEqual([{ routes: [{ route: 1 }], workSessionId: SESSION }]);
  });

  it('counts a duplicate the door refused and dispatches nothing', async () => {
    const { db } = fakeDb({ 'public.post_task_nudge': { posted: false, reason: 'duplicate' } });
    let dispatched = 0;
    const result = await deliverPendingTaskNudges(db, CLAIMS, [row()], async () => {
      dispatched += 1;
    });
    expect(result).toMatchObject({ delivered: 0, duplicates: 1 });
    expect(dispatched).toBe(0);
  });

  it('records a failed post on the row and leaves it for the next tick', async () => {
    const { db, calls } = fakeDb({ 'public.post_task_nudge': new Error('boom') });
    const result = await deliverPendingTaskNudges(db, CLAIMS, [row()]);
    expect(result.failed).toHaveLength(1);
    const settle = calls.find((c) => c.fn === 'public.settle_pending_task_nudge')!;
    expect(settle.args).toEqual([row().pendingId, null, 'boom']);
  });
});

describe('runTaskNudgeTick', () => {
  it('skips when nothing is queued', async () => {
    const { db } = fakeDb({ 'public.claim_pending_task_nudges': { pending: [] } });
    expect(await runTaskNudgeTick({ db, claims: async () => CLAIMS }))
      .toEqual({ skipped: true, reason: 'no queued task nudges' });
  });

  it('drops malformed rows rather than guessing', () => {
    expect(normalizePendingTaskNudges([{ ...row(), cause: 'renamed' }, { nope: 1 }, row()]))
      .toHaveLength(1);
  });
});
