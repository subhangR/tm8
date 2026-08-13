// @vitest-environment jsdom
/**
 * COLLECTIONS FROM THE LIST SURFACE — the two affordances the registry's
 * `list.membership` declaration powers (migration 100):
 *
 *   1. THE LENS. Pick a collection and the list narrows to its members,
 *      through the contract's own `filters.edge` clause — a real query the
 *      seam executes, never a client-side partition. The `recorder` seam
 *      here honours its arguments for the same reason `list-sort-filter`'s
 *      does: a stub that ignores the filter is structurally incapable of
 *      noticing the panel dropped it.
 *
 *   2. THE ROW PICKER. Every expanded row carries a Collections control —
 *      the same mechanic as assignment (one edge per menu row, toggled
 *      individually, ✓ from live state), with the write raised as intent
 *      (`onMembership`) and never performed in the panel.
 *
 * And the HONESTY seam between them: a kind-scoped list showing one set's
 * members is NOT the set — a mixed collection holds every kind — so the lens
 * carries a note with both numbers (this kind's members, the set's total).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Connections, EntitySummary } from '@tm8/contract';
import type { ActionContext, QueryFilter, SortKey } from '../domain';
import { getKind } from '../domain';
import {
  FIXTURE_SPACE_ID,
  ada,
  collectionEmpty,
  collectionInbox,
  fixtureSummaries,
} from '../fixtures';
import { EntityListPanel } from './index';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const tasks = fixtureSummaries.filter((s) => s.state.kind === 'task');
const sets = [collectionInbox, collectionEmpty];

const CAPS_FULL = {
  canEdit: true, canDelete: true, canAddChild: true, canLink: true,
  canPull: true, canReact: true, canGrantPoints: true, canComplete: true,
} as const;

/** True when a recorded filter carries the lens's edge clause for `setId`. */
const carriesLens = (filter: QueryFilter | undefined, setId: string): boolean => {
  const edge = (filter as { edge?: { type?: string; direction?: string; entityId?: string } } | undefined)?.edge;
  return edge?.type === 'contains' && edge.direction === 'incoming' && edge.entityId === setId;
};

/** A row seam that remembers every question and answers the lens honestly. */
function recorder(rows: readonly EntitySummary[], memberIds: readonly string[]) {
  const asks: Array<{ filter: QueryFilter; sort?: SortKey }> = [];
  const members = new Set(memberIds);
  return {
    asks,
    rowsFor: (filter: QueryFilter, sort?: SortKey) => {
      asks.push({ filter, sort });
      return (filter as { edge?: unknown })?.edge !== undefined
        ? rows.filter((row) => members.has(row.id))
        : rows;
    },
  };
}

describe('the collection lens on the list surface', () => {
  it('is declared for every collection-strategy kind — registry data, not per-kind wiring', () => {
    // The lens and row picker exist exactly where `list.membership` is
    // declared. `contains` accepts every dst kind (001:921 — dst_kinds
    // wildcard), so `baseList` declares it universally.
    expect(getKind('task').list.membership).toMatchObject({
      edgeType: 'contains',
      setKind: 'collection',
    });
    expect(getKind('doc').list.membership).toBeDefined();
    expect(getKind('collection').list.membership).toBeDefined();
  });

  it('does not render the trigger when the host wired no sets source', () => {
    const seam = recorder(tasks, []);
    const { queryByTestId } = render(
      <EntityListPanel kind="task" rowsFor={seam.rowsFor} ctx={ctx} />,
    );
    // Same rule as boardFor: an unwired source is this host's honest absence.
    expect(queryByTestId('collection-lens-trigger')).toBeNull();
  });

  it('picking a set issues REAL queries carrying the edge clause, and clearing retires it', () => {
    const seam = recorder(tasks, [tasks[0]!.id]);
    const { getByTestId, getAllByTestId } = render(
      <EntityListPanel kind="task" rowsFor={seam.rowsFor} ctx={ctx} membershipSets={sets} />,
    );

    // Before the pick, nothing asked the members question.
    expect(seam.asks.some((ask) => carriesLens(ask.filter, collectionInbox.id))).toBe(false);

    fireEvent.click(getByTestId('collection-lens-trigger'));
    const option = getAllByTestId('collection-lens-option')
      .find((node) => node.textContent?.includes(collectionInbox.title));
    expect(option).toBeDefined();
    fireEvent.click(option!);

    // The lens reached the seam: at least one band query narrows by the edge.
    expect(seam.asks.some((ask) => carriesLens(ask.filter, collectionInbox.id))).toBe(true);

    // The active lens is a dismissable chip; clearing it stops the narrowing.
    const chip = getByTestId('collection-lens-chip');
    expect(chip.textContent).toContain(collectionInbox.title);
    seam.asks.length = 0;
    fireEvent.click(chip);
    expect(seam.asks.some((ask) => carriesLens(ask.filter, collectionInbox.id))).toBe(false);
  });

  it('states what it hides: N of the set’s M items are this kind — both numbers sourced', () => {
    // ONE fixture task is a member; the set's summary says it holds 3 items.
    // A mixed collection must never read as kind-pure on a kind-scoped list.
    const seam = recorder(tasks, [tasks[0]!.id]);
    const { getByTestId, getAllByTestId } = render(
      <EntityListPanel kind="task" rowsFor={seam.rowsFor} ctx={ctx} membershipSets={sets} />,
    );
    fireEvent.click(getByTestId('collection-lens-trigger'));
    fireEvent.click(
      getAllByTestId('collection-lens-option')
        .find((node) => node.textContent?.includes(collectionInbox.title))!,
    );
    const note = getByTestId('collection-lens-note');
    expect(note.textContent).toContain(`Only members of “${collectionInbox.title}” are shown`);
    expect(note.textContent).toContain('1 of its 3 items are tasks');
  });

  it('an empty sets page is a designed empty, not a bare menu', () => {
    const seam = recorder(tasks, []);
    const { getByTestId } = render(
      <EntityListPanel kind="task" rowsFor={seam.rowsFor} ctx={ctx} membershipSets={[]} />,
    );
    fireEvent.click(getByTestId('collection-lens-trigger'));
    expect(getByTestId('collection-lens-empty').textContent).toMatch(/most recent page/i);
  });
});

// ---------------------------------------------------------------------------

/** The row's live connections: `containedIn` sets hold it via `contains`. */
function connectionsWith(row: EntitySummary, containedIn: readonly EntitySummary[]): Connections {
  return {
    outgoing: [],
    incoming: [
      {
        type: 'contains',
        direction: 'incoming',
        label: 'contains (incoming)',
        edges: containedIn.map((set, index) => ({
          id: `edge-${index}`,
          type: 'contains',
          source: set,
          target: row,
          props: { position: index + 1 },
          createdBy: ada,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      },
    ],
    unresolvedHardDependencyCount: 0,
  };
}

function expandFirstRow(): HTMLElement {
  const toggles = screen.getAllByRole('button', { name: /^Expand details/ });
  fireEvent.click(toggles[0]!);
  const strips = document.querySelectorAll('.lp__rowdetail');
  expect(strips.length).toBeGreaterThan(0);
  return strips[0] as HTMLElement;
}

describe('the expanded row’s Collections picker', () => {
  const row = tasks[0]!;

  function mount(over: Partial<React.ComponentProps<typeof EntityListPanel>> = {}) {
    return render(
      <div className="cv2-root">
        <EntityListPanel
          kind="task"
          rowsFor={() => [row]}
          ctx={ctx}
          capabilitiesOf={() => CAPS_FULL}
          membershipSets={sets}
          connectionsOf={() => connectionsWith(row, [collectionInbox])}
          {...over}
        />
      </div>,
    );
  }

  it('marks current membership ✓ and raises add / remove intent with the (set, row) pair', () => {
    const onMembership = vi.fn();
    mount({ onMembership });
    const strip = expandFirstRow();

    // The face names the containing set — read from live edges, not invented.
    expect(within(strip).getByTestId('row-membership-face').textContent).toContain(
      collectionInbox.title,
    );

    fireEvent.click(within(strip).getByTestId('row-membership-trigger'));
    // The menu PORTALS out of the strip (the tile clips positioned
    // descendants — overflow:hidden + container-type), so options are
    // queried at the document level.
    const options = screen.getAllByTestId('row-membership-option');
    const inbox = options.find((node) => node.getAttribute('data-set') === collectionInbox.id)!;
    const empty = options.find((node) => node.getAttribute('data-set') === collectionEmpty.id)!;
    expect(inbox.getAttribute('aria-pressed')).toBe('true');
    expect(empty.getAttribute('aria-pressed')).toBe('false');

    // A member toggles OUT; a non-member toggles IN — per set, never a batch.
    fireEvent.click(inbox);
    expect(onMembership).toHaveBeenCalledWith(row.id, collectionInbox.id, false);
    fireEvent.click(empty);
    expect(onMembership).toHaveBeenCalledWith(row.id, collectionEmpty.id, true);
  });

  it('never offers a set to itself — the node refuses the self-edge', () => {
    const onMembership = vi.fn();
    render(
      <div className="cv2-root">
        <EntityListPanel
          kind="collection"
          rowsFor={() => [collectionInbox]}
          ctx={ctx}
          capabilitiesOf={() => CAPS_FULL}
          membershipSets={sets}
          connectionsOf={() => connectionsWith(collectionInbox, [])}
          onMembership={onMembership}
        />
      </div>,
    );
    const strip = expandFirstRow();
    fireEvent.click(within(strip).getByTestId('row-membership-trigger'));
    // Portaled menu — document-level query, same as above.
    const offered = screen
      .getAllByTestId('row-membership-option')
      .map((node) => node.getAttribute('data-set'));
    expect(offered).toContain(collectionEmpty.id);
    expect(offered).not.toContain(collectionInbox.id);
  });

  it('unwired hosts get refused-with-reason, never a live control that drops the click', () => {
    mount({ onMembership: undefined });
    const strip = expandFirstRow();
    // No trigger; the face renders inside the shared disabled vocabulary.
    expect(within(strip).queryByTestId('row-membership-trigger')).toBeNull();
    expect(within(strip).getByTestId('row-membership-face')).toBeTruthy();
    expect(
      within(strip)
        .getAllByTestId('disabled-with-reason')
        .some((node) => node.getAttribute('aria-label')?.toLowerCase().includes('collections')),
    ).toBe(true);
  });
});

describe('the COLLAPSED tile’s add-to-collection (user ruling 2026-08-13)', () => {
  const row = tasks[0]!;

  it('offers the same set menu from the collapsed action cluster, no expand needed', () => {
    // The reported gap: the only row-level add lived on the EXPANDED strip,
    // so a collapsed tile had no membership affordance at all.
    const onMembership = vi.fn();
    render(
      <div className="cv2-root">
        <EntityListPanel
          kind="task"
          rowsFor={() => [row]}
          ctx={ctx}
          capabilitiesOf={() => CAPS_FULL}
          membershipSets={sets}
          connectionsOf={() => connectionsWith(row, [])}
          onMembership={onMembership}
        />
      </div>,
    );
    // Deliberately NOT expanding any row first.
    expect(document.querySelectorAll('.lp__rowdetail')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('row-membership-trigger'));
    const option = screen
      .getAllByTestId('row-membership-option')
      .find((node) => node.getAttribute('data-set') === collectionEmpty.id)!;
    fireEvent.click(option);
    expect(onMembership).toHaveBeenCalledWith(row.id, collectionEmpty.id, true);
  });
});
