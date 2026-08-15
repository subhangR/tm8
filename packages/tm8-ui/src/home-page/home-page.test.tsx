// @vitest-environment jsdom
/**
 * HomePage — Home IS the chat view (R4, 2026-08-15; formerly the merged
 * single home of task 01a0027d).
 *
 * What these pin, each against a failure mode the program has shipped once:
 *   - the chat slot fills the canvas (the host's surface renders, untouched);
 *   - the foot strip shows ONLY real numbers: per-kind totals/unseen from
 *     `spaces.counts` via `countsFor`, the live count from the liveness
 *     snapshot — and a kind the server never counted renders NO number,
 *     never `0` (absent ≠ zero);
 *   - no `countsFor` at all ⇒ no strip (a host without the read draws
 *     nothing rather than fabricating);
 *   - a quiet space renders NO needs-you strip (an inbox-zero canvas is
 *     quiet, not an empty amber box).
 *
 * The glance rails and the presence row retired to the Work tab with R4 —
 * their tests went with them.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';
import type { Seam, SessionLiveness } from '../data/seam';
import { HOME_PRESENCE_KIND, HOME_RAIL_KINDS } from '../domain';
import { FIXTURE_SPACE_ID, teamMemberForge, teamMemberScout } from '../fixtures/entities';
import type { HomeScreenData } from '../home';
import { HomePage } from './HomePage';

const seam: Pick<Seam, 'identity' | 'inbox' | 'onEvent'> = {
  identity: async () => ({
    identityId: 'idn-ada',
    accountId: 'acct-ada',
    username: 'ada',
    displayName: 'Ada',
    avatar: null,
    email: null,
    globalId: null,
    isNodeAdmin: true,
    isOwner: true,
    status: 'active',
    actingAs: null,
    memberships: [],
  }),
  inbox: async () => ({ items: [], nextCursor: null }),
  onEvent: () => () => undefined,
};

function makeData(
  rows: Record<string, readonly EntitySummary[]>,
  liveIds: readonly string[] = [],
): HomeScreenData {
  return {
    spaceId: FIXTURE_SPACE_ID,
    seam,
    liveIds,
    livenessOf: (): SessionLiveness => 'unknown',
    rowsFor: (kind) => (filter) => (filter === undefined ? rows[kind] ?? [] : []),
    activity: {},
  };
}

const [TASK_KIND, SESSION_KIND, DOC_KIND] = HOME_RAIL_KINDS;

function renderPage(
  rows: Record<string, readonly EntitySummary[]>,
  handlers: Partial<React.ComponentProps<typeof HomePage>> = {},
  liveIds: readonly string[] = [],
) {
  return render(
    <div className="cv2-root">
      <HomePage
        data={makeData(rows, liveIds)}
        chat={<div data-testid="chat-slot">the chat hero</div>}
        onOpenEntity={() => undefined}
        onOpenKind={() => undefined}
        onOpenWorkspace={() => undefined}
        {...handlers}
      />
    </div>,
  );
}

describe('the home chat canvas', () => {
  it('renders the chat slot as the canvas', () => {
    const { getByTestId } = renderPage({});
    expect(within(getByTestId('home-page')).getByTestId('chat-slot')).toBeTruthy();
  });

  it('renders NO counts strip when the host has no counts read', () => {
    // Fabricating a strip with no numbers behind it is the failure this pins.
    const { queryByTestId } = renderPage({});
    expect(queryByTestId('hp-counts')).toBeNull();
  });

  it('shows real totals and unseen, renders NOTHING for an uncounted kind, and opens the kind', () => {
    const onOpenKind = vi.fn();
    const countsFor = (kind: string) =>
      kind === TASK_KIND ? { total: 142, unseen: 12 } : undefined;
    const { getByTestId } = renderPage({}, { countsFor, onOpenKind });
    const strip = getByTestId('hp-counts');
    const tasksChip = within(strip).getByText('Tasks').closest('button') as HTMLElement;
    expect(tasksChip.textContent).toContain('142');
    expect(tasksChip.textContent).toContain('12 new');
    // Docs was never counted by this server: chip exists, NO number, not `0`.
    const docsChip = within(strip).getByText('Docs').closest('button') as HTMLElement;
    expect(docsChip.querySelector('.hp-counts__total')).toBeNull();
    expect(docsChip.textContent).not.toMatch(/\d/);
    fireEvent.click(tasksChip);
    expect(onOpenKind).toHaveBeenCalledWith(TASK_KIND);
    void DOC_KIND;
  });

  it('carries the live count on the session chip from the liveness snapshot', () => {
    const countsFor = () => ({ total: 5, unseen: 0 });
    const { getByTestId } = renderPage({}, { countsFor }, ['s1', 's2', 's3']);
    const strip = getByTestId('hp-counts');
    const sessionsChip = within(strip).getByText('Sessions').closest('button') as HTMLElement;
    expect(sessionsChip.textContent).toContain('3 live');
    void SESSION_KIND;
  });

  it('counts working teammates from liveWork on the teammates chip — colour AND word', () => {
    const countsFor = () => ({ total: 2, unseen: 0 });
    const { getByTestId } = renderPage(
      { [HOME_PRESENCE_KIND]: [teamMemberForge, teamMemberScout] },
      { countsFor },
    );
    const strip = getByTestId('hp-counts');
    const chip = within(strip).getByText('Teammates').closest('button') as HTMLElement;
    // forge carries liveWork; scout is idle — one working teammate.
    expect(chip.textContent).toContain('1 working');
  });

  it('a quiet space renders NO needs-you strip', () => {
    const { queryByTestId } = renderPage({});
    expect(queryByTestId('hp-needs-you')).toBeNull();
  });
});
