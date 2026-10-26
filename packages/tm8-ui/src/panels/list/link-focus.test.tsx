// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { EntityDetail, EntitySummary } from '@tm8/contract';
import { SideLinks } from '../../tab-workspace/view/SideLinks';
import { requestLinkFocus, resetLinkFocus, takeLinkFocus } from './linkFocus';

/**
 * THE COUNTS LINE'S DOOR, FROM ONE COLUMN TO THE OTHER (design doc 01a1465d
 * §6: "clicking a count opens that group in the detail panel").
 *
 * `quiet-tile.test.tsx` covers the near side — the tile calls `onOpenLinks`
 * with the group's registry KIND. This covers the far side, which is the half
 * that has no component boundary to make it obvious: a module-level one-shot
 * store, read by a panel in a different column. The asker is a list row and
 * the reader is the side panel, with the whole workspace shell between them,
 * so nothing in either file's types says they are connected and nothing but a
 * test will notice the day one of them stops honouring it.
 */

function summary(id: string, kind: string, at: string): EntitySummary {
  return { id, kind, title: `${kind} ${id}`, createdAt: at, updatedAt: at } as unknown as EntitySummary;
}

const SELF = 'self';

/** A task with two docs, one artifact and one child, all as links. */
const detail = {
  id: SELF,
  kind: 'task',
  connections: {
    outgoing: [
      {
        type: 'attached_to',
        direction: 'outgoing',
        edges: [
          { id: 'e1', type: 'attached_to', source: summary(SELF, 'task', '2026-10-01T00:00:00Z'), target: summary('d1', 'doc', '2026-10-01T00:00:00Z'), createdAt: '2026-10-05T00:00:00Z' },
          { id: 'e2', type: 'attached_to', source: summary(SELF, 'task', '2026-10-01T00:00:00Z'), target: summary('d2', 'doc', '2026-10-01T00:00:00Z'), createdAt: '2026-10-04T00:00:00Z' },
          { id: 'e3', type: 'attached_to', source: summary(SELF, 'task', '2026-10-01T00:00:00Z'), target: summary('a1', 'artifact', '2026-10-01T00:00:00Z'), createdAt: '2026-10-03T00:00:00Z' },
        ],
      },
    ],
    incoming: [],
    unresolvedHardDependencyCount: 0,
  },
  hierarchy: { parent: null, children: { items: [summary('c1', 'task', '2026-10-02T00:00:00Z')], nextCursor: null }, path: [] },
} as unknown as EntityDetail;

const peers = (container: HTMLElement): string[] =>
  [...container.querySelectorAll<HTMLElement>('.tws-side-row')].map((el) => el.dataset.peerId!);

beforeEach(() => resetLinkFocus());
afterEach(() => {
  cleanup();
  resetLinkFocus();
});

describe('the one-shot link-focus request', () => {
  it('is readable once, and only by the entity it names', () => {
    requestLinkFocus('task-a', 'doc');
    expect(takeLinkFocus('task-b')).toBeNull();
    expect(takeLinkFocus('task-a')).toMatchObject({ entityId: 'task-a', kind: 'doc' });
    /* CONSUMED. A filter that reapplied on every render would fight the reader
       the moment they cleared the chip by hand. */
    expect(takeLinkFocus('task-a')).toBeNull();
  });

  it('a second request for the same group is a NEW request', () => {
    requestLinkFocus('task-a', 'doc');
    const first = takeLinkFocus('task-a')!;
    requestLinkFocus('task-a', 'doc');
    const second = takeLinkFocus('task-a')!;
    expect(second.seq).toBeGreaterThan(first.seq);
  });
});

describe('SideLinks honours the request', () => {
  it('opens narrowed to the group, with a chip that says so and clears it', () => {
    requestLinkFocus(SELF, 'doc');
    const { container } = render(<SideLinks detail={detail} connections={undefined} onOpenEntity={() => {}} />);

    /* Narrowed on the FIRST render: the request is filed before the tab opens
       (see `Browser.openLinks`), so the reader never sees the full list flash. */
    expect(peers(container)).toEqual(['d1', 'd2']);
    const chip = container.querySelector<HTMLElement>('[data-testid="tws-side-kind-chip"]')!;
    expect(chip.textContent).toContain('Docs');
    expect(chip.textContent).toContain('2');

    fireEvent.click(chip);
    expect(container.querySelector('[data-testid="tws-side-kind-chip"]')).toBeNull();
    expect(peers(container).sort()).toEqual(['a1', 'c1', 'd1', 'd2']);
  });

  it('shows everything when the group has nothing linked — never an unexplained empty list', () => {
    /* The normal case for a count a mid-rollout server sent that the graph
       page does not cover: the number was honest, and so is the whole list. */
    requestLinkFocus(SELF, 'drawing');
    const { container } = render(<SideLinks detail={detail} connections={undefined} onOpenEntity={() => {}} />);
    expect(peers(container).length).toBe(4);
    expect(container.querySelector('[data-testid="tws-side-kind-chip"]')).toBeNull();
  });

  it('ignores a request filed for another entity', () => {
    requestLinkFocus('someone-else', 'doc');
    const { container } = render(<SideLinks detail={detail} connections={undefined} onOpenEntity={() => {}} />);
    expect(peers(container).length).toBe(4);
  });
});
