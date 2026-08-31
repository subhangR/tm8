/**
 * codebrain-model — fixture rows only, no DOM (SPEC §6.4).
 *
 * Covers: phase resolution/ordering/exclusion (A6, specialists 7-10), state
 * precedence (SPEC §6.3 table), null model/agentTool render no claim, and
 * `isRun`'s three independent disjuncts (SPEC §6.2).
 */
import { describe, expect, it } from 'vitest';
import type { EdgeView, EntityId, EntitySummary } from '@tm8/contract';
import { CODEBRAIN_ROOT_ID, isRun, phaseStatesOf, phases } from './codebrain-model';
import type { Phase } from './codebrain-model';

const OTHER_ROOT = 'e-other-root' as EntityId;

function pad(n: number): string {
  return String(n).padStart(12, '0');
}
/** Valid UUIDv7 shape. */
function id(n: number): EntityId {
  return `01900000-00cb-7000-8000-${pad(n)}` as EntityId;
}

function teamMember(opts: {
  id: EntityId;
  position: number;
  title?: string;
  parentId?: EntityId;
  model?: string | null;
  agentTool?: string | null;
  deletedAt?: string | null;
}): EntitySummary {
  return {
    id: opts.id,
    spaceId: 'space-1',
    kind: 'team_member',
    title: opts.title ?? `Phase ${opts.position}`,
    parentId: opts.parentId ?? CODEBRAIN_ROOT_ID,
    position: opts.position,
    visibility: 'space',
    version: 1,
    activityAt: '2026-08-31T00:00:00.000Z',
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    deletedAt: opts.deletedAt ?? null,
    createdBy: { id: 'u1', kind: 'member' },
    counters: {},
    state: {
      kind: 'team_member',
      owner: { id: 'u1', kind: 'member' },
      model: opts.model === undefined ? 'claude-sonnet-5' : opts.model,
      agentTool: opts.agentTool === undefined ? 'claude-code' : opts.agentTool,
    },
    badges: {},
  } as unknown as EntitySummary;
}

function task(opts: {
  id: EntityId;
  assignees?: EntityId[];
  workingActors?: EntityId[];
  pendingCount?: number;
}): EntitySummary {
  return {
    id: opts.id,
    spaceId: 'space-1',
    kind: 'task',
    title: 'a run',
    parentId: null,
    position: 1,
    visibility: 'space',
    version: 1,
    activityAt: '2026-08-31T00:00:00.000Z',
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    deletedAt: null,
    createdBy: { id: 'u1', kind: 'member' },
    counters: {},
    state: {
      kind: 'task',
      status: 'in_progress',
      priority: 'medium',
      axes: {},
      assignees: (opts.assignees ?? []).map((a) => ({ id: a, kind: 'team_member' })),
      acceptance: { total: 0, completed: 0 },
    },
    badges: {
      workingActors: (opts.workingActors ?? []).map((a) => ({
        actor: { id: a, kind: 'team_member' },
        task: { id: opts.id },
        startedAt: '2026-08-31T00:00:00.000Z',
      })),
      ...(opts.pendingCount !== undefined
        ? {
            attention: {
              pendingCount: opts.pendingCount,
              totalPoints: opts.pendingCount,
              maxPoints: opts.pendingCount,
              latestReason: 'review',
              oldestRequestedAt: '2026-08-31T00:00:00.000Z',
            },
          }
        : {}),
    },
  } as unknown as EntitySummary;
}

function session(opts: {
  id: string;
  runId: EntityId;
  teammateId: EntityId;
  status: 'spawning' | 'running' | 'idle' | 'exited' | 'failed';
  exitedAt?: string | null;
}): EdgeView {
  const sessionSummary = {
    id: opts.id,
    spaceId: 'space-1',
    kind: 'work_session',
    title: 'a session',
    parentId: null,
    position: 1,
    visibility: 'space',
    version: 1,
    activityAt: '2026-08-31T00:00:00.000Z',
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    deletedAt: null,
    createdBy: { id: 'u1', kind: 'member' },
    counters: {},
    state: {
      kind: 'work_session',
      status: opts.status,
      agentTool: 'claude-code',
      model: 'claude-sonnet-5',
      shareMode: 'private',
      startedAt: '2026-08-31T00:00:00.000Z',
      exitedAt: opts.exitedAt ?? (opts.status === 'exited' ? '2026-08-31T00:10:00.000Z' : null),
      teammate: { id: opts.teammateId, kind: 'team_member' },
    },
    badges: {},
  } as unknown as EntitySummary;
  const runSummary = { id: opts.runId, kind: 'task' } as unknown as EntitySummary;
  return {
    id: `edge:working_on:${opts.id}:${opts.runId}`,
    type: 'working_on',
    source: sessionSummary,
    target: runSummary,
    props: {},
  } as unknown as EdgeView;
}

describe('phases (SPEC §6.1, A6, A7)', () => {
  it('resolves six phases in position order from unordered input, specialists excluded', () => {
    const rows = [
      teamMember({ id: id(6), position: 6, title: 'SHIP' }),
      teamMember({ id: id(9), position: 9, title: 'Specialist: Test Engineer' }),
      teamMember({ id: id(1), position: 1, title: 'DEFINE' }),
      teamMember({ id: id(3), position: 3, title: 'BUILD' }),
      teamMember({ id: id(2), position: 2, title: 'PLAN' }),
      teamMember({ id: id(10), position: 10, title: 'Specialist: Perf' }),
      teamMember({ id: id(4), position: 4, title: 'VERIFY' }),
      teamMember({ id: id(5), position: 5, title: 'REVIEW' }),
      teamMember({ id: id(7), position: 7, title: 'Specialist: Reviewer' }),
      teamMember({ id: id(8), position: 8, title: 'Specialist: Security' }),
    ];
    const result = phases(rows);
    expect(result.map((p) => p.position)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.map((p) => p.title)).toEqual([
      'DEFINE',
      'PLAN',
      'BUILD',
      'VERIFY',
      'REVIEW',
      'SHIP',
    ]);
  });

  it('excludes a team_member under a different parent', () => {
    const rows = [
      teamMember({ id: id(1), position: 1 }),
      teamMember({ id: id(99), position: 2, parentId: OTHER_ROOT }),
    ];
    expect(phases(rows).map((p) => p.id)).toEqual([id(1)]);
  });

  it('excludes a deleted team_member', () => {
    const rows = [
      teamMember({ id: id(1), position: 1 }),
      teamMember({ id: id(2), position: 2, deletedAt: '2026-08-31T00:00:00.000Z' }),
    ];
    expect(phases(rows).map((p) => p.id)).toEqual([id(1)]);
  });

  it('A6 — a tie on position falls through to id, total order', () => {
    const low = id(1);
    const high = id(2);
    const rows = [
      teamMember({ id: high, position: 3 }),
      teamMember({ id: low, position: 3 }),
    ];
    expect(phases(rows).map((p) => p.id)).toEqual([low, high]);
  });

  it('A7 — fewer than six members yields fewer than six phases, not padded', () => {
    const rows = [teamMember({ id: id(1), position: 1 }), teamMember({ id: id(2), position: 2 })];
    expect(phases(rows)).toHaveLength(2);
  });

  it('null model / null agentTool render no claim — passed through as null, never defaulted', () => {
    const rows = [teamMember({ id: id(1), position: 1, model: null, agentTool: null })];
    const [phase] = phases(rows);
    expect(phase.model).toBeNull();
    expect(phase.agentTool).toBeNull();
  });
});

describe('phase state derivation (SPEC §6.3) — precedence, first match wins', () => {
  const ORDERED: Phase[] = [
    { id: id(1), position: 1, title: 'DEFINE', model: null, agentTool: null },
    { id: id(2), position: 2, title: 'PLAN', model: null, agentTool: null },
  ];

  it('queued is the honest default — no session at all', () => {
    const run = task({ id: id(50) });
    const states = phaseStatesOf(run, ORDERED, []);
    expect(states.get(id(1))).toBe('queued');
    expect(states.get(id(2))).toBe('queued');
  });

  it('done — no live session, and a session exited', () => {
    const run = task({ id: id(50) });
    const edges = [session({ id: 's1', runId: id(50), teammateId: id(1), status: 'exited' })];
    expect(phaseStatesOf(run, ORDERED, edges).get(id(1))).toBe('done');
  });

  it('running — a live session (spawning or running)', () => {
    const run = task({ id: id(50) });
    const edges = [session({ id: 's1', runId: id(50), teammateId: id(1), status: 'running' })];
    expect(phaseStatesOf(run, ORDERED, edges).get(id(1))).toBe('running');
  });

  it('running — badges.workingActors on the run names the phase, with no session at all', () => {
    const run = task({ id: id(50), workingActors: [id(1)] });
    expect(phaseStatesOf(run, ORDERED, []).get(id(1))).toBe('running');
  });

  it('idle is queued, not running — deliberately not folded in', () => {
    const run = task({ id: id(50) });
    const edges = [session({ id: 's1', runId: id(50), teammateId: id(1), status: 'idle' })];
    expect(phaseStatesOf(run, ORDERED, edges).get(id(1))).toBe('queued');
  });

  it('failed beats done — a failed session outranks an earlier exited one', () => {
    const run = task({ id: id(50) });
    const edges = [
      session({ id: 's1', runId: id(50), teammateId: id(1), status: 'exited' }),
      session({ id: 's2', runId: id(50), teammateId: id(1), status: 'failed' }),
    ];
    expect(phaseStatesOf(run, ORDERED, edges).get(id(1))).toBe('failed');
  });

  it('failed beats running too', () => {
    const run = task({ id: id(50) });
    const edges = [
      session({ id: 's1', runId: id(50), teammateId: id(1), status: 'running' }),
      session({ id: 's2', runId: id(50), teammateId: id(1), status: 'failed' }),
    ];
    expect(phaseStatesOf(run, ORDERED, edges).get(id(1))).toBe('failed');
  });

  it('attention (waiting) beats running — the frontier phase only', () => {
    const run = task({ id: id(50), pendingCount: 1 });
    // Phase 1 is done, phase 2 is running -> phase 2 is the frontier.
    const edges = [
      session({ id: 's1', runId: id(50), teammateId: id(1), status: 'exited' }),
      session({ id: 's2', runId: id(50), teammateId: id(2), status: 'running' }),
    ];
    const states = phaseStatesOf(run, ORDERED, edges);
    expect(states.get(id(1))).toBe('done');
    expect(states.get(id(2))).toBe('waiting');
  });

  it('attention with no pending frontier work leaves a queued phase queued, not waiting', () => {
    // pendingCount > 0 but there IS no not-done phase (both done) -> no frontier at all.
    const run = task({ id: id(50), pendingCount: 1 });
    const edges = [
      session({ id: 's1', runId: id(50), teammateId: id(1), status: 'exited' }),
      session({ id: 's2', runId: id(50), teammateId: id(2), status: 'exited' }),
    ];
    const states = phaseStatesOf(run, ORDERED, edges);
    expect(states.get(id(1))).toBe('done');
    expect(states.get(id(2))).toBe('done');
  });
});

describe('isRun (SPEC §6.2) — three independent disjuncts', () => {
  const phaseIds = new Set<EntityId>([id(1), id(2)]);

  it('fires on assignees', () => {
    expect(isRun(task({ id: id(50), assignees: [id(1)] }), phaseIds, [])).toBe(true);
  });

  it('fires on badges.workingActors', () => {
    expect(isRun(task({ id: id(50), workingActors: [id(2)] }), phaseIds, [])).toBe(true);
  });

  it('fires on a working_on edge from a phase session, with neither of the above', () => {
    const edges = [session({ id: 's1', runId: id(50), teammateId: id(1), status: 'exited' })];
    expect(isRun(task({ id: id(50) }), phaseIds, edges)).toBe(true);
  });

  it('is false for an ordinary task with no CodeBrain involvement', () => {
    expect(isRun(task({ id: id(50) }), phaseIds, [])).toBe(false);
  });
});
