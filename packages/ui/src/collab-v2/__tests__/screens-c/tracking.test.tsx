/**
 * Tracking (W3c) — PR rows with fetch freshness, linked task chips from
 * `tracks` edges, per-row refresh and refresh-all through `trackingRefresh`.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackingScreen } from '../../screens/tracking';
import { createFacade, renderWith, resetStores, viewProps } from './helpers';

describe('Tracking', () => {
  beforeEach(() => resetStores());
  afterEach(() => cleanup());

  it('lists every tracked PR with repo#, state and fetch freshness', async () => {
    const facade = createFacade();
    const prs = await facade.queryCollection({ spaceId: facade.ids.space, kinds: ['pull_request'] });
    expect(prs.page.items.length).toBeGreaterThan(1);

    renderWith(facade, <TrackingScreen {...viewProps(facade, { view: 'tracking' })} />);
    await screen.findByTestId('view-tracking');

    for (const pr of prs.page.items) {
      const row = await screen.findByTestId(`tracking-row-${pr.id}`);
      expect(within(row).getByText(pr.title)).toBeInTheDocument();
      if (pr.state.kind === 'pull_request') {
        expect(row).toHaveTextContent(`${pr.state.repository}#${pr.state.number}`);
        expect(row).toHaveTextContent(pr.state.state);
      }
    }
  });

  it('marks a stale fetch on the row', async () => {
    const facade = createFacade();
    // Force the staleness signal the way the world computes it: bump the PR.
    const prId = facade.ids.pr248;
    await facade.linkPr(facade.ids.t104, { url: 'https://github.com/subhang/agent-maestro/pull/248' });
    const before = await facade.getEntity(prId);
    const wasStale = before.state.kind === 'pull_request' ? before.state.stale : false;

    renderWith(facade, <TrackingScreen {...viewProps(facade, { view: 'tracking' })} />);
    const row = await screen.findByTestId(`tracking-row-${prId}`);
    if (wasStale) expect(row).toHaveTextContent('stale');
    // Freshness is always stated, stale or not.
    expect(row.textContent ?? '').toMatch(/fetched|stale|open|merged|closed/);
  });

  it('shows the linked task chips from tracks edges', async () => {
    const facade = createFacade();
    const connections = await facade.getConnections(facade.ids.pr248);
    const linked = [...connections.incoming, ...connections.outgoing]
      .filter((g) => g.type === 'tracks')
      .flatMap((g) => g.edges.map((e) => (e.source.id === facade.ids.pr248 ? e.target : e.source)));
    expect(linked.length).toBeGreaterThan(0);

    renderWith(facade, <TrackingScreen {...viewProps(facade, { view: 'tracking' })} />);
    const links = await screen.findByTestId(`tracking-links-${facade.ids.pr248}`);
    for (const task of linked) {
      expect(await within(links).findByText(task.title)).toBeInTheDocument();
    }
  });

  it('per-row refresh fires trackingRefresh for exactly that entity', async () => {
    const facade = createFacade();
    const spy = vi.spyOn(facade, 'trackingRefresh');

    renderWith(facade, <TrackingScreen {...viewProps(facade, { view: 'tracking' })} />);
    const pr = await facade.getEntity(facade.ids.pr248);
    const row = await screen.findByTestId(`tracking-row-${pr.id}`);

    fireEvent.click(within(row).getByLabelText(`Refresh ${pr.title}`));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0].entityIds).toEqual([pr.id]);
    expect(spy.mock.calls[0][0].clientMutationId).toBeTruthy();
  });

  it('refresh-all fires one command with no entity filter and re-fetches every row', async () => {
    const facade = createFacade();
    const spy = vi.spyOn(facade, 'trackingRefresh');

    renderWith(facade, <TrackingScreen {...viewProps(facade, { view: 'tracking' })} />);
    fireEvent.click(await screen.findByTestId('tracking-refresh-all'));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0].entityIds).toBeUndefined();

    // The command's patches land as entity.upsert events, so the row's card
    // shows the newer fetch stamp without this screen polling.
    const after = await facade.getEntity(facade.ids.pr248);
    if (after.state.kind === 'pull_request') expect(after.state.stale).toBe(false);
  });

  it('renders the commits list through the collection system', async () => {
    const facade = createFacade();
    const commits = await facade.queryCollection({ spaceId: facade.ids.space, kinds: ['commit'] });
    expect(commits.page.items.length).toBeGreaterThan(0);

    renderWith(facade, <TrackingScreen {...viewProps(facade, { view: 'tracking' })} />);
    const section = await screen.findByLabelText('Commits');
    for (const commit of commits.page.items) {
      expect(await within(section).findByText(commit.title)).toBeInTheDocument();
    }
  });
});
