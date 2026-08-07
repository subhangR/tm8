// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CollectionResult, EntityDetail, EntitySummary, Page } from '@tm8/contract';
import { collectionEmpty, collectionInbox, fixtureDetails, taskGuideLines } from '../../fixtures';
import type { ContentBlockRef } from '../../domain';
import { GenericBody } from './GenericBody';

/**
 * THE MANAGED ITEMS BLOCK — the half of collections a person actually touches.
 *
 * WHAT THESE ARE FOR. The block was a read-only chip row rendering
 * `content.items`, which the server hard-coded to `[]` for every collection —
 * so it drew a heading over nothing while `itemCount` beside it reported the
 * truth, and no test noticed because none had ever rendered a POPULATED
 * collection. Every case here therefore starts from real items.
 *
 * THE PARAMETERS ARE THE POINT. `manage` and `tree` are block params, not a
 * new block kind, so the same component still serves equipped spells and a
 * member's work as a plain chip row. The first two cases pin that default:
 * without the params, nothing interactive appears. Otherwise a later change
 * that turns management on unconditionally would put a remove button on
 * DERIVED lists, advertising a write with nothing behind it.
 *
 * JOINT CONDITION, asserted separately: `manage` requires the registry flag
 * AND wired commands. A flag alone would render the enabled-inert affordance
 * this package throws over — a control that looks live and does nothing.
 */

const MANAGED: ContentBlockRef[] = [{ block: 'items', label: 'ITEMS', params: { manage: true, tree: true } }];
const PLAIN: ContentBlockRef[] = [{ block: 'items', label: 'ITEMS' }];

const populated = fixtureDetails[collectionInbox.id]!;
const empty = fixtureDetails[collectionEmpty.id]!;

function items(detail: EntityDetail): EntitySummary[] {
  return (detail.content as unknown as { items: EntitySummary[] }).items;
}

function commands(over: Partial<{
  addCollectionItem: ReturnType<typeof vi.fn>;
  removeCollectionItem: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    addCollectionItem: vi.fn().mockResolvedValue({}),
    removeCollectionItem: vi.fn().mockResolvedValue({ removed: true }),
    ...over,
  };
}

function reads(over: Partial<Record<'entity' | 'children' | 'query', unknown>> = {}) {
  return {
    entity: vi.fn().mockResolvedValue({ content: { kind: 'task' } } as unknown as EntityDetail),
    children: vi.fn().mockResolvedValue({ items: [], nextCursor: null } as Page<EntitySummary>),
    query: vi.fn().mockResolvedValue({ page: { items: [], nextCursor: null } } as unknown as CollectionResult),
    ...over,
  } as never;
}

describe('collection items — read-only by default', () => {
  it('renders a plain chip row with no controls when the params are absent', () => {
    render(<GenericBody detail={populated} blocks={PLAIN} commands={commands()} reads={reads()} />);

    expect(screen.getByText(items(populated)[0]!.title)).toBeTruthy();
    expect(screen.queryByTestId('collection-items')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(screen.queryByText('＋ Add items')).toBeNull();
  });

  it('draws no remove control when the registry asks but no commands are wired', () => {
    // The enabled-inert case. Without this, a surface could render the manage
    // affordances against a null seam and the buttons would silently do
    // nothing — indistinguishable from a broken app.
    render(<GenericBody detail={populated} blocks={MANAGED} commands={null} reads={reads()} />);

    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(screen.queryByText('＋ Add items')).toBeNull();
  });

  it('still says "nothing here yet" for an empty collection, designed not accidental', () => {
    render(<GenericBody detail={empty} blocks={MANAGED} commands={commands()} reads={reads()} />);
    expect(screen.getByText('Nothing here yet.')).toBeTruthy();
  });
});

describe('collection items — removing', () => {
  it('removes by PAIR and drops the row optimistically', async () => {
    const cmds = commands();
    const first = items(populated)[0]!;
    render(<GenericBody detail={populated} blocks={MANAGED} commands={cmds} reads={reads()} />);

    fireEvent.click(screen.getByRole('button', { name: `Remove ${first.title} from this collection` }));

    expect(cmds.removeCollectionItem).toHaveBeenCalledWith(populated.id, first.id);
    // Optimistic: the row leaves before the promise settles, because waiting
    // on a round trip to acknowledge a click reads as an unresponsive app.
    await waitFor(() => expect(screen.queryByText(first.title)).toBeNull());
  });

  it('puts the row BACK and names the failure when the write rejects', async () => {
    const first = items(populated)[0]!;
    const cmds = commands({
      removeCollectionItem: vi.fn().mockRejectedValue(new Error('forbidden')),
    });
    render(<GenericBody detail={populated} blocks={MANAGED} commands={cmds} reads={reads()} />);

    fireEvent.click(screen.getByRole('button', { name: `Remove ${first.title} from this collection` }));

    // Both halves matter: the item is still there AND the user is told why.
    // A silent rollback looks like the click never registered.
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('forbidden'));
    expect(screen.getByRole('status').textContent).toContain('still in the collection');
    expect(screen.getByText(first.title)).toBeTruthy();
  });
});

describe('collection items — reordering', () => {
  it('renumbers the WHOLE list 1..N so the order is correct, not merely plausible', async () => {
    const cmds = commands();
    const all = items(populated);
    render(<GenericBody detail={populated} blocks={MANAGED} commands={cmds} reads={reads()} />);

    const rows = screen.getByTestId('collection-items').querySelectorAll('.pn-item__row');
    // Drag the last row onto the first.
    fireEvent.dragStart(rows[2]!);
    fireEvent.drop(rows[0]!);

    await waitFor(() => expect(cmds.addCollectionItem).toHaveBeenCalledTimes(3));
    // `content.items` carries no positions, so a midpoint cannot be computed
    // from what the client holds. Renumbering is the only ordering this client
    // can produce that is correct rather than usually right.
    expect(cmds.addCollectionItem.mock.calls.map((c) => c[1])).toEqual([
      { entityId: all[2]!.id, position: 1 },
      { entityId: all[0]!.id, position: 2 },
      { entityId: all[1]!.id, position: 3 },
    ]);
  });

  it('restores the previous order when a renumber write rejects', async () => {
    const all = items(populated);
    const cmds = commands({
      addCollectionItem: vi.fn().mockRejectedValue(new Error('conflict')),
    });
    render(<GenericBody detail={populated} blocks={MANAGED} commands={cmds} reads={reads()} />);

    const rows = screen.getByTestId('collection-items').querySelectorAll('.pn-item__row');
    fireEvent.dragStart(rows[2]!);
    fireEvent.drop(rows[0]!);

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('put back'));
    const titles = [...screen.getByTestId('collection-items').querySelectorAll('.pn-item__row')]
      .map((row) => row.textContent ?? '');
    expect(titles[0]).toContain(all[0]!.title);
  });
});

describe('collection items — the tree', () => {
  it('expands a NESTED COLLECTION by its own membership', async () => {
    const nested = { ...taskGuideLines, id: 'nested-child', title: 'Nested member' };
    const r = reads({
      entity: vi.fn().mockResolvedValue({
        content: { kind: 'collection', description: '', items: [nested] },
      } as unknown as EntityDetail),
    });
    render(<GenericBody detail={populated} blocks={MANAGED} commands={commands()} reads={r} />);

    const first = items(populated)[0]!;
    fireEvent.click(screen.getByRole('button', { name: `Expand ${first.title}` }));

    await waitFor(() => expect(screen.getByText('Nested member')).toBeTruthy());
    // Structural, not kind-keyed: the row carried `items`, so membership won
    // and the hierarchy was never consulted.
    expect((r as unknown as { children: ReturnType<typeof vi.fn> }).children).not.toHaveBeenCalled();
  });

  it('expands anything else by its HIERARCHY children — the subentities view', async () => {
    const child = { ...taskGuideLines, id: 'subtask-1', title: 'A subtask' };
    const r = reads({
      entity: vi.fn().mockResolvedValue({ content: { kind: 'task' } } as unknown as EntityDetail),
      children: vi.fn().mockResolvedValue({ items: [child], nextCursor: null } as Page<EntitySummary>),
    });
    render(<GenericBody detail={populated} blocks={MANAGED} commands={commands()} reads={r} />);

    const first = items(populated)[0]!;
    fireEvent.click(screen.getByRole('button', { name: `Expand ${first.title}` }));

    await waitFor(() => expect(screen.getByText('A subtask')).toBeTruthy());
  });

  it('draws NO caret when no reader is wired, rather than one that opens onto nothing', () => {
    render(<GenericBody detail={populated} blocks={MANAGED} commands={commands()} reads={null} />);
    expect(screen.queryByRole('button', { name: /^Expand / })).toBeNull();
  });

  it('says so honestly when an expansion has nothing under it', async () => {
    render(<GenericBody detail={populated} blocks={MANAGED} commands={commands()} reads={reads()} />);
    const first = items(populated)[0]!;

    fireEvent.click(screen.getByRole('button', { name: `Expand ${first.title}` }));

    await waitFor(() => expect(screen.getByText('Nothing under this.')).toBeTruthy());
  });
});

describe('collection items — adding', () => {
  it('picks through the same query executor as every other list, and appends', async () => {
    const candidate = { ...taskGuideLines, id: 'pick-me', title: 'Pick me' };
    const cmds = commands();
    const r = reads({
      query: vi.fn().mockResolvedValue({
        page: { items: [candidate], nextCursor: null },
      } as unknown as CollectionResult),
    });
    render(<GenericBody detail={populated} blocks={MANAGED} commands={cmds} reads={r} />);

    fireEvent.click(screen.getByText('＋ Add items'));
    await waitFor(() => expect(screen.getByTestId('collection-picker')).toBeTruthy());

    fireEvent.click(within(screen.getByTestId('collection-picker')).getByText('Pick me'));

    // No `position` — append is the server's to resolve. A client that reads
    // the max and adds one races every other client appending.
    await waitFor(() =>
      expect(cmds.addCollectionItem).toHaveBeenCalledWith(populated.id, { entityId: 'pick-me' }));
  });

  it('hides rows already in the collection so picking one cannot look like a no-op', async () => {
    const present = items(populated)[0]!;
    const r = reads({
      query: vi.fn().mockResolvedValue({
        page: { items: [present], nextCursor: null },
      } as unknown as CollectionResult),
    });
    render(<GenericBody detail={populated} blocks={MANAGED} commands={commands()} reads={r} />);

    fireEvent.click(screen.getByText('＋ Add items'));

    const picker = await screen.findByTestId('collection-picker');
    await waitFor(() => expect(within(picker).getByText('Nothing here to add.')).toBeTruthy());
  });
});
