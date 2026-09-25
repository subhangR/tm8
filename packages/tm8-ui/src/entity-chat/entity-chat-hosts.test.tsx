// @vitest-environment jsdom
/**
 * Entity chat, lane E (design 01a0da4e §3.1): the slot on WORK replaces the
 * centre panel stack, and on a PHONE it is a full-screen sheet.
 *
 * Driven through the real hosts — `GateApp` booted onto the workspace over the
 * fixture seam, and `MobileShell` over the same seam — against the real store.
 * The chat body is `ChatHomeSurface` stubbed to report the two props that
 * decide WHICH conversation it shows, so "the slot opened on `new` shows the
 * composer, not the space's newest chat" is asserted on what the host handed
 * the surface rather than on a copy of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { EntityId, SpaceId } from '@tm8/contract';
import { GateApp } from '../views/GateApp';
import { MobileShell } from '../views/MobileShell';
import { useGateData, type GateData } from '../views/useGateData';
import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import { navStore, resetNav, routeOf } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { getKind } from '../domain';
import { panelMenuItems } from '../panels/detail/chrome';
import type { DetailReasons } from '../panels';

vi.mock('../chat-home/ChatHomeSurface', () => ({
  ChatHomeSurface: (props: { routeThreadId: string | null; coldStart?: string; aboutId?: string }) => (
    <div
      data-testid="stub-chat-surface"
      data-route-thread={props.routeThreadId ?? ''}
      data-about={props.aboutId ?? ''}
    >
      {/* What the real screen does with these two props: with no thread and
          `coldStart: 'composer'` it is the empty composer; with no thread and
          any other cold start it adopts the SPACE's most recent chat. */}
      {props.routeThreadId
        ? `thread ${props.routeThreadId}`
        : props.coldStart === 'composer'
          ? 'composer'
          : 'auto-opened newest chat'}
    </div>
  ),
}));

const SLOW_GATE_MS = 30_000;

const REASONS: DetailReasons = {
  presenceHollow: 'Presence isn’t measured yet.',
  versionHistory: 'Version history isn’t available yet.',
  provenanceHollow: 'Authorship provenance isn’t available yet.',
  shareUnavailable: 'Sharing into a session isn’t available yet.',
  withdrawUnavailable: 'Withdrawing a handoff isn’t available yet.',
};

beforeEach(() => {
  resetNav();
  screenStackStore.getState().clearAll();
  window.localStorage.clear();
  window.location.hash = '';
});
afterEach(cleanup);

function bootWork() {
  window.localStorage.setItem(
    'tm8.last-place.v1.local',
    JSON.stringify({ spaceId: 'sp-atelier', targets: { 'sp-atelier': { type: 'view', ref: 'workspace' } } }),
  );
  return render(<GateApp />);
}

/** Open the first row of the left list into Work's centre, as a click does. */
async function openFirstRow(view: ReturnType<typeof render>): Promise<EntityId> {
  const grid = await waitFor(() => view.getByTestId('workspace-grid'));
  const tile = await waitFor(() => within(grid).getAllByTestId('list-tile')[0] as HTMLElement);
  fireEvent.click(tile.querySelector('.pn-tt__title') as HTMLElement);
  await waitFor(() => expect(view.getByTestId('entity-detail-panel')).toBeTruthy());
  return navStore.getState().stack.at(-1) as EntityId;
}

describe('Work: the chat replaces the centre panel stack (§3.1, Q5)', () => {
  it('replaces the stack while set, keeps the stack in the route, and the dock stands aside', async () => {
    const view = bootWork();
    const id = await openFirstRow(view);

    act(() => navStore.getState().openChat({ about: id, thread: 'new' }));

    const centre = await waitFor(() => view.getByTestId('workspace-chat-centre'));
    expect(within(centre).getByTestId('entity-chat-panel')).toBeTruthy();
    /* REPLACES, not joins: the entity is not on screen beside the chat… */
    expect(view.queryByTestId('entity-detail-panel')).toBeNull();
    /* …but it is still in the route underneath. */
    expect(routeOf(navStore.getState()).panels.stack).toEqual([id]);
    /* One host only: the interim dock does not draw a second copy. */
    expect(view.queryByTestId('entity-chat-dock')).toBeNull();
    /* The side lists stay — only the centre is the chat's. */
    expect(within(view.getByTestId('workspace-grid')).getAllByTestId('entity-list-panel').length).toBe(2);
  }, SLOW_GATE_MS);

  it('a slot opened on `new` shows the composer, not the space’s newest chat', async () => {
    const view = bootWork();
    const id = await openFirstRow(view);

    act(() => navStore.getState().openChat({ about: id, thread: 'new' }));

    /* Lane C's gate reaches this host with no prop: the fixture space has no
       chat default, so the settings card comes first (§3.4). */
    fireEvent.click(await view.findByTestId('new-chat-start'));
    const body = await view.findByTestId('stub-chat-surface');
    expect(body.textContent).toBe('composer');
    expect(body.getAttribute('data-about')).toBe(id);
  }, SLOW_GATE_MS);

  it('Back closes the chat and shows the entity again', async () => {
    const view = bootWork();
    const id = await openFirstRow(view);
    const before = routeOf(navStore.getState());

    act(() => navStore.getState().openChat({ about: id, thread: 'new' }));
    await waitFor(() => view.getByTestId('workspace-chat-centre'));
    /* The switcher moving `new` → a created id REPLACES, so one Back still
       reaches the entity. */
    act(() => navStore.getState().setChatThread('01a0-created' as EntityId));
    expect(navStore.getState().history).toBe('replace');

    /* Back is the router re-hydrating the previous entry's address. */
    act(() => navStore.getState().hydrate(before));

    await waitFor(() => expect(view.getByTestId('entity-detail-panel')).toBeTruthy());
    expect(view.queryByTestId('workspace-chat-centre')).toBeNull();
    expect(navStore.getState().stack).toEqual([id]);
  }, SLOW_GATE_MS);

  it('the ✕ closes it the same way', async () => {
    const view = bootWork();
    const id = await openFirstRow(view);
    act(() => navStore.getState().openChat({ about: id, thread: 'new' }));
    fireEvent.click(await waitFor(() => view.getByTestId('entity-chat-close')));
    await waitFor(() => expect(view.getByTestId('entity-detail-panel')).toBeTruthy());
    expect(navStore.getState().chat).toBeNull();
  }, SLOW_GATE_MS);

  it('opening an entity into the centre CLEARS the slot — in one history entry', async () => {
    const view = bootWork();
    const id = await openFirstRow(view);
    act(() => navStore.getState().openChat({ about: id, thread: 'new' }));
    await waitFor(() => view.getByTestId('workspace-chat-centre'));

    /* Any other row — the right list's first is a different entity. */
    const tiles = view.getAllByTestId('list-tile');
    const other = tiles.at(-1) as HTMLElement;
    const revision = navStore.getState().revision;
    fireEvent.click(other.querySelector('.pn-tt__title') ?? other);

    await waitFor(() => expect(view.getByTestId('entity-detail-panel')).toBeTruthy());
    expect(view.queryByTestId('workspace-chat-centre')).toBeNull();
    expect(navStore.getState().chat).toBeNull();
    expect(navStore.getState().revision).toBe(revision + 1);
    expect(navStore.getState().history).toBe('push');
  }, SLOW_GATE_MS);
});

describe('the Work arm of Pinned is scoped to Work (§3.1, Q4)', () => {
  const A = '01a0-a' as EntityId;
  const B = '01a0-b' as EntityId;

  it('push on Work clears the slot; on Home it survives', () => {
    const nav = () => navStore.getState();
    nav().navigate({ view: 'workspace' });
    nav().openChat({ about: A, thread: 'new' });
    nav().push(B);
    expect(nav().chat).toBeNull();
    expect(nav().stack).toEqual([B]);

    nav().navigate({ view: 'home' });
    nav().openChat({ about: A, thread: 'new' });
    nav().push(B);
    expect(nav().chat).toEqual({ about: A, thread: 'new' });
  });

  it('raising an already-pinned entity on Work clears it too', () => {
    const nav = () => navStore.getState();
    nav().navigate({ view: 'workspace' });
    nav().push(A);
    nav().pin(A);
    nav().openChat({ about: A, thread: 'new' });
    nav().push(A);
    expect(nav().chat).toBeNull();
  });
});

describe('Phone: the slot is a full-screen sheet (§3.1)', () => {
  function PhoneHost() {
    const data = useGateData({ leftKind: 'task', rightKind: 'work_session', seam: createFixtureSeam() });
    return (
      <MobileShell
        data={data as GateData & { pull?: (id: string) => void }}
        spaceId={(data.spaceId ?? 'sp-atelier') as SpaceId}
        activeTarget={{ type: 'kind', ref: 'task' }}
        navigateTo={() => {}}
        openEntity={null}
        reasons={REASONS}
        onNotice={() => {}}
        nodeKey="local"
      />
    );
  }

  it('opens over the whole frame on `new` with the composer, and Close removes it', async () => {
    const view = render(<PhoneHost />);
    await waitFor(() => expect(view.getAllByTestId('list-tile').length).toBeGreaterThan(0));
    expect(view.queryByTestId('entity-chat-phone-sheet')).toBeNull();

    act(() => navStore.getState().openChat({ about: '01a0-task' as EntityId, thread: 'new' }));

    const sheet = await waitFor(() => view.getByTestId('entity-chat-phone-sheet'));
    /* In the FRAME's sheet region — the layer that covers header and screen. */
    expect(sheet.closest('.mobile-frame__sheet')).not.toBeNull();
    expect(sheet.getAttribute('role')).toBe('dialog');
    /* The settings card (§3.4) is in the sheet first; Start chat hands over. */
    fireEvent.click(await within(sheet).findByTestId('new-chat-start'));
    expect((await within(sheet).findByTestId('stub-chat-surface')).textContent).toBe('composer');

    fireEvent.click(within(sheet).getByTestId('entity-chat-close'));
    await waitFor(() => expect(view.queryByTestId('entity-chat-phone-sheet')).toBeNull());
  }, SLOW_GATE_MS);

  it('Back (the previous address) closes it', async () => {
    const view = render(<PhoneHost />);
    await waitFor(() => expect(view.getAllByTestId('list-tile').length).toBeGreaterThan(0));
    const before = routeOf(navStore.getState());
    act(() => navStore.getState().openChat({ about: '01a0-task' as EntityId, thread: 'new' }));
    await waitFor(() => view.getByTestId('entity-chat-phone-sheet'));
    act(() => navStore.getState().hydrate(before));
    await waitFor(() => expect(view.queryByTestId('entity-chat-phone-sheet')).toBeNull());
  }, SLOW_GATE_MS);

  it('the phone’s action menu carries the Chat count', () => {
    const items = panelMenuItems({
      config: getKind('task'),
      ctx: { spaceId: 'sp', entityId: 'e' } as never,
      onSelectTab: () => {},
      onAction: () => {},
      wiredActions: ['chat-about'],
      primaryCounts: { 'chat-about': 3 },
    });
    expect(items.find((item) => item.id === 'chat-about')?.count).toBe(3);
    expect(items.find((item) => item.id === 'run')?.count).toBeUndefined();
  });
});
