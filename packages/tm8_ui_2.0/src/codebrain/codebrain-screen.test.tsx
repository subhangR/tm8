// @vitest-environment jsdom
/**
 * CodeBrainScreen, mounted directly over fixture rows (SPEC §7.6) — not the
 * full fixture seam, which clones a fixed non-CodeBrain dataset and cannot
 * seed rows under `CODEBRAIN_ROOT_ID`. A minimal `GateData` stub, same
 * "fixture rows only" posture as `codebrain-model.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { EdgeView, EntityId, EntitySummary } from '@tm8/contract';
import { CodeBrainScreen } from './CodeBrainScreen';
import { CODEBRAIN_ROOT_ID } from './codebrain-model';
import type { GateData } from '../views/useGateData';

afterEach(() => {
  cleanup();
});

function pad(n: number): string {
  return String(n).padStart(12, '0');
}
function id(n: number): EntityId {
  return `01900000-00sc-7000-8000-${pad(n)}` as EntityId;
}

function teamMember(opts: {
  id: EntityId;
  position: number;
  title: string;
  parentId?: EntityId;
  model?: string | null;
  agentTool?: string | null;
}): EntitySummary {
  return {
    id: opts.id,
    spaceId: 'space-1',
    kind: 'team_member',
    title: opts.title,
    parentId: opts.parentId ?? CODEBRAIN_ROOT_ID,
    position: opts.position,
    visibility: 'space',
    version: 1,
    activityAt: '2026-08-31T00:00:00.000Z',
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    deletedAt: null,
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

const SIX_PHASES = [
  teamMember({ id: id(1), position: 1, title: 'CodeBrain 1 · DEFINE — Idea → Refine' }),
  teamMember({ id: id(2), position: 2, title: 'CodeBrain 2 · PLAN — Spec → PRD' }),
  teamMember({ id: id(3), position: 3, title: 'CodeBrain 3 · BUILD — Code → Impl' }),
  teamMember({ id: id(4), position: 4, title: 'CodeBrain 4 · VERIFY — Test → Debug' }),
  teamMember({
    id: id(5),
    position: 5,
    title: 'CodeBrain 5 · REVIEW — QA → Gate',
    model: 'gpt-5.6-sol',
    agentTool: 'codex',
  }),
  teamMember({ id: id(6), position: 6, title: 'CodeBrain 6 · SHIP — Go → Live' }),
];

function task(opts: { id: EntityId; title?: string }): EntitySummary {
  return {
    id: opts.id,
    spaceId: 'space-1',
    kind: 'task',
    title: opts.title ?? 'a run',
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
      assignees: [],
      acceptance: { total: 0, completed: 0 },
    },
    badges: {},
  } as unknown as EntitySummary;
}

function session(opts: {
  id: string;
  runId: EntityId;
  teammateId: EntityId;
  status: 'spawning' | 'running' | 'idle' | 'exited' | 'failed';
  startedAt?: string | null;
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
      startedAt: opts.startedAt === undefined ? '2026-08-31T00:00:00.000Z' : opts.startedAt,
      exitedAt: opts.exitedAt ?? null,
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

/** Minimal GateData — only the surface CodeBrainScreen actually reads. */
function dataOf(rows: EntitySummary[], edges: EdgeView[] = []): GateData {
  const byKind = new Map<string, EntitySummary[]>();
  for (const r of rows) {
    byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);
  }
  return {
    ready: true,
    rowsFor: (kind: string) => () => byKind.get(kind) ?? [],
    pageStateOf: () => () => ({ hasMore: false, loading: false }),
    ensureKind: () => {},
    graph: { nodes: rows, edges },
  } as unknown as GateData;
}

describe('CodeBrainScreen — empty state (SPEC §7.5, AC4)', () => {
  it('renders the explainer, all six phases queued, and the how-to-start line', () => {
    render(
      <CodeBrainScreen data={dataOf(SIX_PHASES)} runId={null} onSelectRun={() => {}} />,
    );
    expect(screen.getByText(/CodeBrain is six phases/)).toBeTruthy();
    for (const name of ['DEFINE', 'PLAN', 'BUILD', 'VERIFY', 'REVIEW', 'SHIP']) {
      // The explainer paragraph names all six too, so >=1 (not exactly 1).
      expect(screen.getAllByText(new RegExp(name)).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText('queued')).toHaveLength(6);
    expect(screen.getByText(/tm8 session spawn/)).toBeTruthy();
    expect(screen.getByTestId('cb-no-runs').textContent).toBe('No runs in this space yet.');
    expect(screen.queryByTestId('cb-not-found')).toBeNull();
  });

  it('Boundaries > Never — the explainer and how-to-start line name phases from the graph, not a literal list', () => {
    // A fixture whose names are NOT the real six — if the explainer or the
    // how-to-start line hardcoded 'DEFINE' etc., this would show the wrong
    // name instead of the fixture's.
    const rows = [
      teamMember({ id: id(41), position: 1, title: 'Aurora' }),
      teamMember({ id: id(42), position: 2, title: 'Borealis' }),
    ];
    render(<CodeBrainScreen data={dataOf(rows)} runId={null} onSelectRun={() => {}} />);
    expect(screen.getByText(/Aurora, Borealis/)).toBeTruthy();
    expect(screen.getByText(/with the Aurora teammate/)).toBeTruthy();
    for (const stale of ['DEFINE', 'PLAN', 'BUILD', 'VERIFY', 'REVIEW', 'SHIP']) {
      expect(screen.queryByText(new RegExp(stale))).toBeNull();
    }
  });

  it('AC3 — each phase row shows its model and agent tool, read from the graph', () => {
    render(
      <CodeBrainScreen data={dataOf(SIX_PHASES)} runId={null} onSelectRun={() => {}} />,
    );
    expect(screen.getAllByText('claude-sonnet-5')).toHaveLength(5);
    expect(screen.getByText('gpt-5.6-sol')).toBeTruthy();
  });

  it('a team_member under a different parent never appears', () => {
    const outsider = teamMember({
      id: id(99),
      position: 1,
      title: 'Not CodeBrain',
      parentId: 'e-other-root' as EntityId,
    });
    render(
      <CodeBrainScreen data={dataOf([...SIX_PHASES, outsider])} runId={null} onSelectRun={() => {}} />,
    );
    expect(screen.queryByText('Not CodeBrain')).toBeNull();
    expect(screen.getAllByText('queued')).toHaveLength(6);
  });

  it('runId naming nothing renders the empty state plus a not-found line', () => {
    render(
      <CodeBrainScreen
        data={dataOf(SIX_PHASES)}
        runId={'e-does-not-exist' as EntityId}
        onSelectRun={() => {}}
      />,
    );
    expect(screen.getByTestId('cb-not-found').textContent).toBe(
      'The run in this link was not found.',
    );
    expect(screen.getByText(/CodeBrain is six phases/)).toBeTruthy();
    expect(screen.getAllByText('queued')).toHaveLength(6);
  });

  it('AC5 — the codex phase carries the vendor mark and the five claude-code phases do not', () => {
    render(
      <CodeBrainScreen data={dataOf(SIX_PHASES)} runId={null} onSelectRun={() => {}} />,
    );
    const marks = screen.getAllByRole('img', { name: /codex/ });
    expect(marks).toHaveLength(1);
    expect(marks[0].getAttribute('title')).toBe('Built on codex, not claude-code');
  });

  it('AC5 — the mark is derived from agentTool, not a model-name spelling', () => {
    // A fixture where the two candidate derivations DISAGREE — the real
    // roster cannot tell them apart, since its one non-claude-code phase
    // also happens to be its one non-'claude-*' model. Here: a novel model
    // on claude-code (must NOT be marked), and a novel non-'gpt'-shaped
    // model on a non-claude-code tool (MUST be marked).
    const rows = [
      teamMember({
        id: id(31),
        position: 1,
        title: 'Novel model, claude-code',
        model: 'gpt-oss-20b',
        agentTool: 'claude-code',
      }),
      teamMember({
        id: id(32),
        position: 2,
        title: 'Non-gpt model, other vendor',
        model: 'mystery-1',
        agentTool: 'some-other-tool',
      }),
    ];
    render(<CodeBrainScreen data={dataOf(rows)} runId={null} onSelectRun={() => {}} />);
    // Exactly one mark total, and it names 'some-other-tool' — the
    // claude-code phase (novel model and all) must carry none.
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('some-other-tool');
  });

  it('A7 — hydrated with no CodeBrain phases renders that fact, not a blank panel', () => {
    render(<CodeBrainScreen data={dataOf([])} runId={null} onSelectRun={() => {}} />);
    expect(screen.getByTestId('cb-no-phases').textContent).toBe(
      'This space has no CodeBrain phases yet.',
    );
    expect(screen.queryByText('queued')).toBeNull();
  });

  it('not hydrated yet renders a wait, not a blank panel or a fact', () => {
    const loadingData = {
      ...dataOf([]),
      pageStateOf: () => () => ({ hasMore: false, loading: true }),
    } as unknown as GateData;
    render(<CodeBrainScreen data={loadingData} runId={null} onSelectRun={() => {}} />);
    expect(screen.getByTestId('cb-phases-loading')).toBeTruthy();
    expect(screen.queryByTestId('cb-no-phases')).toBeNull();
  });
});

describe('CodeBrainScreen — a selected run (SPEC §6.3, §7.2, A4, Task 5)', () => {
  const RUN = id(50);

  it('renders real derived states, not all queued, for a run', () => {
    const edges = [
      session({ id: 's1', runId: RUN, teammateId: id(1), status: 'exited', exitedAt: '2026-08-31T00:10:00.000Z' }),
      session({ id: 's2', runId: RUN, teammateId: id(2), status: 'running' }),
    ];
    render(
      <CodeBrainScreen
        data={dataOf([...SIX_PHASES, task({ id: RUN, title: 'A real run' })], edges)}
        runId={RUN}
        onSelectRun={() => {}}
      />,
    );
    expect(screen.getByText('A real run')).toBeTruthy();
    // Scoped to the rail: the detail pane also names the selected phase's
    // state, so an unscoped query double-counts the running phase.
    const rail = within(screen.getByRole('list', { name: 'CodeBrain phases' }));
    expect(rail.getAllByText('done')).toHaveLength(1);
    expect(rail.getAllByText('running')).toHaveLength(1);
    expect(rail.getAllByText('queued')).toHaveLength(4);
  });

  it('A4 — elapsed renders for a session with both startedAt and exitedAt, and never a bare zero for an absent one', () => {
    const edges = [
      session({
        id: 's1',
        runId: RUN,
        teammateId: id(1),
        status: 'exited',
        startedAt: '2026-08-31T00:00:00.000Z',
        exitedAt: '2026-08-31T00:06:12.000Z',
      }),
    ];
    render(
      <CodeBrainScreen
        data={dataOf([...SIX_PHASES, task({ id: RUN })], edges)}
        runId={RUN}
        onSelectRun={() => {}}
      />,
    );
    expect(screen.getAllByText(/took 6m 12s/).length).toBeGreaterThan(0);
    // The five other phases have no session at all — nothing claims a duration.
    expect(screen.queryAllByText(/took 0s/)).toHaveLength(0);
  });

  it('the detail pane defaults to the running phase and shows model/tool, teammate id, state', () => {
    const edges = [
      session({ id: 's1', runId: RUN, teammateId: id(3), status: 'running' }),
    ];
    render(
      <CodeBrainScreen
        data={dataOf([...SIX_PHASES, task({ id: RUN })], edges)}
        runId={RUN}
        onSelectRun={() => {}}
      />,
    );
    const detail = screen.getByTestId('cb-detail-pane');
    expect(detail.textContent).toContain('BUILD');
    expect(detail.textContent).toContain('claude-sonnet-5');
    expect(detail.textContent).toContain(id(3));
    expect(detail.textContent).toContain('running');
  });

  it('clicking a phase row updates the detail pane to that phase', () => {
    render(
      <CodeBrainScreen
        data={dataOf([...SIX_PHASES, task({ id: RUN })])}
        runId={RUN}
        onSelectRun={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId(`cb-phase-${id(5)}`));
    const detail = screen.getByTestId('cb-detail-pane');
    expect(detail.textContent).toContain('REVIEW');
    expect(detail.textContent).toContain('gpt-5.6-sol');
  });
});
