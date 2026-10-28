/**
 * The launch hand-off's state (task 01a182d2): the record's machine refuses
 * what its state does not take; the phases read a recorded boot as it is and
 * derive nothing they cannot see; the page model is the one decider of what
 * the page shows.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EntityId, ExecutionSpawnInput } from '@tm8/contract';
import type { LaunchStarted } from '../new-session/launch-started';
import {
  beginLaunch,
  bootPhaseOf,
  bootingSessionOf,
  formatElapsed,
  isLaunchTimeout,
  launchPageModel,
  launchPhases,
  launchRecord,
  resetLaunches,
  transition,
  type BootingSession,
  type PhaseMark,
} from '.';

const launch: LaunchStarted = {
  clientMutationId: 'mut-1',
  subjectId: 'task-1' as EntityId,
  title: 'Fix the flaky login test',
  verb: 'worker',
  teammate: { id: 'tm-1' as EntityId, name: 'Opus 5.5 1M Teammate' },
  model: 'claude-opus-5',
  effort: 'max',
  accessMode: 'fullAccess',
  workdir: { kind: 'project', projectId: 'proj-1', mode: 'worktree', baseRef: 'main' },
  notes: '',
};
const input = { clientMutationId: 'mut-1' } as ExecutionSpawnInput;
const page = { at: 'tab' as const, viewerId: 'v', spaceId: 's' };

afterEach(() => resetLaunches());

const marks = (rows: readonly { mark: PhaseMark }[]) => rows.map((row) => row.mark);

describe('the launch record’s machine', () => {
  it('moves starting → checking → admitted, and refuses what a state does not take', () => {
    beginLaunch(launch, 100);
    expect(transition('mut-1', { type: 'send', input })).toMatchObject({ state: 'starting', input });
    expect(transition('mut-1', { type: 'check' })?.state).toBe('checking');
    expect(transition('mut-1', { type: 'send', input })).toBeNull();
    expect(transition('mut-1', { type: 'admit', sessionId: 's-1' as EntityId, at: 400 })).toMatchObject({
      state: 'admitted',
      sessionId: 's-1',
      admittedAt: 400,
    });
    /* Settled: a late failure cannot re-label it. */
    expect(transition('mut-1', { type: 'fail', failure: { message: 'x', code: null, uncertain: false } })).toBeNull();
    expect(launchRecord('mut-1')?.state).toBe('admitted');
    /* Where the page lives moves in any state. */
    expect(transition('mut-1', { type: 'land', page })?.page).toEqual(page);
  });

  it('a press of an id in flight is that launch; a press of a failed id starts it over', () => {
    const first = beginLaunch(launch, 100);
    transition('mut-1', { type: 'land', page });
    transition('mut-1', { type: 'send', input });
    expect(beginLaunch(launch, 200)).toBe(launchRecord('mut-1'));
    expect(launchRecord('mut-1')?.startedAt).toBe(first.startedAt);

    transition('mut-1', { type: 'fail', failure: { message: 'cap reached', code: null, uncertain: false } });
    const restarted = beginLaunch(launch, 300);
    expect(restarted).toMatchObject({ state: 'starting', startedAt: 300, input: null, failure: null, page });
  });

  it('an unknown launch takes no event', () => {
    expect(transition('nope', { type: 'check' })).toBeNull();
  });
});

describe('the boot phases', () => {
  const base = { admitted: false, status: null, bootPhase: null, failed: false, workdir: 'worktree' as const };

  it('derive only what can be seen without a recorded boot', () => {
    expect(marks(launchPhases(base))).toEqual(['active', 'pending', 'pending', 'pending', 'pending']);
    expect(marks(launchPhases({ ...base, admitted: true, status: 'spawning' }))).toEqual(['done', 'active', 'pending', 'pending', 'pending']);
    expect(marks(launchPhases({ ...base, admitted: true, status: 'running' }))).toEqual(['done', 'done', 'done', 'done', 'done']);
  });

  it('read a recorded step as REACHED: it is done and the next is in progress', () => {
    const at = (bootPhase: 'admitted' | 'lane' | 'briefing' | 'agent' | 'live') =>
      marks(launchPhases({ ...base, admitted: true, status: 'spawning', bootPhase }));
    expect(at('admitted')).toEqual(['done', 'active', 'pending', 'pending', 'pending']);
    expect(at('lane')).toEqual(['done', 'done', 'active', 'pending', 'pending']);
    expect(at('briefing')).toEqual(['done', 'done', 'done', 'active', 'pending']);
    expect(at('agent')).toEqual(['done', 'done', 'done', 'done', 'active']);
    expect(at('live')).toEqual(['done', 'done', 'done', 'done', 'done']);
  });

  it('a running session is live whatever stale phase it still carries', () => {
    expect(marks(launchPhases({ ...base, admitted: true, status: 'running', bootPhase: 'lane' }))).toEqual(['done', 'done', 'done', 'done', 'done']);
  });

  it('a failure lands on the row after the last step seen, not on Admitted', () => {
    expect(marks(launchPhases({ ...base, admitted: true, status: 'failed', bootPhase: 'failed', lastStep: 'lane' })))
      .toEqual(['done', 'done', 'failed', 'pending', 'pending']);
    expect(marks(launchPhases({ ...base, failed: true }))).toEqual(['failed', 'pending', 'pending', 'pending', 'pending']);
  });

  it('a failed row names what did not happen, not the fact it would have been', () => {
    const rows = launchPhases({ ...base, admitted: true, status: 'failed', bootPhase: 'failed', lastStep: 'admitted' });
    expect(rows[1]).toMatchObject({ id: 'lane', mark: 'failed', detail: 'The checkout could not be prepared' });
    expect(launchPhases({ ...base, failed: true })[0]?.detail).toBe('The node did not take the launch');
  });

  it('name the lane by the launch’s working directory', () => {
    expect(launchPhases({ ...base, workdir: 'scratch' })[1]).toMatchObject({ label: 'Lane', detail: 'Scratch directory ready' });
    expect(launchPhases({ ...base, workdir: 'worktree' })[1]?.detail).toBe('Worktree checked out');
  });

  it('read the node’s phase off a session, and nothing it does not recognise', () => {
    expect(bootPhaseOf({ bootPhase: 'briefing', bootPhaseAt: '2026-10-28T19:00:00Z' })).toEqual({ phase: 'briefing', at: '2026-10-28T19:00:00Z' });
    expect(bootPhaseOf({ bootPhase: 'warming' })).toBeNull();
    expect(bootPhaseOf({})).toBeNull();
    expect(bootPhaseOf(null)).toBeNull();
  });

  it('format the clock in tenths, then seconds, then minutes', () => {
    expect(formatElapsed(420)).toBe('0.4 s');
    expect(formatElapsed(9_960)).toBe('9.9 s');
    expect(formatElapsed(12_400)).toBe('12 s');
    expect(formatElapsed(65_000)).toBe('1 m 05 s');
  });
});

describe('the page model', () => {
  const session = (patch: Partial<BootingSession> = {}): BootingSession => ({
    id: 's-1',
    title: 'Fix the flaky login test',
    createdAt: '2026-10-28T19:00:00.000Z',
    status: 'spawning',
    bootPhase: null,
    started: false,
    teammate: 'Opus 5.5 1M Teammate',
    model: 'claude-opus-5',
    workdirMode: 'worktree',
    checkoutBranch: 'tm8/s-1',
    endedReason: null,
    ...patch,
  });

  it('starting with the launch line the press carried', () => {
    const record = beginLaunch(launch, 1_000);
    expect(launchPageModel(record, null)).toMatchObject({
      state: 'starting',
      title: 'Fix the flaky login test',
      facts: ['Opus 5.5 1M Teammate', 'Claude Opus 5', 'Max', 'Bypass', 'Worktree from main'],
      startedAt: 1_000,
      failure: null,
      launchId: 'mut-1',
    });
  });

  it('checking while the timeout is being answered; failed with the node’s words', () => {
    beginLaunch(launch, 1_000);
    expect(launchPageModel(transition('mut-1', { type: 'check' }), null)?.state).toBe('checking');
    const failed = transition('mut-1', { type: 'fail', failure: { message: 'cap reached', code: null, uncertain: true } });
    expect(launchPageModel(failed, null)).toMatchObject({ state: 'failed', failure: { message: 'cap reached', uncertain: true } });
  });

  it('booting while the session spawns, live once it runs', () => {
    beginLaunch(launch, 1_000);
    const admitted = transition('mut-1', { type: 'admit', sessionId: 's-1' as EntityId, at: 1_400 });
    expect(launchPageModel(admitted, session())).toMatchObject({ state: 'booting', admittedMs: 400 });
    expect(launchPageModel(admitted, session({ status: 'running' }))?.state).toBe('live');
  });

  it('a boot the node failed shows its sentence', () => {
    expect(launchPageModel(null, session({ status: 'failed', bootPhase: 'failed', endedReason: 'Failed to launch: no credentials for claude-code.' })))
      .toMatchObject({ state: 'failed', failure: { message: 'Failed to launch: no credentials for claude-code.' } });
  });

  it('a session that failed AFTER it started crashed at work — not a launch failure', () => {
    expect(launchPageModel(null, session({ status: 'failed', started: true }))?.state).toBe('live');
  });

  it('a session opened without its press still draws from its own facts', () => {
    expect(launchPageModel(null, session())).toMatchObject({
      state: 'booting',
      facts: ['Opus 5.5 1M Teammate', 'Claude Opus 5', 'Worktree · tm8/s-1'],
      startedAt: Date.parse('2026-10-28T19:00:00.000Z'),
      launchId: null,
    });
  });

  it('reads a work session’s entity, and nothing else', () => {
    expect(bootingSessionOf({
      id: 's-1',
      title: 't',
      createdAt: '2026-10-28T19:00:00.000Z',
      state: { kind: 'work_session', status: 'spawning', bootPhase: 'lane', startedAt: null, teammate: { displayName: 'Opus' }, model: 'm', workdirMode: 'worktree' },
    })).toMatchObject({ status: 'spawning', bootPhase: 'lane', started: false, teammate: 'Opus', workdirMode: 'worktree' });
    expect(bootingSessionOf({ id: 't-1', title: 't', createdAt: '', state: { kind: 'task' } })).toBeNull();
    expect(bootingSessionOf(undefined)).toBeNull();
  });
});

describe('how a spawn failed', () => {
  it('a transport give-up is a timeout; a refusal is not', () => {
    expect(isLaunchTimeout({ code: 'upstream_unavailable', message: 'x' })).toBe(true);
    expect(isLaunchTimeout(new Error('the tm8 node did not answer within 180000ms'))).toBe(true);
    expect(isLaunchTimeout({ code: 'conflict', message: 'session concurrency cap reached' })).toBe(false);
  });
});
