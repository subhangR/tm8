/**
 * SPEC D1 §5 — the session's words, tabs, line 2 and verbs, case by case.
 *
 * One test per row of the §5.1 table and one per awkward case of §5.3.1, named
 * for the row or case it proves. These are the UI half of the §9 acceptance
 * evidence; the server half lives in packages/server/test/db/session-outcome-*.
 */
import { describe, expect, it } from 'vitest';
import {
  offeredCountOf,
  claimTally,
  SESSION_TABS,
  SESSION_TAB_FILTERS,
  capRefusalHint,
  claimsFromEdges,
  crossTabBreadcrumb,
  groupSessionRows,
  interruptedGroupOf,
  sessionCategoryOf,
  sessionHeadline,
  sessionLineTwo,
  sessionNeedsAttentionOf,
  sessionOutcomeOf,
  sessionRowWord,
  sessionTabOf,
  sessionVerbsOf,
  withGrace,
  type SessionClaim,
} from './session-outcome';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function session(over: Record<string, unknown> = {}) {
  return {
    kind: 'work_session',
    status: 'running',
    agentTool: 'claude-code',
    model: null,
    shareMode: 'none',
    startedAt: ago(5 * HOUR),
    exitedAt: null,
    endedKind: null,
    endedReason: null,
    ...over,
  };
}

const claim = (over: Partial<SessionClaim> = {}): SessionClaim => ({
  taskId: 't1',
  title: 'Task A',
  status: 'working',
  ...over,
});

const ctx = { now: NOW };

describe('§3 the two fields', () => {
  it('an absent outcome reads as open (pre-301 node)', () => {
    expect(sessionOutcomeOf(session())).toBe('open');
    expect(sessionOutcomeOf(session({ outcome: 'completed' }))).toBe('completed');
  });

  it('§3.2 category is outcome first, then process', () => {
    expect(sessionCategoryOf(session({ outcome: 'completed', status: 'running' }))).toBe('done');
    expect(sessionCategoryOf(session({ outcome: 'stopped', status: 'exited' }))).toBe('cancelled');
    expect(sessionCategoryOf(session({ status: 'spawning' }))).toBe('to_do');
    for (const status of ['running', 'idle', 'exited', 'failed']) {
      expect(sessionCategoryOf(session({ status }))).toBe('in_progress');
    }
    expect(sessionCategoryOf({ kind: 'task', status: 'open' })).toBeUndefined();
  });
});

describe('§5.1 words, tones and icons', () => {
  it('row 1 — Starting: open / spawning', () => {
    const w = sessionRowWord(session({ status: 'spawning' }), 'not-running', ctx)!;
    expect([w.word, w.tone, w.icon, w.dot]).toEqual(['Starting', 'wait', 'spinner', null]);
  });

  it('row 2 — Working (or Streaming): open / running, live, green pulsing dot', () => {
    const w = sessionRowWord(session(), 'live', ctx)!;
    expect([w.word, w.tone, w.icon, w.dot, w.attention]).toEqual(['Working', 'run', 'ring-dot', 'green', false]);
    expect(sessionRowWord(session(), 'live', { ...ctx, streaming: true })!.word).toBe('Streaming');
  });

  it('row 3 — Waiting for you: open / idle with pending forms, amber, attention', () => {
    const w = sessionRowWord(session({ status: 'idle' }), 'live', { ...ctx, waiting: true })!;
    expect([w.word, w.tone, w.dot, w.attention]).toEqual(['Waiting for you', 'wait', 'amber', true]);
  });

  it('row 4 — Completed, process still open: ✓ "Finished, still open", grey process dot, Running tab', () => {
    const s = session({ outcome: 'completed', status: 'running', outcomeAt: ago(12 * MIN), receiptMessageId: 'm1' });
    const w = sessionRowWord(s, 'live', ctx)!;
    expect([w.word, w.tone, w.icon, w.dot, w.attention]).toEqual(['Finished, still open', 'done', 'check', 'grey', false]);
    expect(sessionTabOf(s)).toBe('running');
    expect(sessionLineTwo(s, 'live', ctx)).toBe('Completed 12m ago · receipt');
  });

  it('row 5 — Completed, process closed: Completed, no dot, Completed tab', () => {
    const s = session({ outcome: 'completed', status: 'exited', endedKind: 'exited_clean', outcomeAt: ago(12 * MIN), receiptMessageId: 'm1' });
    const w = sessionRowWord(s, 'not-running', ctx)!;
    expect([w.word, w.tone, w.icon, w.dot]).toEqual(['Completed', 'done', 'check', null]);
    expect(sessionTabOf(s)).toBe('completed');
    expect(sessionLineTwo(s, 'not-running', ctx)).toBe('Completed 12m ago · receipt');
  });

  it('row 6 — Stopped before completing: Stopped, filled square, "Stopped by <name> 3h ago"', () => {
    const s = session({ outcome: 'stopped', status: 'exited', outcomeBy: 'm-subhang', outcomeAt: ago(3 * HOUR) });
    const w = sessionRowWord(s, 'not-running', ctx)!;
    expect([w.word, w.tone, w.icon, w.dot]).toEqual(['Stopped', 'idle', 'square', null]);
    expect(sessionLineTwo(s, 'not-running', { ...ctx, actorName: () => 'Subhang' })).toBe('Stopped by Subhang 3h ago');
    expect(sessionTabOf(s)).toBe('stopped');
  });

  it('row 7 — Crashed with the reason: red, ring with X, attention, "Crashed 5m ago: out of memory"', () => {
    const s = session({ status: 'failed', endedKind: 'out_of_memory', endedReason: 'Out of memory.', exitedAt: ago(5 * MIN) });
    const w = sessionRowWord(s, 'not-running', ctx)!;
    expect([w.word, w.tone, w.icon, w.dot, w.attention]).toEqual(['Crashed', 'block', 'ring-x', 'red', true]);
    expect(sessionLineTwo(s, 'not-running', ctx)).toBe('Crashed 5m ago: out of memory');
    expect(sessionHeadline(s, 'not-running', ctx)).toBe('Crashed: out of memory');
    expect(sessionTabOf(s)).toBe('interrupted');
  });

  it('row 8 — Credential revoked: "Credential disconnected", red, attention, outcome still open', () => {
    const s = session({ status: 'failed', endedKind: 'credential_revoked', exitedAt: ago(MIN) });
    const w = sessionRowWord(s, 'not-running', ctx)!;
    expect([w.word, w.tone, w.dot, w.attention]).toEqual(['Credential disconnected', 'block', 'red', true]);
    expect(sessionOutcomeOf(s)).toBe('open');
  });

  it('row 9a — Ghost before the reaper: Stale, amber hollow, stays in Running', () => {
    const s = session({ status: 'running' });
    const w = sessionRowWord(s, 'stale', ctx)!;
    expect([w.word, w.tone, w.dot]).toEqual(['Stale', 'wait', 'amber-hollow']);
    expect(sessionTabOf(s)).toBe('running');
  });

  it('row 9b — Ghost after the reaper: Lost, red, attention, Interrupted', () => {
    const s = session({ status: 'failed', endedKind: 'lost' });
    const w = sessionRowWord(s, 'not-running', ctx)!;
    expect([w.word, w.tone, w.dot, w.attention]).toEqual(['Lost', 'block', 'red', true]);
    expect(sessionTabOf(s)).toBe('interrupted');
  });

  it('row 10 — Process ended without completing: "Ended, not completed", plain ring, no dot, attention', () => {
    // A clean exit while a claim is still being worked (scenario 11).
    const s = session({ status: 'exited', endedKind: 'exited_clean' });
    const w = sessionRowWord(s, 'not-running', { ...ctx, claims: [claim()] })!;
    expect([w.word, w.tone, w.icon, w.dot, w.attention]).toEqual(['Ended, not completed', 'wait', 'ring', null, true]);
    expect(sessionVerbsOf(s)).toEqual(['resume', 'complete-session', 'dismiss-session']);
  });

  it('row 11 — Failed to start: open / failed with no endedKind, red, attention', () => {
    const w = sessionRowWord(session({ status: 'failed' }), 'not-running', ctx)!;
    expect([w.word, w.tone, w.dot, w.attention]).toEqual(['Failed to start', 'block', 'red', true]);
  });
});

describe('§5.2 row actions by case', () => {
  it('working or waiting: Complete (tick) and Terminate', () => {
    expect(sessionVerbsOf(session(), 'live')).toEqual(['complete-session', 'terminate']);
    expect(sessionVerbsOf(session({ status: 'idle' }), 'live')).toEqual(['complete-session', 'terminate']);
  });
  it('completed, process open: Stop only (closes the process, no dialog)', () => {
    expect(sessionVerbsOf(session({ outcome: 'completed' }), 'live')).toEqual(['close-process']);
  });
  it('completed, process closed: Follow-up', () => {
    // Q2 = B (owner, 6 Oct): Reopen (a logged resume) beside Follow-up.
    expect(sessionVerbsOf(session({ outcome: 'completed', status: 'exited' }))).toEqual(['reopen-session', 'follow-up']);
  });
  it('stopped: Resume', () => {
    expect(sessionVerbsOf(session({ outcome: 'stopped', status: 'exited' }))).toEqual(['resume']);
  });
  it('crashed, lost, credential disconnected, ended: Resume and Complete (and Dismiss)', () => {
    for (const endedKind of ['crashed', 'lost', 'credential_revoked', 'exited_clean']) {
      const status = endedKind === 'exited_clean' ? 'exited' : 'failed';
      expect(sessionVerbsOf(session({ status, endedKind }))).toEqual(['resume', 'complete-session', 'dismiss-session']);
    }
  });
});

describe('§5.3 tabs', () => {
  it('the four server filters match the brief', () => {
    expect(SESSION_TABS.map((t) => t.id)).toEqual(['running', 'interrupted', 'completed', 'stopped']);
    expect(SESSION_TAB_FILTERS.running).toMatchObject({ sessionStatus: ['spawning', 'running', 'idle'], sessionOutcome: ['open', 'completed'] });
    expect(SESSION_TAB_FILTERS.interrupted).toMatchObject({ sessionStatus: ['exited', 'failed'], sessionOutcome: ['open'] });
    expect(SESSION_TAB_FILTERS.completed).toMatchObject({ sessionStatus: ['exited', 'failed'], sessionOutcome: ['completed'] });
    expect(SESSION_TAB_FILTERS.stopped).toMatchObject({ sessionOutcome: ['stopped'] });
    expect(SESSION_TABS.find((t) => t.id === 'interrupted')?.alert).toBe(true);
  });

  it('every (outcome, status) pair lands in exactly one tab, and it agrees with the filters', () => {
    const statuses = ['spawning', 'running', 'idle', 'exited', 'failed'];
    const outcomes = ['open', 'completed', 'stopped'];
    for (const status of statuses) {
      for (const outcome of outcomes) {
        const s = session({ status, outcome });
        const tab = sessionTabOf(s)!;
        const matching = SESSION_TABS.filter((t) => {
          const f = t.filter as { sessionStatus?: string[]; sessionOutcome?: string[] };
          return (!f.sessionStatus || f.sessionStatus.includes(status))
            && (!f.sessionOutcome || f.sessionOutcome.includes(outcome));
        });
        expect(matching.map((t) => t.id), `${outcome}/${status}`).toEqual([tab]);
      }
    }
  });

  it('a stopped session is resumed (scenario 12): outcome open, spawning, back in Running', () => {
    expect(sessionTabOf(session({ outcome: 'open', status: 'spawning' }))).toBe('running');
  });
});

describe('§6.8 line 2 for multiple tasks', () => {
  it('"Working · 2 tasks · 1 done · 1 offered" (scenario 16: offered is not a claim)', () => {
    const claims = [
      claim({ taskId: 'a' }),
      claim({ taskId: 'b' }),
      claim({ taskId: 'c', endedAt: ago(MIN), endReason: 'task_done' }),
    ];
    expect(sessionLineTwo(session(), 'live', { ...ctx, claims, offered: 1 })).toBe('Working · 2 tasks · 1 done · 1 offered');
  });

  it('Ready to complete: every active claim in review or blocked, at least one ever', () => {
    const claims = [claim({ status: 'in_review' }), claim({ taskId: 't2', status: 'blocked' })];
    const w = sessionRowWord(session(), 'live', { ...ctx, claims })!;
    expect([w.word, w.tone]).toEqual(['Ready to complete', 'done']);
    expect(sessionLineTwo(session(), 'live', { ...ctx, claims })).toBe('Ready to complete · 2 tasks');
  });

  it('claims from working_on edges carry status, endedAt and endReason', () => {
    const claims = claimsFromEdges('s1', [
      { type: 'working_on', source: { id: 's1' }, target: { id: 't1', title: 'A', state: { status: 'working' } }, props: { status: 'in_review' } },
      { type: 'working_on', source: { id: 's1' }, target: { id: 't2', title: 'B', state: { status: 'done' } }, props: { endedAt: ago(MIN), endReason: 'task_done' } },
      { type: 'working_on', source: { id: 'other' }, target: { id: 't3', title: 'C', state: {} }, props: {} },
      { type: 'tracks', source: { id: 's1' }, target: { id: 't4', title: 'D', state: {} }, props: {} },
    ]);
    expect(claims.map((c) => [c.taskId, c.status, c.endReason ?? null])).toEqual([
      ['t1', 'in_review', null],
      ['t2', 'done', 'task_done'],
    ]);
  });
});

describe('§5.3.1 awkward cases', () => {
  it('case 1 — liveness unknown or stale: stays in Running with an amber Stale / Unverified marker', () => {
    const s = session({ status: 'running' });
    expect(sessionTabOf(s)).toBe('running');
    expect(sessionRowWord(s, 'stale', ctx)!.word).toBe('Stale');
    expect(sessionRowWord(s, 'unknown', ctx)!.word).toBe('Unverified');
    expect(sessionRowWord(s, 'unknown', ctx)!.dot).toBe('amber-hollow');
  });

  it('case 2 — a session that never claimed a task reads "Idle 3h", not "Ready to complete"', () => {
    const s = session({ status: 'idle' });
    const w = sessionRowWord(s, 'live', { ...ctx, claims: [], activityAt: ago(3 * HOUR) })!;
    expect(w.word).toBe('Idle 3h');
    expect(w.case).toBe('idle_no_tasks');
    // Still completable the same way.
    expect(sessionVerbsOf(s, 'live')).toContain('complete-session');
  });

  it('case 3 — a one-shot worker that exited cleanly with no working claim: "Finished, not closed out", grouped first with Complete all', () => {
    const finished = session({ status: 'exited', endedKind: 'exited_clean' });
    const crashed = session({ status: 'failed', endedKind: 'crashed' });
    const claimsOf = (r: { id: string }) => (r.id === 'f' ? [claim({ status: 'in_review' })] : undefined);
    const w = sessionRowWord(finished, 'not-running', { ...ctx, claims: [claim({ status: 'in_review' })] })!;
    expect(w.word).toBe('Finished, not closed out');
    const rows = [{ id: 'c', state: crashed }, { id: 'f', state: finished }];
    const groups = groupSessionRows('interrupted', rows, (r) => r.state, (r) => ({ claims: claimsOf(r) }));
    expect(groups[0]).toMatchObject({ id: 'finished_not_closed', label: 'Finished, not closed out (1)', bulk: 'complete-all' });
  });

  it('case 4 — mass interruption groups by reason: "Server restart (12)" with Resume all, credentials with Reconnect', () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, state: session({ status: 'failed', endedKind: 'server_restart' }) })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, state: session({ status: 'failed', endedKind: 'credential_revoked' }) })),
    ];
    const groups = groupSessionRows('interrupted', rows, (r) => r.state);
    expect(groups.map((g) => [g.label, g.bulk])).toEqual([
      ['Server restart (12)', 'resume-all'],
      ['Credential disconnected (5)', 'reconnect-resume-all'],
    ]);
  });

  it('case 5 — old history: an Interrupted row offers Dismiss, which moves it to Stopped (outcome stopped)', () => {
    const old = session({ status: 'failed', endedKind: 'crashed', exitedAt: ago(30 * 24 * HOUR) });
    expect(sessionVerbsOf(old)).toContain('dismiss-session');
    expect(sessionTabOf({ ...old, outcome: 'stopped' })).toBe('stopped');
  });

  it('case 6 — stopped but the process will not die: Stopped tab, "still closing…", never Running', () => {
    const s = session({ outcome: 'stopped', status: 'running' });
    expect(sessionTabOf(s)).toBe('stopped');
    expect(sessionRowWord(s, 'live', ctx)!.word).toBe('Stopped, still closing…');
  });

  it('case 7 — a running child under a completed parent shows the breadcrumb "↳ under <parent> (Completed)"', () => {
    const parent = { title: 'Coordinator X', state: session({ outcome: 'completed', status: 'exited' }) };
    expect(crossTabBreadcrumb(parent, 'running')).toBe('↳ under Coordinator X (Completed)');
    // A parent in the same tab nests normally: no breadcrumb.
    expect(crossTabBreadcrumb({ title: 'P', state: session() }, 'running')).toBeNull();
  });

  it('case 8 — container ended (container_stopped / runtime_lost) counts as Interrupted with its reason', () => {
    for (const endedKind of ['container_stopped', 'runtime_lost']) {
      const s = session({ status: 'failed', endedKind, exitedAt: ago(MIN) });
      expect(sessionTabOf(s)).toBe('interrupted');
      expect(sessionHeadline(s, 'not-running', ctx)).toBe(
        `Crashed: ${endedKind === 'container_stopped' ? 'container stopped' : 'runtime lost'}`,
      );
    }
  });

  it('case 9 — waiting for input on a ✓ session: stays ✓ in Running with the attention chip', () => {
    const s = session({ outcome: 'completed', status: 'idle' });
    const w = sessionRowWord(s, 'live', { ...ctx, waiting: true })!;
    expect([w.word, w.icon, w.attention]).toEqual(['Finished, still open', 'check', true]);
    expect(sessionTabOf(s)).toBe('running');
    // Completion is a marker, not a gate: the chip shows, nothing refuses.
    // While the process is open the row's verb is Stop (close the process).
    expect(sessionVerbsOf(s, 'live')).toEqual(['close-process']);
  });

  it('case 10 — finished sessions are spare capacity: Running groups them under "Finished, still open (N)" with Stop all finished', () => {
    const rows = [
      { id: 'w', state: session() },
      { id: 'f1', state: session({ outcome: 'completed' }) },
      { id: 'f2', state: session({ outcome: 'completed', status: 'idle' }) },
    ];
    const groups = groupSessionRows('running', rows, (r) => r.state);
    expect(groups.map((g) => [g.id, g.label, g.rows.map((r) => r.id), g.bulk])).toEqual([
      ['working', null, ['w'], null],
      ['finished_open', 'Finished, still open (2)', ['f1', 'f2'], 'stop-all-finished'],
    ]);
  });

  it('case 10 (refusal) — "session concurrency cap reached" names the slots and offers Stop all finished (scenario 28)', () => {
    expect(capRefusalHint('session concurrency cap reached (8/8)')).toBe(
      '8 of 8 slots used. Finished sessions whose process is still open hold a slot until it closes — Stop all finished from the Sessions list (Running tab), then launch again.',
    );
    expect(capRefusalHint('session concurrency cap reached')).toMatch(/^Every session slot is in use\. .*Stop all finished/);
    expect(capRefusalHint('entity not found')).toBeNull();
  });

  it('case 11 — a resume that fails at spawn: Interrupted, "Failed to resume", with the error', () => {
    const s = session({ status: 'failed', endedReason: 'Resume failed: no native conversation id.' });
    const w = sessionRowWord(s, 'not-running', ctx)!;
    expect(w.word).toBe('Failed to resume');
    expect(sessionTabOf(s)).toBe('interrupted');
    expect(interruptedGroupOf(s)).toBe('failed_resume');
    // The client-side flag works too, when the reason does not say so.
    expect(sessionRowWord(session({ status: 'failed' }), 'not-running', { resumeFailed: true })!.word).toBe('Failed to resume');
  });

  it('case 12 — quick flips: a row that left Running stays on screen for ~10 s', () => {
    const a = { id: 'a' };
    const lingering = new Map([['a', { row: a, leftAt: NOW - 4_000 }]]);
    expect(withGrace([], lingering, NOW).map((r) => r.id)).toEqual(['a']);
    expect(withGrace([], lingering, NOW + 7_000)).toEqual([]);
    // Back in the query: shown once, not twice.
    expect(withGrace([a], lingering, NOW)).toEqual([a]);
  });
});

describe('needs attention (§5.7 home roster, sessionNeedsAttention)', () => {
  it('open + ended needs attention; completed or stopped never does', () => {
    expect(sessionNeedsAttentionOf(session({ status: 'failed', endedKind: 'crashed' }))).toBe(true);
    expect(sessionNeedsAttentionOf(session({ status: 'exited', endedKind: 'exited_clean' }))).toBe(true);
    expect(sessionNeedsAttentionOf(session())).toBe(false);
    // Scenario 3: a completed session's crash is a grey fact, no attention.
    expect(sessionNeedsAttentionOf(session({ outcome: 'completed', status: 'failed', endedKind: 'crashed' }))).toBe(false);
    expect(sessionNeedsAttentionOf(session({ outcome: 'stopped', status: 'exited' }))).toBe(false);
  });
});

describe('scenario 16 — an offered task is on the row, not a claim (§6.3 R1)', () => {
  it('counts the server\'s offeredTaskIds and shows them in line 2', () => {
    const state = { kind: 'work_session', status: 'running', outcome: 'open', offeredTaskIds: ['t-c'] };
    expect(offeredCountOf(state)).toBe(1);
    expect(offeredCountOf({ kind: 'work_session', status: 'running' })).toBe(0);
    expect(claimTally([{ taskId: 't-a', title: 'A', status: 'working', endedAt: null }], offeredCountOf(state))).toContain('1 offered');
  });
});

