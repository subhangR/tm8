/**
 * L3 gate G1 — the composed shell: rails render from facade data, a deep link
 * reproduces the whole layout (view + stack + pins) on first paint, the
 * keyboard map is live, and center views come from the pluggable registry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createSeededFacade, type MockFacade } from '../../mock';
import { useNavStore } from '../../stores/nav';
import { useGraphStore } from '../../stores/graph';
import { ShellLayout } from '../../shell/ShellLayout';
import { createMemoryTarget, type MemoryTarget } from '../../shell/router';
import type { ShellViewProps } from '../../shell/types';

const nav = () => useNavStore.getState();

let facade: MockFacade;
let target: MemoryTarget;

function mount(hash: (ids: MockFacade['ids']) => string, extra: Record<string, unknown> = {}) {
  facade = createSeededFacade({ latency: 0 });
  target = createMemoryTarget(hash(facade.ids));
  render(<ShellLayout facade={facade} routerTarget={target} {...extra} />);
  return { facade, target };
}

beforeEach(() => {
  nav().reset();
  useGraphStore.getState().reset();
});

describe('rails render from the facade', () => {
  it('shows the space, its channels with unread, and the inbox dot', async () => {
    mount((ids) => `#/s/${encodeURIComponent(ids.space)}/home`);

    const rail = await screen.findByRole('navigation', { name: 'Space navigation' });
    await within(rail).findByText('maestro-core');

    const navigation = await facade.getNavigation(facade.ids.space);
    for (const channel of navigation.channels) {
      await within(rail).findByText(channel.entity.title);
    }

    // Sections carry counts pulled from real collection queries.
    const tasks = await facade.queryCollection({ spaceId: facade.ids.space, kinds: ['task'], limit: 1 });
    const tasksBtn = within(rail).getByRole('button', { name: /^Tasks/ });
    await waitFor(() => expect(tasksBtn.textContent).toContain(String(tasks.page.total)));

    const spaces = await screen.findByRole('navigation', { name: 'Spaces' });
    await waitFor(() => expect(within(spaces).queryByTestId('inbox-unread-dot')).not.toBeNull());
  });

  it('rail clicks move the center view and the URL', async () => {
    mount((ids) => `#/s/${encodeURIComponent(ids.space)}/home`);
    const rail = await screen.findByRole('navigation', { name: 'Space navigation' });

    fireEvent.click(within(rail).getByRole('button', { name: /^Docs/ }));
    await waitFor(() => expect(nav().view).toBe('docs'));
    expect(target.getHash()).toBe(`#/s/${encodeURIComponent(facade.ids.space)}/docs`);
    await screen.findByTestId('view-docs');
  });

  it('a channel click opens the channel Z4 route, and the URL round-trips', async () => {
    mount((ids) => `#/s/${encodeURIComponent(ids.space)}/home`);
    const rail = await screen.findByRole('navigation', { name: 'Space navigation' });
    const channel = (await facade.getNavigation(facade.ids.space)).channels[0];

    fireEvent.click(await within(rail).findByText(channel.entity.title));
    await waitFor(() => expect(nav().view).toBe('channel'));
    expect(nav().entityId).toBe(channel.entity.id);

    // This asserted `/e/` and therefore locked in a REAL BUG: `toHash` wrote a
    // channel as `/e/{id}`, but `hydrateFromHash` reads every `/e/{id}` back as
    // the generic `entity` view — so a channel deep link, a reload, or
    // back/forward silently landed on the wrong screen. Channels now have their
    // own spelling, and what matters is not the spelling but that it SURVIVES
    // a round-trip, which is what this now checks.
    const hash = target.getHash();
    expect(hash).toContain('/channel/');

    useNavStore.getState().reset();
    useNavStore.getState().hydrateFromHash(hash);
    expect(useNavStore.getState().view).toBe('channel');
    expect(useNavStore.getState().entityId).toBe(channel.entity.id);
  });
});

describe('deep link reproduces the layout', () => {
  it('restores view, stack and pinned splits on first paint', async () => {
    const probe = createSeededFacade({ latency: 0 });
    const { space, t100, t103, docSpec } = probe.ids;
    const hash = `#/s/${encodeURIComponent(space)}/tasks`
      + `?p=${encodeURIComponent(t100)}.${encodeURIComponent(t103)}&pin=${encodeURIComponent(docSpec)}`;

    mount(() => hash);

    expect(nav().view).toBe('tasks');
    expect(nav().stack.map((r) => r.entityId)).toEqual([t100, t103]);
    expect(nav().pinned.map((r) => r.entityId)).toEqual([docSpec]);

    await screen.findByTestId('view-tasks');
    await screen.findByTestId(`panel-pinned-${docSpec}`);
    await screen.findByTestId(`panel-stacked-${t103}`);
    // Only the top of the stack is drawn; the rest live in the breadcrumb.
    expect(screen.queryByTestId(`panel-stacked-${t100}`)).toBeNull();
    expect(target.getHash()).toBe(hash);
  });
});

describe('view registry', () => {
  it('renders a registered screen instead of the placeholder', async () => {
    const Tasks = ({ spaceId, view }: ShellViewProps) => (
      <div data-testid="screen-tasks">{view}:{spaceId}</div>
    );
    mount((ids) => `#/s/${encodeURIComponent(ids.space)}/tasks`, { views: { tasks: Tasks } });

    const el = await screen.findByTestId('screen-tasks');
    expect(el.textContent).toBe(`tasks:${facade.ids.space}`);
    expect(screen.queryByTestId('view-tasks')).toBeNull();
  });

  it('center views open panels through onOpenEntity', async () => {
    const Tasks = ({ onOpenEntity }: ShellViewProps) => (
      <button type="button" data-testid="open" onClick={() => onOpenEntity('X-1')}>open</button>
    );
    mount((ids) => `#/s/${encodeURIComponent(ids.space)}/tasks`, { views: { tasks: Tasks } });

    fireEvent.click(await screen.findByTestId('open'));
    await waitFor(() => expect(nav().stack.map((r) => r.entityId)).toEqual(['X-1']));
  });
});

describe('keyboard wiring', () => {
  it('⌘K toggles the palette slot and ⌫ pops a panel', async () => {
    mount((ids) => `#/s/${encodeURIComponent(ids.space)}/home`, {
      palette: <div data-testid="palette">palette</div>,
    });
    await screen.findByTestId('view-home');

    act(() => { fireEvent.keyDown(window, { key: 'k', metaKey: true }); });
    expect(await screen.findByTestId('palette')).toBeTruthy();

    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    await waitFor(() => expect(screen.queryByTestId('palette')).toBeNull());

    act(() => { nav().pushPanel({ entityId: facade.ids.t101 }); });
    await screen.findByTestId(`panel-stacked-${facade.ids.t101}`);
    act(() => { fireEvent.keyDown(window, { key: 'Backspace' }); });
    await waitFor(() => expect(nav().stack).toHaveLength(0));
  });

  it('g then t jumps the center view', async () => {
    mount((ids) => `#/s/${encodeURIComponent(ids.space)}/home`);
    await screen.findByTestId('view-home');

    act(() => { fireEvent.keyDown(window, { key: 'g' }); });
    act(() => { fireEvent.keyDown(window, { key: 't' }); });
    await waitFor(() => expect(nav().view).toBe('tasks'));
    expect(target.getHash()).toContain('/tasks');
  });
});

describe('live navigation data', () => {
  it('refetches the rails when workspace events arrive', async () => {
    mount((ids) => `#/s/${encodeURIComponent(ids.space)}/home`);
    const rail = await screen.findByRole('navigation', { name: 'Space navigation' });
    const spy = vi.spyOn(facade, 'getNavigation');

    await act(async () => {
      await facade.postMessage({
        anchorId: facade.ids.chBuild,
        body: 'shell smoke test',
      });
    });

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(rail).toBeTruthy();
  });
});
