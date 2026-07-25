/**
 * Leaderboard — the ledger read plainly, plus the completion moment.
 *
 * Rank order, scores and the awards feed all come from the facade inside the
 * test, so the assertions track the seed's arithmetic instead of restating it.
 * The moment is driven the only honest way: by actually completing a task with
 * a point pool and watching the durable stream carry it in.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { LeaderboardScreen, breakdownsByTask } from '../../screens/leaderboard';
import type { MockFacade } from '../../mock';
import { createFacade, renderWith, resetStores, screenProps } from './helpers';

let facade: MockFacade;

beforeEach(() => { resetStores(); facade = createFacade(); });
afterEach(() => { cleanup(); resetStores(); });

const scoreRows = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('.cv2-ld__row'));

async function renderLeaderboard() {
  const harness = screenProps(facade);
  const view = renderWith(facade, <LeaderboardScreen {...harness.props} />);
  await screen.findByTestId('leaderboard-screen');
  await waitFor(() => expect(scoreRows().length).toBeGreaterThan(0));
  return { ...harness, view };
}

/** Grant a pool then complete the task — the seed's own award mechanism. */
async function awardFor(taskId: string, completerId: string, amount: number): Promise<void> {
  await act(async () => {
    await facade.grantPoints(taskId, { amount, reason: 'grant' });
    const detail = await facade.getEntity(taskId);
    await facade.completeTask(taskId, {
      expectedVersion: detail.version,
      completerIds: [completerId],
    });
  });
}

describe('Leaderboard screen', () => {
  it('ranks humans and agents on one ladder, in ledger order', async () => {
    await renderLeaderboard();
    const ledger = await facade.getLeaderboard(facade.ids.space);

    const rendered = scoreRows().map((row) => ({
      rank: row.dataset.rank,
      name: (row.querySelector('.cv2-ld__name') as HTMLElement).textContent,
      pts: (row.querySelector('.cv2-ld__pts') as HTMLElement).textContent,
      tag: (row.querySelector('.cv2-ld__tag') as HTMLElement).textContent,
    }));

    expect(rendered).toEqual(ledger.items.map((r) => ({
      rank: String(r.rank),
      name: r.actor.displayName,
      pts: `${r.score} pts`,
      tag: r.actor.isAgent ? 'agent' : 'human',
    })));
    // Both provenances are on the same ladder.
    expect(rendered.some((r) => r.tag === 'agent')).toBe(true);
    expect(rendered.some((r) => r.tag === 'human')).toBe(true);
  });

  it('sizes each bar against the leader', async () => {
    await renderLeaderboard();
    const ledger = await facade.getLeaderboard(facade.ids.space);
    const top = Math.max(...ledger.items.map((r) => r.score));

    const fills = scoreRows().map((row) =>
      (row.querySelector('.cv2-ld__barfill') as HTMLElement).style.width);
    expect(fills[0]).toBe(`${Math.round((ledger.items[0].score / top) * 100)}%`);
  });

  it('lists the seeded award ledger with its task references', async () => {
    await renderLeaderboard();
    const awards = await facade.getAwards(facade.ids.space);
    expect(awards.items.length).toBeGreaterThan(0);

    const feed = screen.getByLabelText('Recent awards');
    expect(within(feed).getAllByRole('listitem')).toHaveLength(awards.items.length);
    for (const award of awards.items) {
      expect(within(feed).getAllByText(`+${award.amount}`).length).toBeGreaterThan(0);
    }
  });

  it('rolls awards up per task', async () => {
    await renderLeaderboard();
    const awards = await facade.getAwards(facade.ids.space);
    const expected = breakdownsByTask(awards.items);

    const section = screen.getByLabelText('Per-task breakdowns');
    for (const b of expected) {
      const block = section.querySelector(`[data-task="${b.taskId}"]`) as HTMLElement;
      expect(block).toBeTruthy();
      expect(within(block).getByText(`${b.total} pts`)).toBeTruthy();
    }
  });

  it('celebrates a completion award that lands while you watch — and not the history', async () => {
    await renderLeaderboard();
    // The seeded ledger is history: nothing celebrates on mount.
    expect(screen.queryByTestId('completion-moment')).toBeNull();

    await awardFor(facade.ids.t106, facade.ids.scout, 7);

    const moment = await screen.findByTestId('completion-moment');
    expect(moment.textContent).toContain('Scout');
    expect(moment.textContent).toContain('7 points');

    // The recipient's score row is lit for the beat.
    await waitFor(() => {
      expect(document.querySelector('.cv2-ld__row[data-celebrating]')).toBeTruthy();
    });
  });

  it('folds the new award into the ladder and the feed', async () => {
    await renderLeaderboard();
    const before = await facade.getAwards(facade.ids.space);

    await awardFor(facade.ids.t106, facade.ids.scout, 7);

    await waitFor(() => {
      const feed = screen.getByLabelText('Recent awards');
      expect(within(feed).getAllByRole('listitem')).toHaveLength(before.items.length + 1);
    });
    const after = await facade.getLeaderboard(facade.ids.space);
    const scout = after.items.find((r) => r.actor.id === facade.ids.scout);
    await waitFor(() => {
      const row = scoreRows().find((r) =>
        (r.querySelector('.cv2-ld__name') as HTMLElement).textContent === 'Scout');
      expect((row?.querySelector('.cv2-ld__pts') as HTMLElement).textContent)
        .toBe(`${scout?.score} pts`);
    });
  });
});
