/**
 * ReactionsPointsBar against the seeded world: optimistic like/dislike
 * exclusivity + reconcile, independent star, rollback on a rejected command,
 * points tap/hold/hover — and the same component, unchanged, on a message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ReactionsPointsBar } from '../../subsystems/reactions';
import { CollabError } from '../../types/contract';
import type { EntityDetail } from '../../types/contract';
import type { MockFacade } from '../../mock';
import { useGraphStore } from '../../stores';
import { createFacade, renderWith, resetStores } from './helpers';

/** Pending optimistic mutations — 0 means everything reconciled. */
const pendingMutations = (): number => Object.keys(useGraphStore.getState().optimistic).length;

let facade: MockFacade;

beforeEach(() => {
  resetStores();
  facade = createFacade();
});

const likeBtn = (): HTMLElement => screen.getByRole('button', { name: 'Like' });
const dislikeBtn = (): HTMLElement => screen.getByRole('button', { name: 'Dislike' });
const starBtn = (): HTMLElement => screen.getByRole('button', { name: 'Star' });
const pointsBtn = (): HTMLElement => screen.getByRole('button', { name: 'Grant a point' });
const countOf = (btn: HTMLElement): number => Number(btn.querySelector('.cv2-actioncount')?.textContent);

async function taskDetail(): Promise<EntityDetail> {
  return facade.getEntity(facade.ids.t103);
}

describe('reactions', () => {
  it('flips optimistically on click, then reconciles with the server', async () => {
    const detail = await taskDetail();
    const spy = vi.spyOn(facade, 'setReaction');
    renderWith(facade, <ReactionsPointsBar entityId={detail.id} entity={detail} />);

    const before = detail.counters.likes;
    fireEvent.click(likeBtn());

    // optimistic: the count moved before the command resolved
    expect(countOf(likeBtn())).toBe(before + 1);
    expect(likeBtn().getAttribute('aria-pressed')).toBe('true');
    expect(spy).toHaveBeenCalledWith(detail.id, expect.objectContaining({
      reaction: 'like', enabled: true, clientMutationId: expect.any(String),
    }));

    // reconciled: the server agrees, the optimistic journal is drained
    await waitFor(() => expect(pendingMutations()).toBe(0));
    expect(countOf(likeBtn())).toBe(before + 1);
    expect(likeBtn().getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps like and dislike mutually exclusive', async () => {
    const detail = await taskDetail();
    renderWith(facade, <ReactionsPointsBar entityId={detail.id} entity={detail} />);
    const likes = detail.counters.likes;
    const dislikes = detail.counters.dislikes;

    fireEvent.click(likeBtn());
    await waitFor(() => expect(pendingMutations()).toBe(0));
    fireEvent.click(dislikeBtn());

    expect(countOf(likeBtn())).toBe(likes);
    expect(countOf(dislikeBtn())).toBe(dislikes + 1);
    expect(likeBtn().getAttribute('aria-pressed')).toBe('false');
    expect(dislikeBtn().getAttribute('aria-pressed')).toBe('true');

    await waitFor(() => expect(pendingMutations()).toBe(0));
    const fresh = await facade.getEntity(detail.id);
    expect(fresh.counters.likes).toBe(likes);
    expect(fresh.counters.dislikes).toBe(dislikes + 1);
    expect(fresh.counters.viewerReaction).toBe('dislike');
  });

  it('stars independently of like', async () => {
    const detail = await taskDetail();
    renderWith(facade, <ReactionsPointsBar entityId={detail.id} entity={detail} />);
    const stars = detail.counters.stars;

    fireEvent.click(likeBtn());
    await waitFor(() => expect(pendingMutations()).toBe(0));
    fireEvent.click(starBtn());
    await waitFor(() => expect(pendingMutations()).toBe(0));

    expect(countOf(starBtn())).toBe(stars + 1);
    expect(starBtn().getAttribute('aria-pressed')).toBe('true');
    expect(likeBtn().getAttribute('aria-pressed')).toBe('true'); // both, at once
  });

  it('rolls back and surfaces the error code when the command is rejected', async () => {
    const detail = await taskDetail();
    facade.failNextWith(new CollabError('forbidden', 'not your space'));
    renderWith(facade, <ReactionsPointsBar entityId={detail.id} entity={detail} />);
    const before = detail.counters.likes;

    fireEvent.click(likeBtn());
    expect(countOf(likeBtn())).toBe(before + 1);

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('forbidden'));
    expect(countOf(likeBtn())).toBe(before);
    expect(likeBtn().getAttribute('aria-pressed')).toBe('false');
  });

  it('respects capabilities', async () => {
    const detail = await taskDetail();
    renderWith(facade, (
      <ReactionsPointsBar
        entityId={detail.id}
        entity={detail}
        capabilities={{ canReact: false, canGrantPoints: false }}
      />
    ));
    expect((likeBtn() as HTMLButtonElement).disabled).toBe(true);
    expect((pointsBtn() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('points control', () => {
  it('tap grants exactly one point, optimistically', async () => {
    const detail = await taskDetail();
    const spy = vi.spyOn(facade, 'grantPoints');
    renderWith(facade, <ReactionsPointsBar entityId={detail.id} entity={detail} />);
    const pool = detail.counters.points;

    fireEvent.click(pointsBtn());
    expect(countOf(pointsBtn())).toBe(pool + 1);
    expect(spy).toHaveBeenCalledWith(detail.id, expect.objectContaining({
      amount: 1, reason: 'grant', clientMutationId: expect.any(String),
    }));

    await waitFor(() => expect(pendingMutations()).toBe(0));
    expect((await facade.getEntity(detail.id)).counters.points).toBe(pool + 1);
  });

  it('hold opens the amount picker and suppresses the +1 tap', async () => {
    const detail = await taskDetail();
    const spy = vi.spyOn(facade, 'grantPoints');
    renderWith(facade, <ReactionsPointsBar entityId={detail.id} entity={detail} holdMs={5} />);
    const pool = detail.counters.points;

    fireEvent.pointerDown(pointsBtn());
    const menu = await screen.findByRole('menu', { name: 'Point amount' });
    fireEvent.pointerUp(pointsBtn());
    fireEvent.click(pointsBtn()); // the click that follows a hold must not grant
    expect(spy).not.toHaveBeenCalled();

    fireEvent.click(within(menu).getByRole('menuitem', { name: '+5' }));
    expect(spy).toHaveBeenCalledWith(detail.id, expect.objectContaining({ amount: 5 }));
    expect(countOf(pointsBtn())).toBe(pool + 5);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('offers a custom amount and a keyboard path to the picker', async () => {
    const detail = await taskDetail();
    const spy = vi.spyOn(facade, 'grantPoints');
    renderWith(facade, <ReactionsPointsBar entityId={detail.id} entity={detail} />);

    fireEvent.keyDown(pointsBtn(), { key: 'ArrowDown' });
    const menu = await screen.findByRole('menu', { name: 'Point amount' });
    fireEvent.change(within(menu).getByLabelText('Custom point amount'), { target: { value: '13' } });
    fireEvent.click(within(menu).getByRole('button', { name: 'Grant' }));

    expect(spy).toHaveBeenCalledWith(detail.id, expect.objectContaining({ amount: 13 }));
  });

  it('hover shows the pool and its top granters', async () => {
    // T-104 carries the seeded 20-point bounty from Subhang.
    const detail = await facade.getEntity(facade.ids.t104);
    renderWith(facade, (
      <ReactionsPointsBar entityId={detail.id} entity={detail} popoverDelayMs={0} />
    ));

    fireEvent.mouseEnter(pointsBtn());
    const pool = await screen.findByText('Points pool');
    const card = pool.closest('.cv2-points__pool') as HTMLElement;
    expect(within(card).getByText(String(detail.counters.points))).toBeTruthy();
    await waitFor(() => expect(within(card).getByText(/^\+\d+$/)).toBeTruthy());
  });
});

describe('universality', () => {
  it('renders the identical bar on a message', async () => {
    const message = await facade.getEntity(facade.ids.forgeProgressMessage);
    const spy = vi.spyOn(facade, 'setReaction');
    renderWith(facade, (
      <ReactionsPointsBar entityId={message.id} entity={message} size="sm" hideZeroCounts />
    ));

    expect(likeBtn()).toBeTruthy();
    expect(dislikeBtn()).toBeTruthy();
    expect(starBtn()).toBeTruthy();
    expect(pointsBtn()).toBeTruthy();

    fireEvent.click(likeBtn());
    expect(spy).toHaveBeenCalledWith(message.id, expect.objectContaining({ reaction: 'like', enabled: true }));
    await waitFor(() => expect(pendingMutations()).toBe(0));
    expect((await facade.getEntity(message.id)).counters.likes).toBe(message.counters.likes + 1);
  });
});
