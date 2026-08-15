// @vitest-environment jsdom
/**
 * HomePage — the merged single home (task 01a0027d).
 *
 * What these pin, each against a failure mode the program has shipped once:
 *   - the chat slot IS the hero (the host's surface renders, untouched);
 *   - rails come from `HOME_RAIL_KINDS` via `rowsFor(kind)(undefined)`,
 *     newest activity first, capped — and an empty rail SAYS SO rather than
 *     rendering a silent void;
 *   - the rail header opens the full collection, a card opens its entity —
 *     the glance is never a dead end;
 *   - the presence row reads `state.liveWork` structurally and the working
 *     dot is colour + word, never colour alone (C8/L10);
 *   - a quiet space renders NO needs-you strip (an inbox-zero canvas is
 *     quiet, not an empty amber box).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';
import type { Seam, SessionLiveness } from '../data/seam';
import { HOME_PRESENCE_KIND, HOME_RAIL_KINDS } from '../domain';
import {
  FIXTURE_SPACE_ID,
  docLayoutSpec,
  sessionLive,
  taskGuideLines,
  taskUuidTitle,
  teamMemberForge,
  teamMemberScout,
} from '../fixtures/entities';
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

function makeData(rows: Record<string, readonly EntitySummary[]>): HomeScreenData {
  return {
    spaceId: FIXTURE_SPACE_ID,
    seam,
    liveIds: [],
    livenessOf: (): SessionLiveness => 'unknown',
    rowsFor: (kind) => (filter) => (filter === undefined ? rows[kind] ?? [] : []),
    activity: {},
  };
}

const [TASK_KIND, SESSION_KIND, DOC_KIND] = HOME_RAIL_KINDS;

function renderPage(
  rows: Record<string, readonly EntitySummary[]>,
  handlers: Partial<React.ComponentProps<typeof HomePage>> = {},
) {
  return render(
    <div className="cv2-root">
      <HomePage
        data={makeData(rows)}
        chat={<div data-testid="chat-slot">the chat hero</div>}
        onOpenEntity={() => undefined}
        onOpenKind={() => undefined}
        onOpenWorkspace={() => undefined}
        {...handlers}
      />
    </div>,
  );
}

describe('the merged home canvas', () => {
  it('renders the chat slot as the hero', () => {
    const { getByTestId } = renderPage({});
    expect(within(getByTestId('home-page')).getByTestId('chat-slot')).toBeTruthy();
  });

  it('rails render cards newest-activity-first and open their entity', () => {
    const onOpenEntity = vi.fn();
    // Distinct timestamps, input ordered OLDEST-first, to prove the rail
    // re-sorts by activity rather than echoing the query order.
    const older = { ...taskUuidTitle, activityAt: '2026-07-27T08:00:00.000Z' };
    const { container } = renderPage(
      { [TASK_KIND!]: [older, taskGuideLines] },
      { onOpenEntity },
    );
    const rail = container.querySelector(`[aria-label="Tasks"]`) as HTMLElement;
    expect(rail).toBeTruthy();
    const cards = [...rail.querySelectorAll('.hp-card')];
    expect(cards.length).toBe(2);
    expect(cards.map((c) => c.querySelector('.hp-card__title')?.textContent)).toEqual([
      taskGuideLines.title,
      older.title,
    ]);
    fireEvent.click(cards[0] as HTMLElement);
    expect(onOpenEntity).toHaveBeenCalledWith(taskGuideLines.id);
  });

  it('an empty rail says so — never a silent void', () => {
    const { container } = renderPage({ [SESSION_KIND!]: [sessionLive] });
    const docs = container.querySelector(`[data-testid="hp-rail-docs"]`) as HTMLElement;
    expect(docs?.textContent?.toLowerCase()).toContain('no docs yet');
    // The populated rail renders cards, not the note.
    const sessions = container.querySelector(`[aria-label="Sessions"]`) as HTMLElement;
    expect(sessions.querySelectorAll('.hp-card')).toHaveLength(1);
  });

  it('the rail header opens the full collection for its kind', () => {
    const onOpenKind = vi.fn();
    const { container } = renderPage({}, { onOpenKind });
    const docs = container.querySelector(`[data-testid="hp-rail-docs"]`) as HTMLElement;
    fireEvent.click(within(docs).getByRole('button'));
    expect(onOpenKind).toHaveBeenCalledWith(DOC_KIND);
  });

  it('caps a rail at its glance size', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      ...docLayoutSpec,
      id: `doc-${i}`,
      title: `Doc ${i}`,
    })) as EntitySummary[];
    const { container } = renderPage({ [DOC_KIND!]: many });
    const docs = container.querySelector(`[aria-label="Docs"]`) as HTMLElement;
    expect(docs.querySelectorAll('.hp-card')).toHaveLength(6);
  });

  it('the presence row marks working teammates with colour AND word (C8/L10)', () => {
    const onOpenEntity = vi.fn();
    const { getByTestId } = renderPage(
      { [HOME_PRESENCE_KIND]: [teamMemberForge, teamMemberScout] },
      { onOpenEntity },
    );
    const presence = getByTestId('hp-presence');
    const forgeRow = within(presence).getByText('forge').closest('button') as HTMLElement;
    // forge carries liveWork: dot filled AND the word rides along.
    expect(forgeRow.querySelector('.hp-presence__dot--working')).toBeTruthy();
    expect(forgeRow.textContent).toContain('working');
    // scout is idle: ring, no word.
    const scoutRow = within(presence).getByText('scout').closest('button') as HTMLElement;
    expect(scoutRow.querySelector('.hp-presence__dot--working')).toBeNull();
    expect(scoutRow.textContent).not.toContain('working');
    fireEvent.click(forgeRow);
    expect(onOpenEntity).toHaveBeenCalledWith(teamMemberForge.id);
  });

  it('a quiet space renders NO needs-you strip and the workspace escape hatch', () => {
    const onOpenWorkspace = vi.fn();
    const { queryByTestId, getByText } = renderPage({}, { onOpenWorkspace });
    expect(queryByTestId('hp-needs-you')).toBeNull();
    fireEvent.click(getByText('Open full workspace ⌗'));
    expect(onOpenWorkspace).toHaveBeenCalled();
  });
});
