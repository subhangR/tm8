// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { EntityDetail, EntitySummary } from '@tm8/contract';
import { CONVERSATION_KIND } from '../../domain';
import { fixtureDetails } from '../../fixtures';
import { countConnections, countMessages } from '../EntityDetailPanel';
import { ConnectionsTab } from './tabs';

/**
 * The seam groups edges BY TYPE. This tab inverts that to group BY PEER
 * ENTITY — so the assertions here are about the inversion: one row per peer
 * however many edges it holds, every edge type visible on that row, and
 * direction preserved (an edge type read from the other end is a DIFFERENT
 * relation, not a duplicate).
 */

const self = Object.values(fixtureDetails).find((d) => d.deletedAt == null)!;

function peer(id: string, title: string, kind?: string): EntitySummary {
  return { ...(self as unknown as EntitySummary), id, title, ...(kind ? { kind } : {}) };
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
    // The VERB, not the seam's label: the group labels above are deliberately
    // lowercase ids, and neither may reach the row.
    expect(rels).toContain('Depends on');
    expect(rels).toContain('Related');
  });

  it('keeps DIRECTION distinct — the same type in and out is two relations, said in two verbs', () => {
    const detail = detailWith(
      [group('depends_on', 'depends_on', 'outgoing', [{ id: 'e1', peer: alpha }])],
      [group('depends_on', 'depends_on (incoming)', 'incoming', [{ id: 'e2', peer: alpha }])],
    );
    const { container } = render(<ConnectionsTab detail={detail} />);
    expect(container.querySelectorAll('.pn-peers__row')).toHaveLength(1);
    const rels = [...container.querySelectorAll('.pn-peers__rel')].map((n) => n.textContent);
    expect(rels).toEqual(['Depends on', 'Needed by']);
    // Direction is in the words — no arrow, no "(incoming)".
    expect(container.textContent).not.toContain('(incoming)');
    expect(container.textContent).not.toMatch(/[→←]/);
  });

  it('merges a two-way conversation into ONE relation when the verb row says they are one', () => {
    const detail = detailWith(
      [group('messaged', 'messaged', 'outgoing', [{ id: 'e1', peer: alpha }])],
      [group('messaged', 'messaged (incoming)', 'incoming', [{ id: 'e2', peer: alpha }])],
    );
    const { container } = render(<ConnectionsTab detail={detail} />);
    const rels = [...container.querySelectorAll('.pn-peers__rel')].map((n) => n.textContent);
    expect(rels).toEqual(['Talked with · 2']);
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
    //
    // Days are the VIEWER's local days, so the fixture has to split into two
    // days in every zone, not just UTC. The third row is a day after the first
    // two, and the first two are 21 minutes apart; they could only land on
    // different local dates in a zone whose midnight falls at 11:31–11:52Z,
    // an offset of about ±12:10 that no zone uses. (The old 21:31Z / 23:12Z /
    // 01:48Z fixture collapsed to one day east of UTC+02:29 or west of
    // UTC-01:48 — IST read all three as Aug 15 — so it failed on those dev
    // machines while passing in UTC CI.)
    const detail = detailWith(
      [timedGroup('tracks', 'tracks', 'outgoing', [
        { id: 'e1', peer: alpha, createdAt: '2026-08-14T11:31:40.000Z' },
        { id: 'e2', peer: beta, createdAt: '2026-08-14T11:52:09.000Z' },
        { id: 'e3', peer: gamma, createdAt: '2026-08-15T11:48:25.000Z' },
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

/**
 * MESSAGES ARE SUMMARISED, NOT LISTED. On the session this was reported from,
 * 16 of 28 rows were messages it posted or received — the Discussion tab's
 * content, listed a second time, one row each.
 */
describe('ConnectionsTab — messages as one summary row', () => {
  const msg = (id: string) => peer(id, `Status update ${id}`, CONVERSATION_KIND);

  function withMessages() {
    return detailWith(
      [group('relates_to', 'relates to', 'outgoing', [{ id: 'e0', peer: alpha }])],
      [
        timedGroup('authored_from', 'authored_from (incoming)', 'incoming', [
          { id: 'a1', peer: msg('m1'), createdAt: '2026-09-24T10:00:00.000Z' },
          { id: 'a2', peer: msg('m2'), createdAt: '2026-09-24T11:00:00.000Z' },
        ]),
        timedGroup('anchored_to', 'anchored_to (incoming)', 'incoming', [
          // m2 is both written here and anchored here: one message, counted once.
          { id: 'b2', peer: msg('m2'), createdAt: '2026-09-24T11:00:00.000Z' },
          { id: 'b3', peer: msg('m3'), createdAt: '2026-09-24T12:07:00.000Z' },
        ]),
      ],
    );
  }

  it('draws no row per message, and one summary with the counts', () => {
    const { container } = render(<ConnectionsTab detail={withMessages()} />);
    const rows = [...container.querySelectorAll('.pn-peers__row')];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Alpha');
    expect(container.textContent).toContain('LINKED · 1');
    const summary = container.querySelector('[data-testid="pn-convo"]')!;
    expect(summary.textContent).toContain('3 messages');
    expect(summary.textContent).toContain('2 sent from here');
    expect(summary.textContent).toContain('1 posted here');
  });

  it('opens the Discussion tab from the summary, and draws no button without a way to', () => {
    const onOpenDiscussion = vi.fn();
    const { getByText, unmount } = render(
      <ConnectionsTab detail={withMessages()} onOpenDiscussion={onOpenDiscussion} />,
    );
    fireEvent.click(getByText('Open Messages →'));
    expect(onOpenDiscussion).toHaveBeenCalledTimes(1);
    unmount();
    const { container } = render(<ConnectionsTab detail={withMessages()} />);
    expect(container.querySelector('.pn-convo__open')).toBeNull();
  });

  it('keeps a message that holds a REAL relation as a row', () => {
    const evidence = msg('m9');
    const detail = detailWith(
      [],
      [
        group('verifies', 'verifies (incoming)', 'incoming', [{ id: 'v1', peer: evidence }]),
        group('anchored_to', 'anchored_to (incoming)', 'incoming', [{ id: 'v2', peer: evidence }]),
      ],
    );
    const { container } = render(<ConnectionsTab detail={detail} />);
    const rows = container.querySelectorAll('.pn-peers__row');
    expect(rows).toHaveLength(1);
    // The row carries the relation that matters, not the traffic edge.
    expect([...rows[0]!.querySelectorAll('.pn-peers__rel')].map((n) => n.textContent)).toEqual(['Verified by']);
    expect(container.querySelector('[data-testid="pn-convo"]')!.textContent).toContain('1 message');
  });

  it('is not "Nothing linked yet" when the only edges are messages', () => {
    const detail = detailWith(
      [],
      [group('anchored_to', 'anchored_to (incoming)', 'incoming', [{ id: 'x1', peer: msg('m1') }])],
    );
    const { container } = render(<ConnectionsTab detail={detail} />);
    expect(container.textContent).not.toContain('Nothing linked yet');
    expect(container.querySelector('[data-testid="pn-convo"]')!.textContent).toBe('1 message · posted here');
  });

  it('leaves messages out of the tab-strip count, which counts what the tab lists', () => {
    // 1 relates_to + 4 message edges; the count is the one connection.
    expect(countConnections(withMessages())).toBe(1);
  });
});

describe('countMessages — the Messages tab number', () => {
  const counted = (messages: number) =>
    ({ ...detailWith([], []), counters: { ...self.counters, messages } }) as unknown as EntityDetail;

  it('is the server counter even when no message page has been loaded', () => {
    // The old number was `messages?.length`: undefined here, so no count drew.
    expect(countMessages(counted(12), undefined)).toBe(12);
  });

  it('is the counter, not the loaded page, when the thread is longer than a page', () => {
    expect(countMessages(counted(120), new Array(50).fill(null))).toBe(120);
  });

  it('takes the loaded length only while a local post is ahead of its counter event', () => {
    expect(countMessages(counted(3), new Array(4).fill(null))).toBe(4);
  });
});
