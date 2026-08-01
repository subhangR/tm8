// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { EntityDetail, EntitySummary } from '@tm8/contract';
import { fixtureDetails } from '../../fixtures';
import { ConnectionsTab } from './tabs';

/**
 * The seam groups edges BY TYPE. This tab inverts that to group BY PEER
 * ENTITY — so the assertions here are about the inversion: one row per peer
 * however many edges it holds, every edge type visible on that row, and
 * direction preserved (an edge type read from the other end is a DIFFERENT
 * relation, not a duplicate).
 */

const self = Object.values(fixtureDetails).find((d) => d.deletedAt == null)!;

function peer(id: string, title: string): EntitySummary {
  return { ...(self as unknown as EntitySummary), id, title };
}

function group(
  type: string,
  label: string,
  direction: 'outgoing' | 'incoming',
  edges: { id: string; peer: EntitySummary; hard?: boolean; resolved?: boolean }[],
) {
  return {
    type,
    label,
    direction,
    edges: edges.map((e) => ({
      id: e.id,
      type,
      hard: e.hard,
      resolved: e.resolved,
      ...(direction === 'outgoing'
        ? { source: self as unknown as EntitySummary, target: e.peer }
        : { source: e.peer, target: self as unknown as EntitySummary }),
    })),
  } as unknown as EntityDetail['connections']['outgoing'][number];
}

function detailWith(outgoing: unknown[], incoming: unknown[]): EntityDetail {
  return {
    ...self,
    hierarchy: { ...self.hierarchy, parent: null, children: { ...self.hierarchy.children, items: [] } },
    connections: { outgoing, incoming, unresolvedHardDependencyCount: 0 },
  } as unknown as EntityDetail;
}

const alpha = peer('peer-alpha', 'Alpha');
const beta = peer('peer-beta', 'Beta');

describe('ConnectionsTab — grouped by entity, edge types per entity', () => {
  it('renders ONE row per peer even when that peer is reached by several edge types', () => {
    const detail = detailWith(
      [
        group('depends_on', 'depends on', 'outgoing', [{ id: 'e1', peer: alpha }]),
        group('relates_to', 'relates to', 'outgoing', [{ id: 'e2', peer: alpha }, { id: 'e3', peer: beta }]),
      ],
      [],
    );
    const { container, getAllByText } = render(<ConnectionsTab detail={detail} />);
    const rows = container.querySelectorAll('.pn-peers__row');
    expect(rows).toHaveLength(2);
    // Alpha appears once as an entity, not once per edge.
    expect(getAllByText('Alpha')).toHaveLength(1);

    const alphaRow = [...rows].find((r) => r.textContent?.includes('Alpha'))!;
    const rels = [...alphaRow.querySelectorAll('.pn-peers__rel')].map((n) => n.textContent);
    expect(rels).toHaveLength(2);
    expect(rels.some((t) => t?.includes('depends on'))).toBe(true);
    expect(rels.some((t) => t?.includes('relates to'))).toBe(true);
  });

  it('keeps DIRECTION distinct — the same type in and out is two relations, not one', () => {
    const detail = detailWith(
      [group('blocks', 'blocks', 'outgoing', [{ id: 'e1', peer: alpha }])],
      [group('blocks', 'blocks', 'incoming', [{ id: 'e2', peer: alpha }])],
    );
    const { container } = render(<ConnectionsTab detail={detail} />);
    expect(container.querySelectorAll('.pn-peers__row')).toHaveLength(1);
    const rels = [...container.querySelectorAll('.pn-peers__rel')].map((n) => n.textContent);
    expect(rels).toHaveLength(2);
    expect(rels.some((t) => t?.startsWith('→'))).toBe(true);
    expect(rels.some((t) => t?.startsWith('←'))).toBe(true);
  });

  it('counts repeats of one relation rather than repeating the peer', () => {
    const detail = detailWith(
      [
        group('relates_to', 'relates to', 'outgoing', [
          { id: 'e1', peer: alpha },
          { id: 'e2', peer: alpha },
        ]),
      ],
      [],
    );
    const { container } = render(<ConnectionsTab detail={detail} />);
    expect(container.querySelectorAll('.pn-peers__row')).toHaveLength(1);
    const rel = container.querySelector('.pn-peers__rel')!;
    expect(rel.textContent).toContain('· 2');
  });

  it('marks an unresolved HARD dependency on the relation AND the peer chip', () => {
    const detail = detailWith(
      [group('depends_on', 'depends on', 'outgoing', [{ id: 'e1', peer: alpha, hard: true, resolved: false }])],
      [],
    );
    const { container } = render(<ConnectionsTab detail={detail} />);
    const rel = container.querySelector('.pn-peers__rel--hard');
    expect(rel).toBeTruthy();
    expect(rel!.getAttribute('title')).toBe('unresolved hard dependency');
    const row = container.querySelector('.pn-peers__row')!;
    // Both the relation badge and the peer chip carry the reason: whichever
    // one the reader hovers, the answer to "why is this blocked" is there.
    expect(within(row as HTMLElement).getAllByTitle('unresolved hard dependency')).toHaveLength(2);
  });

  it('opens the PEER, not the edge, when the row chip is clicked', () => {
    const onOpenEntity = vi.fn();
    const detail = detailWith(
      [group('relates_to', 'relates to', 'outgoing', [{ id: 'e1', peer: beta }])],
      [],
    );
    const { getByText } = render(<ConnectionsTab detail={detail} onOpenEntity={onOpenEntity} />);
    fireEvent.click(getByText('Beta'));
    expect(onOpenEntity).toHaveBeenCalledWith('peer-beta');
  });

  it('still shows the empty state when there is nothing linked and no hierarchy', () => {
    const { container } = render(<ConnectionsTab detail={detailWith([], [])} />);
    expect(container.querySelectorAll('.pn-peers__row')).toHaveLength(0);
    expect(container.textContent).toContain('Nothing linked yet');
  });
});
