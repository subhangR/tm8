// @vitest-environment jsdom
/**
 * A2 — the board body (doc 06 §1, §8).
 *
 * What these tests hold:
 *   - the board is REGISTRY-DRIVEN: columns come from stateControl.options ∩
 *     the active tier, words/tones from panel.statusPill, and BoardBody never
 *     reads `kind` (the registry-totality/no-branching law §15.2);
 *   - the §1.4 honesty rules: "{n} shown" headers, the page banner whenever a
 *     further page exists, and the three §8.2 states (loading / empty / error)
 *     that must not look alike;
 *   - the §1.5 grammar: a move is a COMMAND through the same routing the state
 *     picker uses (`via` respected, `done` through `complete`), refusals
 *     render INLINE at the refusing column, and nothing moves optimistically;
 *   - the §1.1 wiring: `mode` is controllable from above and the switcher
 *     reports changes rather than trapping them in local state.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { CollectionGroup, EntitySummary } from '@tm8/contract';
import { getKind, type ActionContext, type QueryFilter } from '../domain';
import { FIXTURE_SPACE_ID, fixtureSummaries } from '../fixtures';
import { EntityListPanel, type BoardSnapshot } from './index';

vi.setConfig({ testTimeout: 20_000 });

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const rowsFor =
  (rows: readonly EntitySummary[]) =>
  (_filter: QueryFilter): readonly EntitySummary[] =>
    rows;

const tasks = fixtureSummaries.filter((s) => s.state.kind === 'task');
const taskOf = (status: string): EntitySummary => {
  const base = tasks[0];
  if (!base) throw new Error('fixtures carry no task');
  return {
    ...base,
    id: `board-${status}-${base.id}`,
    title: `Board fixture ${status}`,
    state: { ...base.state, status } as EntitySummary['state'],
    badges: {},
  };
};

const groups = (...pairs: readonly (readonly [string, readonly EntitySummary[]])[]): CollectionGroup[] =>
  pairs.map(([key, items]) => ({ key, label: key, items: [...items] }));

const snapshot = (overrides: Partial<BoardSnapshot> = {}): BoardSnapshot => ({
  groups: groups(
    ['open', [taskOf('open')]],
    ['working', [taskOf('working')]],
  ),
  nextCursor: null,
  limit: 50,
  ...overrides,
});

function renderBoard(opts: {
  snapshot?: BoardSnapshot | undefined;
  onSetState?: (
    entityId: string,
    next: string,
    via: string,
    o?: { notify?: boolean },
  ) => void | Promise<{ ok: true } | { ok: false; reason: string }>;
  boardFor?: (filter: QueryFilter, groupBy: string) => BoardSnapshot | undefined;
}) {
  const boardFor = opts.boardFor ?? (() => opts.snapshot);
  return render(
    <EntityListPanel
      kind="task"
      rowsFor={rowsFor([])}
      ctx={ctx}
      mode="board"
      boardFor={boardFor as never}
      onSetState={opts.onSetState as never}
    />,
  );
}

describe('A2 — board columns come from the registry, not the payload', () => {
  it('renders the WHOLE stateControl vocabulary, in its order, and nothing else', () => {
    const { getAllByTestId } = renderBoard({ snapshot: snapshot() });
    const keys = getAllByTestId('board-column').map((col) => col.getAttribute('data-column'));
    // PHASE 7 — the FULL vocabulary, and no synthetic sink.
    //
    // This used to read `open, pulled, working, in_review, blocked, done`:
    // the five open-TIER statuses plus a §1.3 "drop to complete" sink standing
    // in for the terminal column the Open tab excluded. The board no longer
    // runs under a category tab — its columns ARE that partition — so `done`
    // is an ordinary fetched column and `cancelled` is on screen for the first
    // time. One source: if this drifts from the registry, the picker and the
    // board disagree.
    expect(keys).toEqual([
      'open',
      'pulled',
      'working',
      'in_review',
      'blocked',
      'done',
      'cancelled',
    ]);
  });

  it('column words and tones come from panel.statusPill — in_review reads "in review"', () => {
    const { getAllByTestId } = renderBoard({ snapshot: snapshot() });
    const labels = getAllByTestId('board-column').map((col) => col.getAttribute('aria-label'));
    expect(labels).toContain('in review');
    // The terminal column states its own word, not a sink's grammar.
    expect(labels).toContain('done');
    expect(labels.some((l) => (l ?? '').includes('drop to complete'))).toBe(false);
  });

  it('a group key the registry does not declare is APPENDED raw, never dropped', () => {
    const { getAllByTestId } = renderBoard({
      snapshot: snapshot({
        groups: groups(['open', [taskOf('open')]], ['someday', [taskOf('open')]]),
      }),
    });
    const keys = getAllByTestId('board-column').map((col) => col.getAttribute('data-column'));
    expect(keys).toContain('someday');
  });

  it('an empty column is a real answer: header, "0 shown", quiet body', () => {
    const { getAllByTestId } = renderBoard({ snapshot: snapshot() });
    const blocked = getAllByTestId('board-column').find(
      (col) => col.getAttribute('data-column') === 'blocked',
    )!;
    expect(within(blocked).getByText('0 shown')).toBeTruthy();
    expect(within(blocked).getByText(/nothing in blocked/i)).toBeTruthy();
  });
});

describe('§1.4 — honesty about paging', () => {
  it('headers read "{n} shown", never a bare count', () => {
    const { getAllByTestId } = renderBoard({ snapshot: snapshot() });
    const open = getAllByTestId('board-column').find(
      (col) => col.getAttribute('data-column') === 'open',
    )!;
    expect(within(open).getByText('1 shown')).toBeTruthy();
  });

  it('the banner renders whenever a further page exists, and names the limit', () => {
    const { getByTestId } = renderBoard({
      snapshot: snapshot({ nextCursor: 'opaque-cursor', limit: 50 }),
    });
    expect(getByTestId('board-banner').textContent).toMatch(/Showing the 50 most recently active/);
    expect(getByTestId('board-banner').textContent).toMatch(/not complete counts/);
  });

  it('no banner when the page is complete', () => {
    const { queryByTestId } = renderBoard({ snapshot: snapshot({ nextCursor: null }) });
    expect(queryByTestId('board-banner')).toBeNull();
  });
});

describe('§8.2 — loading, empty and error must not look alike', () => {
  it('loading renders registry headers with skeleton bodies, never empty-state text', () => {
    const { getAllByTestId, queryByText } = renderBoard({ snapshot: undefined });
    // Headers are known BEFORE any fetch — the vocabulary is registry data.
    expect(getAllByTestId('board-column').length).toBeGreaterThan(0);
    expect(getAllByTestId('board-skeleton').length).toBeGreaterThan(0);
    expect(queryByText(/nothing in/i)).toBeNull();
  });

  it('an errored board collapses to the reason + retry — no empty columns lying', () => {
    const retry = vi.fn();
    const { getByTestId, queryAllByTestId } = renderBoard({
      snapshot: snapshot({ groups: [], error: 'the node said no', retry }),
    });
    expect(getByTestId('board-error').textContent).toContain('the node said no');
    expect(queryAllByTestId('board-column')).toHaveLength(0);
    fireEvent.click(within(getByTestId('board-error')).getByText('Retry'));
    expect(retry).toHaveBeenCalled();
  });

  it('a host that wires no board source gets an honest refusal, not a blank region', () => {
    const { getByTestId } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([])} ctx={ctx} mode="board" />,
    );
    expect(getByTestId('board-unwired')).toBeTruthy();
  });
});

describe('§1.5 / §8.1 — a move is a command, one grammar for pointer and keyboard', () => {
  it('Mod+ArrowRight moves the focused card via the SAME set-state routing as a drop', async () => {
    const onSetState = vi.fn().mockResolvedValue({ ok: true });
    const { getByTestId } = renderBoard({ snapshot: snapshot(), onSetState });
    fireEvent.keyDown(getByTestId('board-body'), { key: 'ArrowRight', metaKey: true });
    // Focus starts on column 0 (open, holding one card); the next column is
    // pulled; the option declares no `via`, so the control's own command routes.
    expect(onSetState).toHaveBeenCalledTimes(1);
    const [id, next, via, opts] = onSetState.mock.calls[0]!;
    expect(String(id)).toMatch(/^board-open/);
    expect(next).toBe('pulled');
    expect(via).toBe('set-state');
    // §1.5: the board owns its refusal surface — no toast from the executor.
    expect(opts).toEqual({ notify: false });
  });

  it('a refusal renders INLINE at the refusing column, and the card never moved', async () => {
    const reason = 'completion requires all acceptance criteria checked (2 open)';
    const onSetState = vi.fn().mockResolvedValue({ ok: false, reason });
    const { getByTestId, getAllByTestId, findByTestId } = renderBoard({
      snapshot: snapshot(),
      onSetState,
    });
    fireEvent.keyDown(getByTestId('board-body'), { key: 'ArrowRight', metaKey: true });
    const refusal = await findByTestId('board-refusal');
    expect(refusal.textContent).toBe(reason);
    // Inline at the refusing column — the pulled column, where the act aimed.
    const pulled = getAllByTestId('board-column').find(
      (col) => col.getAttribute('data-column') === 'pulled',
    )!;
    expect(within(pulled).getByTestId('board-refusal')).toBeTruthy();
    // Nothing moved optimistically: the card still renders under open only.
    const open = getAllByTestId('board-column').find(
      (col) => col.getAttribute('data-column') === 'open',
    )!;
    expect(within(open).getByText('1 shown')).toBeTruthy();
    expect(within(pulled).getByText('0 shown')).toBeTruthy();
  });

  it('plain arrows move COLUMN FOCUS, not cards', () => {
    const onSetState = vi.fn();
    const { getByTestId, getAllByTestId } = renderBoard({ snapshot: snapshot(), onSetState });
    fireEvent.keyDown(getByTestId('board-body'), { key: 'ArrowRight' });
    expect(onSetState).not.toHaveBeenCalled();
    const cols = getAllByTestId('board-column');
    expect(cols[1]!.className).toContain('lp__board-col--focused');
  });
});

describe('§1.6 — which kinds get a board', () => {
  it('task declares a board; the switcher position is LIVE', () => {
    const { getByTestId } = render(
      <EntityListPanel kind="task" rowsFor={rowsFor([])} ctx={ctx} />,
    );
    const sw = getByTestId('view-switcher');
    // Two live positions now — list and board; tree and graph stay disabled.
    expect(sw.querySelectorAll('.lp__view')).toHaveLength(2);
    expect(sw.querySelectorAll('[data-testid="disabled-with-reason"]')).toHaveLength(2);
  });

  it('work_session hides board entirely — a sessions board would render one dishonest column', () => {
    expect(getKind('work_session').hiddenModes).toContain('board');
    expect(getKind('work_session').list.board).toBeUndefined();
  });

  it('every kind declaring a board also declares the sources the board reads', () => {
    // The board renders columns from stateControl and words from statusPill;
    // a kind declaring `board` without them would render raw ids. Registry
    // totality: data must be complete at declaration time, not at render time.
    for (const k of [getKind('task')]) {
      if (!k.list.board) continue;
      expect(k.list.stateControl, `${k.kind} board without stateControl`).toBeDefined();
      expect(k.panel.statusPill, `${k.kind} board without statusPill`).toBeDefined();
    }
  });
});

describe('§1.1 — the mode wiring', () => {
  it('a controlled `mode` renders the board without any click', () => {
    const { getByTestId } = renderBoard({ snapshot: snapshot() });
    expect(getByTestId('board-body')).toBeTruthy();
  });

  it('the switcher reports through onMode instead of trapping the change locally', () => {
    const onMode = vi.fn();
    const { getByTestId } = render(
      <EntityListPanel
        kind="task"
        rowsFor={rowsFor([])}
        ctx={ctx}
        mode="list"
        onMode={onMode}
        boardFor={(() => snapshot()) as never}
      />,
    );
    fireEvent.click(within(getByTestId('view-switcher')).getByLabelText('board layout'));
    expect(onMode).toHaveBeenCalledWith('board');
  });
});

/**
 * ===========================================================================
 * W3 (2026-08-16) — the board groups by ANY axis, and a drop writes the
 * GROUPING dimension.
 *
 * The gap: `routes/q.ts` parsed `groupBy` including `axis:<name>` and
 * `useGateData` executed any grouped read, while `registry.ts` pinned
 * `status` and nothing rendered a picker — the middle of the wire. The
 * highest-risk half is drag: a drop on an axis board must write THE AXIS,
 * never a status the columns no longer show (W3/4).
 * ===========================================================================
 */
const TYPE_AXIS = {
  id: 'axis-type',
  spaceId: FIXTURE_SPACE_ID,
  name: 'type',
  axisValues: ['default', 'code', 'design', 'review', 'test'],
  kind: 'default' as const,
  position: 0,
};

function renderAxisBoard(opts: {
  snapshot?: BoardSnapshot;
  groupBy?: string;
  onGroupBy?: (g: string) => void;
  onSetAxis?: (
    entityId: string,
    axisName: string,
    next: string | null,
    label: string,
    o?: { notify?: boolean },
  ) => void | Promise<{ ok: true } | { ok: false; reason: string }>;
  onSetState?: () => void;
  taskAxes?: readonly (typeof TYPE_AXIS)[];
}) {
  return render(
    <EntityListPanel
      kind="task"
      rowsFor={rowsFor([])}
      ctx={ctx}
      mode="board"
      groupBy={(opts.groupBy ?? 'axis:type') as never}
      onGroupBy={(opts.onGroupBy ?? (() => undefined)) as never}
      taskAxes={(opts.taskAxes ?? [TYPE_AXIS]) as never}
      boardFor={(() => opts.snapshot) as never}
      onSetAxis={opts.onSetAxis as never}
      onSetState={opts.onSetState as never}
    />,
  );
}

describe('W3 — the axis board', () => {
  it('columns are the no-value column first, then axisValues ORDER — never the server’s arrival order', () => {
    const { getAllByTestId } = renderAxisBoard({
      snapshot: snapshot({
        // Server buckets arrive in a scrambled order with one stale value.
        groups: groups(['review', [taskOf('open')]], ['', [taskOf('open')]], ['retired', [taskOf('open')]]),
      }),
    });
    const keys = getAllByTestId('board-column').map((col) => col.getAttribute('data-column'));
    expect(keys).toEqual(['', 'default', 'code', 'design', 'review', 'test', 'retired']);
    // The no-value column has an honest name, and the stale value survives
    // appended rather than dropped (§1.3).
    const labels = getAllByTestId('board-column').map((col) => col.getAttribute('aria-label'));
    expect(labels[0]).toBe('no type');
    expect(labels).toContain('retired');
  });

  it('a drop on an axis column writes THE AXIS via onSetAxis — never a status', async () => {
    const onSetAxis = vi.fn(async () => ({ ok: true }) as const);
    const onSetState = vi.fn();
    const row = taskOf('open');
    const { getAllByTestId } = renderAxisBoard({
      snapshot: snapshot({ groups: groups(['', [row]]) }),
      onSetAxis,
      onSetState,
    });
    const card = getAllByTestId('board-column')[0]!.querySelector('.lp__board-card')!;
    const target = getAllByTestId('board-column').find((c) => c.getAttribute('data-column') === 'code')!;
    fireEvent.dragStart(card, { dataTransfer: { setData: () => undefined, effectAllowed: '' } });
    fireEvent.drop(target, { dataTransfer: { getData: () => row.id } });

    expect(onSetAxis).toHaveBeenCalledTimes(1);
    expect(onSetAxis.mock.calls[0]!.slice(0, 4)).toEqual([row.id, 'type', 'code', 'Type']);
    expect(onSetAxis.mock.calls[0]![4]).toEqual({ notify: false });
    expect(onSetState).not.toHaveBeenCalled();
  });

  it('a drop into the no-value column CLEARS the axis (null, not empty string)', () => {
    const onSetAxis = vi.fn(async () => ({ ok: true }) as const);
    const row = taskOf('open');
    const { getAllByTestId } = renderAxisBoard({
      snapshot: snapshot({ groups: groups(['code', [row]]) }),
      onSetAxis,
    });
    const card = getAllByTestId('board-column')
      .find((c) => c.getAttribute('data-column') === 'code')!
      .querySelector('.lp__board-card')!;
    const target = getAllByTestId('board-column').find((c) => c.getAttribute('data-column') === '')!;
    fireEvent.dragStart(card, { dataTransfer: { setData: () => undefined, effectAllowed: '' } });
    fireEvent.drop(target, { dataTransfer: { getData: () => row.id } });
    expect(onSetAxis).toHaveBeenCalledWith(row.id, 'type', null, 'Type', { notify: false });
  });

  it('a refused axis write renders INLINE at the refusing column, no toast (§1.5)', async () => {
    const onSetAxis = vi.fn(async () => ({ ok: false, reason: 'version_conflict: entity moved' }) as const);
    const row = taskOf('open');
    const view = renderAxisBoard({
      snapshot: snapshot({ groups: groups(['', [row]]) }),
      onSetAxis,
    });
    const card = view.getAllByTestId('board-column')[0]!.querySelector('.lp__board-card')!;
    const target = view.getAllByTestId('board-column').find((c) => c.getAttribute('data-column') === 'code')!;
    fireEvent.dragStart(card, { dataTransfer: { setData: () => undefined, effectAllowed: '' } });
    fireEvent.drop(target, { dataTransfer: { getData: () => row.id } });
    const refusal = await view.findByTestId('board-refusal');
    expect(refusal.textContent).toContain('version_conflict');
    expect(target.contains(refusal)).toBe(true);
  });

  it('the picker offers status, assignee, and one entry per SPACE axis, and reports upward', () => {
    const onGroupBy = vi.fn();
    const { getByTestId } = renderAxisBoard({
      snapshot: snapshot(),
      groupBy: 'status',
      onGroupBy,
    });
    const picker = getByTestId('board-groupby') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(['status', 'assignee', 'axis:type']);
    fireEvent.change(picker, { target: { value: 'axis:type' } });
    expect(onGroupBy).toHaveBeenCalledWith('axis:type');
  });

  it('an axis the space does not define refuses with the reason and keeps the picker', () => {
    const { getByTestId } = renderAxisBoard({
      snapshot: snapshot(),
      groupBy: 'axis:vanished',
      taskAxes: [TYPE_AXIS],
    });
    expect(getByTestId('board-axis-missing').textContent).toContain('no task axis named vanished');
    expect(getByTestId('board-groupby')).toBeTruthy();
  });

  it('the assignee board is READ-ONLY with the reason in its banner (ruling W3/4)', () => {
    const onSetState = vi.fn();
    const onSetAxis = vi.fn();
    const { getByTestId, getAllByTestId } = renderAxisBoard({
      snapshot: snapshot({ groups: groups(['', [taskOf('open')]], ['actor-1', [taskOf('working')]]) }),
      groupBy: 'assignee',
      onSetState,
      onSetAxis,
    });
    expect(getByTestId('board-assignee-note').textContent).toMatch(/drag is off/i);
    // No card is draggable and no column accepts a drop — a drop that wrote a
    // status under assignee columns is the lie W3/4 exists to prevent.
    for (const col of getAllByTestId('board-column')) {
      const card = col.querySelector('.lp__board-card');
      if (card) expect(card.getAttribute('draggable')).toBeNull();
    }
  });

  it('the STATUS board still dispatches through onSetState exactly as before (no regression)', () => {
    const onSetState = vi.fn(async () => ({ ok: true }) as const);
    const onSetAxis = vi.fn();
    const row = taskOf('open');
    const { getAllByTestId } = renderAxisBoard({
      snapshot: snapshot({ groups: groups(['open', [row]]) }),
      groupBy: 'status',
      onSetState: onSetState as never,
      onSetAxis,
    });
    const card = getAllByTestId('board-column')
      .find((c) => c.getAttribute('data-column') === 'open')!
      .querySelector('.lp__board-card')!;
    const target = getAllByTestId('board-column').find((c) => c.getAttribute('data-column') === 'working')!;
    fireEvent.dragStart(card, { dataTransfer: { setData: () => undefined, effectAllowed: '' } });
    fireEvent.drop(target, { dataTransfer: { getData: () => row.id } });
    expect(onSetState).toHaveBeenCalledTimes(1);
    expect(onSetAxis).not.toHaveBeenCalled();
  });
});

/**
 * ===========================================================================
 * W4 (2026-08-16) — the STATUS board pre-flights a drop against the space's
 * workflow registry (132). The vocabulary is already in hand — the same
 * `spaceSettings()` data the strip narrows with — so a drop the row's type
 * forbids is FORESEEABLE, and §8.5 says a foreseeable refusal is stated at
 * the refusing column WITHOUT calling the server. Same words as the strip's
 * disabled option; the database trigger remains the real gate. Axis and
 * assignee boards are untouched by construction: the pre-flight lives in the
 * status branch of `dispatchDrop` alone.
 * ===========================================================================
 */
describe('W4 — the status board pre-flights workflow-forbidden drops', () => {
  const CODE_RULE = {
    id: 'wf-code',
    spaceId: FIXTURE_SPACE_ID,
    typeValue: 'code',
    statuses: ['open', 'working', 'in_review', 'done'],
  };

  const typedTask = (status: string, type: string): EntitySummary => {
    const row = taskOf(status);
    return { ...row, state: { ...row.state, axes: { type } } as EntitySummary['state'] };
  };

  function renderWorkflowBoard(opts: {
    row: EntitySummary;
    onSetState: (
      entityId: string,
      next: string,
      via: string,
      o?: { notify?: boolean },
    ) => void | Promise<{ ok: true } | { ok: false; reason: string }>;
  }) {
    return render(
      <EntityListPanel
        kind="task"
        rowsFor={rowsFor([])}
        ctx={ctx}
        mode="board"
        taskWorkflows={[CODE_RULE] as never}
        boardFor={(() => snapshot({ groups: groups(['open', [opts.row]]) })) as never}
        onSetState={opts.onSetState as never}
      />,
    );
  }

  it('a forbidden drop refuses INLINE at the refusing column and never calls the server', async () => {
    const onSetState = vi.fn();
    const row = typedTask('open', 'code');
    const { getByTestId, getAllByTestId, findByTestId } = renderWorkflowBoard({ row, onSetState });

    // Mod+ArrowRight aims the open card at pulled — which `code` forbids.
    fireEvent.keyDown(getByTestId('board-body'), { key: 'ArrowRight', metaKey: true });

    // THE assertion this block exists for: the executor was never invoked.
    expect(onSetState).not.toHaveBeenCalled();
    const refusal = await findByTestId('board-refusal');
    // The strip's words exactly — one sentence for one rule.
    expect(refusal.textContent).toBe('type code does not allow pulled');
    const pulled = getAllByTestId('board-column').find(
      (col) => col.getAttribute('data-column') === 'pulled',
    )!;
    expect(within(pulled).getByTestId('board-refusal')).toBeTruthy();
  });

  it('an allowed drop, an untyped row, and an unruled type all dispatch exactly as before', () => {
    for (const row of [
      typedTask('open', 'design'), // no rule for design
      taskOf('open'), // no axes at all
    ]) {
      const onSetState = vi.fn(async () => ({ ok: true }) as const);
      const view = renderWorkflowBoard({ row, onSetState: onSetState as never });
      fireEvent.keyDown(view.getByTestId('board-body'), { key: 'ArrowRight', metaKey: true });
      expect(onSetState).toHaveBeenCalledTimes(1);
      view.unmount();
    }

    // And a typed, RULED row moving to an ALLOWED status dispatches too:
    // working is structural, so no vocabulary can bar it.
    const onSetState = vi.fn(async () => ({ ok: true }) as const);
    const row = typedTask('pulled', 'code');
    const { getByTestId } = render(
      <EntityListPanel
        kind="task"
        rowsFor={rowsFor([])}
        ctx={ctx}
        mode="board"
        taskWorkflows={[CODE_RULE] as never}
        boardFor={(() => snapshot({ groups: groups(['pulled', [row]]) })) as never}
        onSetState={onSetState as never}
      />,
    );
    // Focus starts on column 0 (open, empty here): step focus onto the pulled
    // column first, then command the move pulled → working.
    fireEvent.keyDown(getByTestId('board-body'), { key: 'ArrowRight' });
    fireEvent.keyDown(getByTestId('board-body'), { key: 'ArrowRight', metaKey: true });
    expect(onSetState).toHaveBeenCalledTimes(1);
    expect(onSetState.mock.calls[0]![1]).toBe('working');
  });
});
