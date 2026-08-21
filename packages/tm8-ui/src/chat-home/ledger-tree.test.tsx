// @vitest-environment jsdom
/**
 * LEDGER TREE — pure renders against fixture models (SW, task 01a023fa-f35b).
 *
 * The fixtures are hand-built model literals, NOT folds: this file tests the
 * widget's rendering contract, and S2's own suite tests the fold. The two
 * easy-to-violate constraints are pinned here because no other test can see
 * them: R8 (no tool name ever reaches the surface) and the honesty rule (a
 * row is a button only where the press can land, and never gated on kind —
 * ruling refinement 2026-08-21: ANY entity row opens when the handler is
 * wired; where the click routes is the host's business).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { kindWord } from './ledger';
import { LedgerTree, type LedgerTreeModel } from './ledger-tree';

const TASK_1 = '019f0000-0000-7000-8000-000000000101';
const TASK_11 = '019f0000-0000-7000-8000-000000000102';
const TASK_111 = '019f0000-0000-7000-8000-000000000103';
const DOC_1 = '019f0000-0000-7000-8000-000000000201';
const SESSION_1 = '019f0000-0000-7000-8000-000000000301';
const TURN_A = '019f0000-0000-7000-8000-000000000901' as EntityId;

function create(
  id: string,
  kind: string | null,
  title: string | null,
  parentId: string | null,
  seq: number,
  spawned = false,
) {
  return { id, kind, title, parentId, messageId: TURN_A, seq, spawned };
}

/** Task 1 > Task 1.1 > Task 1.1.1, Doc 1, and a spawned session (D3). */
function fixtureModel(overrides?: Partial<LedgerTreeModel>): LedgerTreeModel {
  return {
    labels: new Map([
      [TASK_1, { kind: 'task', title: 'Task 1' }],
      [TASK_11, { kind: 'task', title: 'Task 1.1' }],
      [TASK_111, { kind: 'task', title: 'Task 1.1.1' }],
      [DOC_1, { kind: 'doc', title: 'Doc 1' }],
      [SESSION_1, { kind: 'work_session', title: 'Worker A' }],
    ]),
    parentOf: new Map<string, string | null>([
      [TASK_11, TASK_1],
      [TASK_111, TASK_11],
    ]),
    creates: [
      create(TASK_1, 'task', 'Task 1', null, 1),
      create(TASK_11, 'task', 'Task 1.1', TASK_1, 2),
      create(TASK_111, 'task', 'Task 1.1.1', TASK_11, 3),
      create(DOC_1, 'doc', 'Doc 1', null, 4),
      create(SESSION_1, 'work_session', 'Worker A', null, 5, true),
    ],
    turns: [
      {
        messageId: TURN_A,
        reads: { byKind: new Map([['task', 1], ['doc', 1]]), total: 2, ids: [TASK_1, DOC_1] },
        creates: [],
        transitions: [],
        empty: false,
      },
    ],
    transitions: [],
    statusNow: new Map([[TASK_1, 'in_progress']]),
    ...overrides,
  };
}

describe('the forest', () => {
  it('indents a child under its parent, three levels deep', () => {
    const view = render(<LedgerTree model={fixtureModel()} />);
    const rows = view.getAllByTestId('ledger-row');
    expect(rows.map((r) => r.getAttribute('data-id'))).toEqual([
      TASK_1, TASK_11, TASK_111, DOC_1, SESSION_1,
    ]);
    // Task 1.1.1 sits inside two nested lists; Doc 1 inside none.
    const deep = rows[2]!;
    expect(deep.closest('.tch-ledger-tree__list--nested')?.parentElement
      ?.closest('.tch-ledger-tree__list--nested')).toBeTruthy();
    expect(rows[3]!.closest('.tch-ledger-tree__list--nested')).toBeNull();
  });

  it('hangs a child under its nearest VISIBLE ancestor when the middle of a chain is filtered out', () => {
    // Only Task 1 and Task 1.1.1 visible: 1.1 filtered → 1.1.1 under 1.
    const model = fixtureModel({
      creates: [
        create(TASK_1, 'task', 'Task 1', null, 1),
        create(TASK_111, 'task', 'Task 1.1.1', TASK_11, 3),
      ],
    });
    const view = render(<LedgerTree model={model} />);
    const rows = view.getAllByTestId('ledger-row');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.closest('.tch-ledger-tree__list--nested')).toBeTruthy();
  });

  it('renders nothing at all for an empty scope — the host owns the zero state', () => {
    const view = render(
      <LedgerTree model={fixtureModel({ creates: [] })} />,
    );
    expect(view.queryByTestId('ledger-tree')).toBeNull();
  });
});

describe('filters (ruling 6 — a filter, never a refetch)', () => {
  it("scope 'sessions' shows only the work sessions this chat created", () => {
    const view = render(<LedgerTree model={fixtureModel()} filter={{ scope: 'sessions' }} />);
    const rows = view.getAllByTestId('ledger-row');
    expect(rows.map((r) => r.getAttribute('data-id'))).toEqual([SESSION_1]);
  });

  it('scope = an entity shows the creations under it, not the scope itself', () => {
    const view = render(
      <LedgerTree model={fixtureModel()} filter={{ scope: TASK_1 as never }} />,
    );
    const rows = view.getAllByTestId('ledger-row');
    expect(rows.map((r) => r.getAttribute('data-id'))).toEqual([TASK_11, TASK_111]);
  });

  it("scope 'sessions' keys off the spawned flag, not the kind — an unresolved spawn is still a session", () => {
    const bare = '019f0000-0000-7000-8000-000000000302';
    const model = fixtureModel({
      creates: [create(bare, null, null, null, 1, true)],
      labels: new Map(),
      statusNow: new Map(),
    });
    const view = render(<LedgerTree model={model} filter={{ scope: 'sessions' }} />);
    expect(view.getAllByTestId('ledger-row').map((r) => r.getAttribute('data-id'))).toEqual([bare]);
  });

  it("readsOnly + turnMessageId shows exactly that turn's reads", () => {
    const view = render(
      <LedgerTree model={fixtureModel()} filter={{ turnMessageId: TURN_A, readsOnly: true }} />,
    );
    const rows = view.getAllByTestId('ledger-row');
    expect(rows.map((r) => r.getAttribute('data-id'))).toEqual([TASK_1, DOC_1]);
  });
});

describe('the kind chips', () => {
  it('counts over the scoped set and toggles kinds in and out', () => {
    const view = render(<LedgerTree model={fixtureModel()} />);
    const chips = view.getAllByTestId('ledger-kind-chip');
    expect(chips.map((c) => c.textContent)).toEqual(['3 tasks', '1 doc', '1 session']);

    fireEvent.click(chips[1]!); // select doc only
    expect(view.getAllByTestId('ledger-row')).toHaveLength(1);
    // The chip counts do NOT renumber under their own filter.
    expect(view.getAllByTestId('ledger-kind-chip').map((c) => c.textContent))
      .toEqual(['3 tasks', '1 doc', '1 session']);

    fireEvent.click(view.getAllByTestId('ledger-kind-chip')[1]!); // deselect → all
    expect(view.getAllByTestId('ledger-row')).toHaveLength(5);
  });

  it("buckets an unknown kind as a selectable 'entity' chip, never dropped", () => {
    const bare = '019f0000-0000-7000-8000-000000000401';
    const model = fixtureModel({
      creates: [
        create(TASK_1, 'task', 'Task 1', null, 1),
        create(bare, null, null, null, 2),
      ],
      statusNow: new Map(),
    });
    const view = render(<LedgerTree model={model} />);
    const chips = view.getAllByTestId('ledger-kind-chip');
    expect(chips.map((c) => c.getAttribute('data-kind'))).toEqual(['task', 'entity']);
    fireEvent.click(chips[1]!);
    expect(view.getAllByTestId('ledger-row').map((r) => r.getAttribute('data-id'))).toEqual([bare]);
  });

  it('draws no chip row when only one kind is in scope', () => {
    const view = render(<LedgerTree model={fixtureModel()} filter={{ scope: 'sessions' }} />);
    expect(view.queryByTestId('ledger-kind-chip')).toBeNull();
  });

  it('humanizes and pluralizes kinds — never ships "3 c:invoices"', () => {
    expect(kindWord('c:invoice', 3)).toBe('invoices');
    expect(kindWord('work_session', 1)).toBe('session');
    expect(kindWord('work_session', 5)).toBe('sessions');
    expect(kindWord('memory', 4)).toBe('memories');
    expect(kindWord('entity', 2)).toBe('entities');
  });
});

describe('status words', () => {
  it("renders the model's currentState word when the host supplies no verdict", () => {
    const view = render(<LedgerTree model={fixtureModel()} />);
    const row = view.getAllByTestId('ledger-row')[0]!;
    expect(row.textContent).toContain('in_progress');
  });

  it('renders the host statusOf verdict VERBATIM and lets it win over currentState', () => {
    const view = render(
      <LedgerTree
        model={fixtureModel()}
        statusOf={(id) => (id === TASK_1 ? { word: 'Live Coordinator', tone: 'run' } : null)}
      />,
    );
    const row = view.getAllByTestId('ledger-row')[0]!;
    expect(row.textContent).toContain('Live Coordinator');
    expect(row.textContent).not.toContain('in_progress');
  });
});

describe('honesty rules', () => {
  it('every row is a real button when the host wires onOpenEntity — no kind gating', () => {
    const onOpenEntity = vi.fn();
    const view = render(<LedgerTree model={fixtureModel()} onOpenEntity={onOpenEntity} />);
    for (const row of view.getAllByTestId('ledger-row')) {
      expect(row.tagName).toBe('BUTTON');
    }
    fireEvent.click(view.getAllByTestId('ledger-row')[3]!); // the doc, not a session
    expect(onOpenEntity).toHaveBeenCalledWith(DOC_1);
  });

  it('every row is an inert span when the host wires nothing — never a dead control', () => {
    const view = render(<LedgerTree model={fixtureModel()} />);
    for (const row of view.getAllByTestId('ledger-row')) {
      expect(row.tagName).toBe('SPAN');
    }
    // The kind chips stay live: a view filter is not a host verb.
    expect(view.getAllByTestId('ledger-kind-chip')[0]!.tagName).toBe('BUTTON');
  });

  it('R8 — no tool name ever reaches the surface', () => {
    const view = render(<LedgerTree model={fixtureModel()} onOpenEntity={vi.fn()} />);
    for (const banned of ['tm8_act', 'tm8_delegate', 'tm8_read', 'entities.create', 'execution.spawn']) {
      expect(view.container.textContent).not.toContain(banned);
    }
  });

  it('a title the model does not know renders as the truncated id, quietly', () => {
    const model = fixtureModel({
      labels: new Map([[TASK_1, { kind: 'task' }]]),
      creates: [create(TASK_1, 'task', null, null, 1)],
      statusNow: new Map(),
    });
    const view = render(<LedgerTree model={model} />);
    const title = view.getByTestId('ledger-row').querySelector('.tch-ledger-tree__title')!;
    expect(title.getAttribute('data-placeholder')).toBe('true');
    expect(title.textContent).toContain('…');
  });
});
