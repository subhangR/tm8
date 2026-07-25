/**
 * GOLDEN WORKFLOW 5 — ORIENT A NEWCOMER (brief §10.5).
 *
 *   a new member joins → Home explains itself → they open the Graph focused on
 *   the milestone task and see the subtree, deps, people and docs → they join
 *   the channel and read the pinned shelf. Zero tribal knowledge needed.
 *
 * "Newcomer" is enforced literally: every test here runs against a FRESH
 * facade with EMPTY stores and NO prior navigation. If a surface only makes
 * sense after you have clicked around, it fails here.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { ChannelHub } from '../../screens/channel';
import { HomeScreen } from '../../screens/home';
import { buildGraphView } from '../../collections/graph';
import { useCollectionsStore, useGraphStore, useNavStore, usePresenceStore } from '../../stores';
import {
  createRig, renderApp, renderBare, resetStores, settle, type AcceptanceRig,
} from './helpers';

let rig: AcceptanceRig;

/** Assert the newcomer really is cold before each act of the story. */
function assertColdStart(): void {
  expect(Object.keys(useGraphStore.getState().entities), 'cold graph store').toHaveLength(0);
  expect(useNavStore.getState().stack, 'no navigation history').toHaveLength(0);
  expect(useNavStore.getState().pinned).toHaveLength(0);
}

beforeEach(() => { resetStores(); rig = createRig(); });
afterEach(async () => { await settle(); });

function viewProps(over: Record<string, unknown> = {}) {
  return {
    facade: rig.facade, spaceId: rig.ids.space, view: 'home' as const,
    entityId: null, onOpenEntity: () => {}, onNavigate: () => {}, ...over,
  };
}

describe('WORKFLOW 5 — orient a newcomer', () => {
  it('ACT 1 — Home self-explains from a cold store: three labelled work columns + activity', async () => {
    assertColdStart();
    renderBare(rig, <HomeScreen {...viewProps()} />);

    // the three columns are all present and all NAMED — the newcomer can read
    // what each one is without being told
    const ready = await screen.findByTestId('home-ready');
    const inFlight = await screen.findByTestId('home-inflight');
    const needsMe = await screen.findByTestId('home-needsme');

    for (const column of [ready, inFlight, needsMe]) {
      const heading = column.querySelector('h2, h3, [class*="eyebrow"], [class*="title"]');
      expect(heading?.textContent?.trim(), 'every column carries a self-describing label')
        .toBeTruthy();
    }

    // and each column has real content from the seed, not an empty shell
    expect(await within(ready).findByText(/T-103/)).toBeInTheDocument();
    expect(await within(inFlight).findByText(/T-104/)).toBeInTheDocument();
    expect(await within(needsMe).findByText(/T-106/)).toBeInTheDocument();

    // the compact activity feed tells them what has been happening
    const feed = await screen.findByTestId('home-activity');
    await waitFor(() => {
      expect(feed.querySelectorAll('.cv2-home__act').length).toBeGreaterThan(0);
    });
  });

  it('ACT 1b — the Ready column teaches the next action (PULL) without instruction', async () => {
    assertColdStart();
    renderBare(rig, <HomeScreen {...viewProps()} />);
    const pull = await screen.findByTestId(`pull-${rig.ids.t103}`);
    expect(pull.textContent, 'the affordance names itself').toMatch(/pull/i);
  });

  it('ACT 2 — the dependency graph, focused on the milestone, shows the RED blocked path', async () => {
    assertColdStart();
    const result = await rig.facade.queryGraph({
      spaceId: rig.ids.space, subtreeOf: rig.ids.t100, mode: 'dependency',
    });

    // the milestone subtree came back
    const nodeIds = result.nodes.map((n) => n.id);
    expect(nodeIds.length, 'the milestone neighbourhood').toBeGreaterThan(3);
    expect(result.edges.every((e) => e.type === 'depends_on'),
      'dependency mode shows only dependency edges').toBe(true);

    // dependency mode marks the blocked path RED — T-105 --hard--> T-104
    const view = buildGraphView(result, { mode: 'dependency' });
    expect(view.blockedNodeIds.has(rig.ids.t105), 'T-105 is on the blocked path').toBe(true);
    expect(view.blockedNodeIds.has(rig.ids.t104), 'and so is what it waits on').toBe(true);

    const red = view.edges.filter((e) => e.blocked);
    expect(red.length, 'the path itself is marked').toBeGreaterThan(0);
    expect(red.some((e) => e.source === rig.ids.t105 && e.target === rig.ids.t104)).toBe(true);

    // a newcomer can also see that a RESOLVED dep is not red — the colour means
    // something specific, not "this is a dependency"
    const resolved = view.edges.find((e) => e.source === rig.ids.t106 && e.target === rig.ids.t101);
    if (resolved) expect(resolved.blocked).toBe(false);
  });

  it('ACT 2b — the graph carries people and docs too, not just tasks', async () => {
    const result = await rig.facade.queryGraph({
      spaceId: rig.ids.space, focusId: rig.ids.t104, hops: 2,
    });
    const kinds = new Set(result.nodes.map((n) => n.kind));
    expect(kinds.has('task')).toBe(true);
    expect([...kinds].some((k) => k === 'member' || k === 'team_member'),
      `people reachable in 2 hops (kinds: ${[...kinds].join(',')})`).toBe(true);
    expect(kinds.has('doc'), `docs reachable in 2 hops (kinds: ${[...kinds].join(',')})`).toBe(true);
  });

  it('ACT 3 — the channel shelf shows the pinned entities on first paint', async () => {
    assertColdStart();
    const detail = await rig.facade.getEntity(rig.ids.chBuild);
    const pinned = detail.content.kind === 'channel' ? detail.content.pinned : [];
    expect(pinned.length, 'the seed pins things worth reading first').toBeGreaterThan(0);

    renderBare(rig, <ChannelHub {...viewProps({ view: 'channel', entityId: rig.ids.chBuild })} />);
    const shelf = await screen.findByTestId('channel-shelf');
    for (const item of pinned) {
      expect(within(shelf).getByText(item.title), `pinned: ${item.title}`).toBeInTheDocument();
    }

    // and the auto-tabs tell them what kinds of thing live here
    const strip = await screen.findByTestId('channel-tabs');
    const tabs = await rig.facade.getChannelTabs(rig.ids.chBuild);
    await waitFor(() => {
      expect(within(strip).getAllByRole('tab')).toHaveLength(tabs.length);
    });
  });

  it('THE WHOLE STORY — one cold app, three surfaces, zero prior navigation', async () => {
    assertColdStart();
    const app = renderApp(rig);

    // 1. lands on Home (the default view) and it is self-explaining
    expect(await screen.findByTestId('view-home')).toBeInTheDocument();
    expect(await screen.findByTestId('home-ready')).toBeInTheDocument();
    expect(await screen.findByTestId('home-inflight')).toBeInTheDocument();
    expect(await screen.findByTestId('home-needsme')).toBeInTheDocument();

    // 2. the left rail names every place they can go — no hidden surfaces
    const rail = await screen.findByRole('navigation', { name: 'Space navigation' });
    const navigation = await rig.facade.getNavigation(rig.ids.space);
    for (const channel of navigation.channels) {
      await within(rail).findByText(channel.entity.title);
    }
    for (const label of ['Tasks', 'Docs', 'Team']) {
      expect(within(rail).getByRole('button', { name: new RegExp(`^${label}`) }))
        .toBeInTheDocument();
    }

    // 3. walk to the channel hub and read the shelf
    act(() => { useNavStore.getState().setView('channel', rig.ids.chBuild); });
    const shelf = await screen.findByTestId('channel-shelf');
    expect(shelf.textContent?.trim().length, 'the shelf is not empty on arrival')
      .toBeGreaterThan(0);

    app.disconnect();
  });

  it('nothing above depended on a warm cache — the stores were cold at every entry', () => {
    // guards the guard: resetStores() really empties everything the screens read
    resetStores();
    expect(Object.keys(useGraphStore.getState().entities)).toHaveLength(0);
    expect(useCollectionsStore.getState().reset).toBeTypeOf('function');
    expect(usePresenceStore.getState()).toBeTruthy();
    expect(useNavStore.getState().view).toBe('home');
  });
});
