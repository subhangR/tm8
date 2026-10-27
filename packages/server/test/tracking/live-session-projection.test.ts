// `badges.liveSession` (task P0g): is anyone really on a working or blocked
// task? The owner's policy (form 01a111ba-85b5, 6 Oct 2026) is FLAG ONLY, so
// this badge is the whole of the stale-status signal.

import { describe, expect, it } from 'vitest';

import {
  liveSessionOf,
  loadTaskLiveSessionBadges,
  PERSON_IDLE_AFTER_MS,
} from '../../src/tracking/live-session-projection.js';

import type { Querier } from '../../src/db/types.js';

const TASK = '01a111b2-aaf2-7690-9f9d-b15ceea0c0a5';
const S1 = '01a111b3-2fed-7b7c-958c-1f0544563ade';
const S2 = '01a111b3-1fbe-79e5-86e1-6fd39de5a99b';
const OWNER = '01a0fb3d-558f-73b3-a6e4-f6eaa3315c42';
const NOW = Date.parse('2026-10-06T16:00:00.000Z');

type Claim = Parameters<typeof liveSessionOf>[0][number];

function session(id: string, status: string, over: Partial<Claim> = {}): Claim {
  return {
    task_id: TASK, src_id: id, src_kind: 'work_session',
    props: { status: 'working', startedAt: '2026-10-06T10:00:00.000Z' },
    created_at: '2026-10-06T10:00:00.000Z',
    ws_status: status, ws_outcome: 'open', ws_status_changed_at: '2026-10-06T12:00:00.000Z',
    holder_last_message_at: null,
    ...over,
  };
}

function person(over: Partial<Claim> = {}): Claim {
  return {
    task_id: TASK, src_id: OWNER, src_kind: 'member',
    props: {}, created_at: '2026-10-02T06:44:00.000Z',
    ws_status: null, ws_outcome: null, ws_status_changed_at: null,
    holder_last_message_at: null,
    ...over,
  };
}

describe('liveSessionOf', () => {
  it('is live when an open session with a live process holds an active claim', () => {
    for (const status of ['spawning', 'running', 'idle']) {
      expect(liveSessionOf([session(S1, status)], NOW)).toEqual({
        state: 'live', since: '2026-10-06T10:00:00.000Z', sessionId: S1,
      });
    }
  });

  it('prefers a live session over a crashed one on the same task', () => {
    const v = liveSessionOf([session(S2, 'failed'), session(S1, 'running')], NOW);
    expect(v.state).toBe('live');
    expect(v.sessionId).toBe(S1);
  });

  it('is session_down when the only claims belong to sessions whose process is gone but whose outcome is open', () => {
    // Spec D1 R5: a crash keeps the claim; the chip reads "Session crashed".
    expect(liveSessionOf([session(S1, 'failed')], NOW)).toEqual({
      state: 'session_down', since: '2026-10-06T12:00:00.000Z', sessionId: S1,
    });
    expect(liveSessionOf([session(S1, 'exited')], NOW).state).toBe('session_down');
  });

  it('ignores a session whose outcome is completed or stopped, and an ended claim', () => {
    const v = liveSessionOf([
      session(S1, 'running', { ws_outcome: 'stopped' }),
      session(S2, 'running', {
        props: { startedAt: '2026-10-06T10:00:00.000Z', endedAt: '2026-10-06T13:00:00.000Z', endReason: 'released' },
      }),
    ], NOW);
    expect(v).toEqual({ state: 'no_session', since: '2026-10-06T13:00:00.000Z', sessionId: null });
  });

  it('is no_session with a null since when nobody ever claimed the task', () => {
    expect(liveSessionOf([], NOW)).toEqual({ state: 'no_session', since: null, sessionId: null });
  });

  it('is person while the holder acted on the task within 7 days, and person_idle after', () => {
    const recent = new Date(NOW - PERSON_IDLE_AFTER_MS + 60_000).toISOString();
    const old = '2026-09-02T06:44:00.000Z';
    expect(liveSessionOf([person({ created_at: old, holder_last_message_at: recent })], NOW)).toEqual({
      state: 'person', since: recent, sessionId: null,
    });
    // A claim and no message from its holder since: idle once 7 days pass.
    expect(liveSessionOf([person({ created_at: old })], NOW)).toEqual({
      state: 'person_idle', since: old, sessionId: null,
    });
    // The claim itself is activity: a fresh claim with no message is not idle.
    expect(liveSessionOf([person()], NOW).state).toBe('person');
  });

  it('lets any session claim outrank a person claim', () => {
    expect(liveSessionOf([person(), session(S1, 'failed')], NOW).state).toBe('session_down');
  });
});

describe('loadTaskLiveSessionBadges', () => {
  function fake(rows: unknown[]): Querier & { calls: number } {
    const q = {
      calls: 0,
      async query() { q.calls += 1; return rows; },
    };
    return q as unknown as Querier & { calls: number };
  }

  it('pays nothing for a page with no task', async () => {
    const q = fake([]);
    const out = await loadTaskLiveSessionBadges(q, [{ id: S1, kind: 'work_session' }], NOW);
    expect(out.size).toBe(0);
    expect(q.calls).toBe(0);
  });

  it('answers no_session for a working task the left join found no claim for', async () => {
    const q = fake([{ task_id: TASK, work_status: 'working', src_id: null, src_kind: null }]);
    const out = await loadTaskLiveSessionBadges(q, [{ id: TASK, kind: 'task' }], NOW);
    expect(out.get(TASK)).toEqual({ state: 'no_session', since: null, sessionId: null });
  });

  it('drops rows for other statuses and other ids (broad fakes answer every select)', async () => {
    const q = fake([
      { task_id: TASK, work_status: 'in_review', src_id: S1, src_kind: 'work_session' },
      { task_id: S2, work_status: 'working', src_id: S1, src_kind: 'work_session' },
    ]);
    const out = await loadTaskLiveSessionBadges(q, [{ id: TASK, kind: 'task' }], NOW);
    expect(out.size).toBe(0);
  });
});
