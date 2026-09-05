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

/**
 * WHEN — the half this tab discarded. `EdgeView` has carried `createdAt` and
 * `updatedAt` since it was written and the tab dropped both, so a page of links
 * could not be read as a history: a PR linked a minute ago sat below one linked
 * in March, and nothing on the row said which was which. The order is now
 * chronological and the row carries its instant, which is the same order and
 * the same treatment the Activity tab gives the very events that made them.
 */
function timedGroup(
  type: string,
  label: string,
  direction: 'outgoing' | 'incoming',
  edges: { id: string; peer: EntitySummary; createdAt: string; updatedAt?: string }[],
) {
  return {
    type,
    label,
    direction,
    edges: edges.map((e) => ({
      id: e.id,
      type,
      props: {},
      createdBy: self.createdBy,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt ?? e.createdAt,
      ...(direction === 'outgoing'
        ? { source: self as unknown as EntitySummary, target: e.peer }
        : { source: e.peer, target: self as unknown as EntitySummary }),
    })),
  } as unknown as EntityDetail['connections']['outgoing'][number];
}

const gamma = peer('peer-gamma', 'Gamma');

describe('ConnectionsTab — read as a timeline', () => {
  it('orders peers newest-linked first, not in the order the seam grouped them', () => {
    const detail = detailWith(
      [
        // The seam's grouping puts the OLDEST first here — the tab must not.
        timedGroup('relates_to', 'relates to', 'outgoing', [
          { id: 'e1', peer: alpha, createdAt: '2026-03-01T09:00:00.000Z' },
          { id: 'e2', peer: gamma, createdAt: '2026-08-14T23:12:09.790Z' },
        ]),
        timedGroup('tracks', 'tracks', 'outgoing', [
          { id: 'e3', peer: beta, createdAt: '2026-08-14T21:31:40.854Z' },
        ]),
      ],
      [],
    );
    const { container } = render(<ConnectionsTab detail={detail} />);
    const titles = [...container.querySelectorAll('.pn-peers__row')]
      .map((r) => r.querySelector('.kit-chip')?.textContent);
    expect(titles).toEqual(['Gamma', 'Beta', 'Alpha']);
  });

  it('stamps each row with its newest edge, machine-readable and exact on inspect', () => {
    const detail = detailWith(
      [timedGroup('tracks', 'tracks', 'outgoing', [
        { id: 'e1', peer: alpha, createdAt: '2026-08-14T21:31:40.854Z' },
      ])],
      [],
    );
    const { container } = render(<ConnectionsTab detail={detail} />);
    const stamp = container.querySelector('time.pn-peers__when')!;
    expect(stamp.getAttribute('datetime')).toBe('2026-08-14T21:31:40.854Z');
    expect(stamp.getAttribute('title')).toContain('linked');
    // The CLOCK is the visible label — the day is on the divider above it.
    expect(stamp.textContent).toMatch(/^\d{2}:\d{2}$/);
    // The full local date AND time, never the date alone, on inspect.
    expect(stamp.getAttribute('title')).toMatch(/\d{1,2}:\d{2}/);
    expect(stamp.getAttribute('aria-label')).toMatch(/\d{1,2}:\d{2}/);
  });

  it('says the DAY once over the run it covers, and gives each row its clock', () => {
    // The defect this closes: past the 7-day relative window every row printed
    // the same bare date, so four links made minutes apart read as one moment.
    const detail = detailWith(
      [timedGroup('tracks', 'tracks', 'outgoing', [
        { id: 'e1', peer: alpha, createdAt: '2026-08-14T21:31:40.000Z' },
        { id: 'e2', peer: beta, createdAt: '2026-08-14T23:12:09.000Z' },
        { id: 'e3', peer: gamma, createdAt: '2026-08-15T01:48:25.000Z' },
      ])],
      [],
    );
    const { container } = render(<ConnectionsTab detail={detail} />);
    // Two days across three rows ⇒ two dividers, not three and not one.
    const days = [...container.querySelectorAll('[data-testid="pn-peers-day"]')];
    expect(days).toHaveLength(2);
    // Every row still carries its own minute.
    const clocks = [...container.querySelectorAll('time.pn-peers__when')].map((n) => n.textContent);
    expect(new Set(clocks).size).toBe(3);
  });

  it('gives an UNDATED peer no divider and no stamp, and does not let it break the run', () => {
    const detail = detailWith(
      [
        timedGroup('tracks', 'tracks', 'outgoing', [
          { id: 'e1', peer: alpha, createdAt: '2026-08-14T21:31:40.000Z' },
          { id: 'e2', peer: beta, createdAt: '2026-08-14T23:12:09.000Z' },
        ]),
        // No createdAt at all — `group()`, not `timedGroup()`.
        group('relates_to', 'relates to', 'outgoing', [{ id: 'e3', peer: gamma }]),
      ],
      [],
    );
    const { container } = render(<ConnectionsTab detail={detail} />);
    // ONE divider for the one day present: the undated row neither opens a run
    // nor closes one, because it is not evidence that the day changed.
    expect(container.querySelectorAll('[data-testid="pn-peers-day"]')).toHaveLength(1);
    expect(container.querySelectorAll('.pn-peers__row')).toHaveLength(3);
    expect(container.querySelectorAll('time.pn-peers__when')).toHaveLength(2);
    // ...and it sorts LAST rather than to the top: absent evidence is never "now".
    const rows = [...container.querySelectorAll('.pn-peers__row')];
    expect(rows.at(-1)!.textContent).toContain('Gamma');
  });

  it('says "linked, then updated" only when the edge was actually re-written', () => {
    const detail = detailWith(
      [timedGroup('tracks', 'tracks', 'outgoing', [
        { id: 'e1', peer: alpha, createdAt: '2026-08-14T21:31:40.854Z', updatedAt: '2026-08-15T07:52:31.507Z' },
      ])],
      [timedGroup('relates_to', 'relates to', 'incoming', [
        { id: 'e2', peer: beta, createdAt: '2026-08-14T21:31:40.854Z' },
      ])],
    );
    const { container } = render(<ConnectionsTab detail={detail} />);
    const rows = [...container.querySelectorAll('.pn-peers__row')];
    const alphaRow = rows.find((r) => r.textContent?.includes('Alpha'))!;
    const betaRow = rows.find((r) => r.textContent?.includes('Beta'))!;
    expect(alphaRow.querySelector('time')!.getAttribute('title')).toContain('linked, then updated');
    // Two identical instants are ONE fact — reporting an update would invent
    // a second event that never happened.
    expect(betaRow.querySelector('time')!.getAttribute('title')).not.toContain('then updated');
    // The re-written edge is also the newer one, so it sorts first.
    expect(rows[0]).toBe(alphaRow);
  });

  it('renders NO stamp for an edge the seam gave no usable instant', () => {
    // `group()` (above) builds edges with no createdAt at all — the shape a
    // narrow host or an older cache can still produce. An undated edge must
    // render undated, never as "now".
    const detail = detailWith(
      [group('relates_to', 'relates to', 'outgoing', [{ id: 'e1', peer: alpha }])],
      [],
    );
    const { container } = render(<ConnectionsTab detail={detail} />);
    expect(container.querySelectorAll('.pn-peers__row')).toHaveLength(1);
    expect(container.querySelector('.pn-peers__when')).toBeNull();
  });

  it('dates a repeated relation from when it FIRST existed, and stamps its latest change', () => {
    const detail = detailWith(
      [timedGroup('relates_to', 'relates to', 'outgoing', [
        { id: 'e1', peer: alpha, createdAt: '2026-03-01T09:00:00.000Z' },
        { id: 'e2', peer: alpha, createdAt: '2026-08-14T23:12:09.790Z' },
      ])],
      [],
    );
    const { container } = render(<ConnectionsTab detail={detail} />);
    // One peer, one relation counted twice — the existing inversion is intact.
    expect(container.querySelectorAll('.pn-peers__row')).toHaveLength(1);
    expect(container.querySelector('.pn-peers__rel')!.textContent).toContain('· 2');
    // The row's stamp is the NEWEST of the two, so the sort key and the label
    // are the same instant.
    expect(container.querySelector('time.pn-peers__when')!.getAttribute('datetime'))
      .toBe('2026-08-14T23:12:09.790Z');
    // ...and the relation's hover reports both halves.
    expect(container.querySelector('.pn-peers__rel')!.getAttribute('title'))
      .toContain('linked, then updated');
  });
});
