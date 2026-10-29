/**
 * `projectLoopRun` — the §2.2 run projection as a pure function of the joined
 * row: derived status is whatever SQL said, the instants and duration follow
 * the session's facts, exitCode/outputTail are tool-only, usage is null when
 * the session recorded none and never reads as zero.
 */
import { describe, expect, it } from 'vitest';
import type { ActorSummary } from '@tm8/contract';
import { LOOP_RUN_STATUS_SQL, projectLoopRun, type LoopRunRow } from '../../src/loops/runs.js';

const ACTORS = new Map<string, ActorSummary>([
  ['member-1', { id: 'member-1', kind: 'member', displayName: 'Alice', isAgent: false }],
]);

function row(over: Partial<LoopRunRow> = {}): LoopRunRow {
  return {
    id: '8d5a6a4e-9a3d-4c2e-9b5d-1c9c6f5e1a01',
    loop_id: '8d5a6a4e-9a3d-4c2e-9b5d-1c9c6f5e1a02',
    space_id: '8d5a6a4e-9a3d-4c2e-9b5d-1c9c6f5e1a03',
    fired_at: '2026-08-09T10:00:00.000Z',
    fired_at_cursor: '2026-08-09T10:00:00.000000Z',
    trigger: 'schedule',
    requested_by: null,
    action: 'spawn',
    attempt: 1,
    acted_as_identity_id: 'identity-alice',
    acted_as_member_id: 'member-1',
    launch: 'fired',
    skip_reason: null,
    error: null,
    task_id: '8d5a6a4e-9a3d-4c2e-9b5d-1c9c6f5e1a04',
    session_id: '8d5a6a4e-9a3d-4c2e-9b5d-1c9c6f5e1a05',
    outcome: null,
    ended_at: null,
    status: 'running',
    session_kind: 'agent',
    ended_kind: null,
    started_at: '2026-08-09T10:00:05.000Z',
    exited_at: null,
    tool_exit_code: null,
    tool_started_at: null,
    tool_exited_at: null,
    usage_present: false,
    usage_input_tokens: null,
    usage_output_tokens: null,
    usage_cost_usd: null,
    ...over,
  };
}

describe('projectLoopRun', () => {
  it('a running agent run: started, no end, no duration, no exit code, actedAs resolved', () => {
    const run = projectLoopRun(row(), ACTORS, false);
    expect(run.status).toBe('running');
    expect(run.startedAt).toBe('2026-08-09T10:00:05.000Z');
    expect(run.endedAt).toBeNull();
    expect(run.durationMs).toBeNull();
    expect(run.exitCode).toBeNull();
    expect(run.actedAs?.displayName).toBe('Alice');
    expect(run.usage).toBeNull();
  });

  it('a completed run takes its end from the session exit and measures the duration', () => {
    const run = projectLoopRun(row({ status: 'completed', exited_at: '2026-08-09T10:10:05.000Z', ended_kind: 'exited_clean' }), ACTORS, false);
    expect(run.endedAt).toBe('2026-08-09T10:10:05.000Z');
    expect(run.durationMs).toBe(10 * 60_000);
    expect(run.endedKind).toBe('exited_clean');
  });

  it('a skipped run never started and ended when it was decided', () => {
    const run = projectLoopRun(row({ launch: 'skipped', skip_reason: 'overlap', status: 'skipped', session_id: null, task_id: null, ended_at: '2026-08-09T10:00:00.000Z', started_at: null }), ACTORS, false);
    expect(run.status).toBe('skipped');
    expect(run.skipReason).toBe('overlap');
    expect(run.startedAt).toBeNull();
    expect(run.endedAt).toBe('2026-08-09T10:00:00.000Z');
    expect(run.durationMs).toBeNull();
  });

  it('a failed launch carries its error and no session', () => {
    const run = projectLoopRun(row({ launch: 'failed', status: 'failed', error: 'spawn refused', session_id: null, task_id: null, started_at: null, ended_at: '2026-08-09T10:00:01.000Z' }), ACTORS, false);
    expect(run.status).toBe('failed');
    expect(run.error).toBe('spawn refused');
    expect(run.sessionId).toBeNull();
  });

  it('a tool run exposes its exit code, and the output tail only when asked', () => {
    const base = row({ session_kind: 'tool', status: 'failed', tool_exit_code: 2, tool_started_at: '2026-08-09T10:00:01.000Z', tool_exited_at: '2026-08-09T10:00:03.000Z', tool_output_tail: 'boom' });
    expect(projectLoopRun(base, ACTORS, false).exitCode).toBe(2);
    expect(projectLoopRun(base, ACTORS, false).outputTail).toBeNull();
    expect(projectLoopRun(base, ACTORS, true).outputTail).toBe('boom');
    expect(projectLoopRun(base, ACTORS, true).durationMs).toBe(2000);
  });

  it('usage: token totals from the transcript, cost as the harness reported it, null means unknown', () => {
    const run = projectLoopRun(row({ status: 'completed', exited_at: '2026-08-09T10:01:00Z', usage_present: true, usage_input_tokens: '1200', usage_output_tokens: '300', usage_cost_usd: 0.42 }), ACTORS, false);
    expect(run.usage).toEqual({ inputTokens: 1200, outputTokens: 300, costUsd: 0.42, source: 'harness' });
    const noCost = projectLoopRun(row({ status: 'completed', exited_at: '2026-08-09T10:01:00Z', usage_present: true, usage_input_tokens: '10', usage_output_tokens: '1', usage_cost_usd: null }), ACTORS, false);
    expect(noCost.usage).toEqual({ inputTokens: 10, outputTokens: 1, costUsd: null, source: null });
  });

  it('a manual run names who pressed Run now', () => {
    const run = projectLoopRun(row({ trigger: 'manual', requested_by: 'member-1' }), ACTORS, false);
    expect(run.trigger).toBe('manual');
    expect(run.requestedBy?.displayName).toBe('Alice');
  });

  it('the status fragment lists every derived state exactly once', () => {
    for (const status of ['skipped', 'failed', 'running', 'completed']) {
      expect(LOOP_RUN_STATUS_SQL).toContain(`'${status}'`);
    }
    // stopped and timed_out come from the settled outcome column.
    expect(LOOP_RUN_STATUS_SQL).toContain('r.outcome is not null then r.outcome');
  });
});
