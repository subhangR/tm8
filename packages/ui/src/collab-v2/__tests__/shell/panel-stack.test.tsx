/**
 * L3 gate G1 — the panel grammar, driven through the real shell against the
 * seeded facade: peek → stack (breadcrumb) → pin as split (cap enforced) →
 * promote to Z4, with the URL tracking every step.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createSeededFacade, type MockFacade } from '../../mock';
import { MAX_PINNED, useNavStore } from '../../stores/nav';
import { useGraphStore } from '../../stores/graph';
import { ShellLayout } from '../../shell/ShellLayout';
import { createMemoryTarget, type MemoryTarget } from '../../shell/router';

const nav = () => useNavStore.getState();

let facade: MockFacade;
let target: MemoryTarget;

function mountShell(initialHash: string | ((ids: MockFacade['ids']) => string) = '#/') {
  facade = createSeededFacade({ latency: 0 });
  target = createMemoryTarget(typeof initialHash === 'function' ? initialHash(facade.ids) : initialHash);
  const utils = render(
    <ShellLayout facade={facade} spaceId={facade.ids.space} routerTarget={target} enableKeyboard={false} />,
  );
  return { ...utils, facade, target };
}

/** Rows inside the center view — scoped so left-rail "Tasks" never matches. */
async function centerRows(): Promise<HTMLElement[]> {
  const center = await screen.findByTestId('view-home');
  return within(center).findAllByRole('button', { name: /task/i });
}

beforeEach(() => {
  nav().reset();
  useGraphStore.getState().reset();
});

describe('peek and stack', () => {
  it('clicking a card peeks a Z3 panel and the URL records it', async () => {
    mountShell();
    await screen.findByTestId('view-home');

    const row = (await centerRows())[0];
    fireEvent.click(row);

    await waitFor(() => expect(nav().stack).toHaveLength(1));
    const opened = nav().stack[0].entityId;
    expect(await screen.findByTestId(`panel-stacked-${opened}`)).toBeTruthy();
    expect(target.getHash()).toContain(`p=${encodeURIComponent(opened)}`);
  });

  it('a chip inside a panel stacks another, breadcrumbed, and crumbs pop back', async () => {
    mountShell();
    await screen.findByTestId('view-home');

    act(() => { nav().pushPanel({ entityId: facade.ids.t100 }); });
    const panel = await screen.findByTestId(`panel-stacked-${facade.ids.t100}`);

    // A child row inside the panel body opens the next panel on the stack.
    const child = (await within(panel).findAllByRole('button', { name: /task/i }))[0];
    fireEvent.click(child);
    await waitFor(() => expect(nav().stack).toHaveLength(2));

    const top = nav().stack[1].entityId;
    const crumbs = within(await screen.findByTestId(`panel-stacked-${top}`))
      .getByRole('navigation', { name: 'Panel stack' });
    await waitFor(() => expect(within(crumbs).getAllByRole('button').length).toBeGreaterThanOrEqual(2));

    // Click the first crumb → pop back down to it.
    const firstCrumb = within(crumbs).getAllByRole('button')[0];
    fireEvent.click(firstCrumb);
    await waitFor(() => expect(nav().stack.map((r) => r.entityId)).toEqual([facade.ids.t100]));
  });

  it('swiping right pops the top panel; a short swipe does not', async () => {
    mountShell();
    await screen.findByTestId('view-home');
    act(() => { nav().pushPanel({ entityId: facade.ids.t101 }); });
    act(() => { nav().pushPanel({ entityId: facade.ids.t103 }); });

    const panel = await screen.findByTestId(`panel-stacked-${facade.ids.t103}`);
    fireEvent.touchStart(panel, { touches: [{ clientX: 20, clientY: 40 }] });
    fireEvent.touchEnd(panel, { changedTouches: [{ clientX: 40, clientY: 44 }] });
    expect(nav().stack).toHaveLength(2);

    fireEvent.touchStart(panel, { touches: [{ clientX: 20, clientY: 40 }] });
    fireEvent.touchEnd(panel, { changedTouches: [{ clientX: 160, clientY: 48 }] });
    await waitFor(() => expect(nav().stack.map((r) => r.entityId)).toEqual([facade.ids.t101]));
  });

  it('closing pops one panel', async () => {
    mountShell();
    await screen.findByTestId('view-home');
    act(() => { nav().pushPanel({ entityId: facade.ids.t101 }); });
    act(() => { nav().pushPanel({ entityId: facade.ids.t103 }); });

    fireEvent.click(await screen.findByTestId(`panel-close-${facade.ids.t103}`));
    await waitFor(() => expect(nav().stack.map((r) => r.entityId)).toEqual([facade.ids.t101]));
  });
});

describe('pin to split', () => {
  it('pins a peeking panel into a persistent split', async () => {
    mountShell();
    await screen.findByTestId('view-home');
    act(() => { nav().pushPanel({ entityId: facade.ids.t103 }); });

    fireEvent.click(await screen.findByTestId(`panel-pin-${facade.ids.t103}`));
    await waitFor(() => expect(nav().pinned.map((r) => r.entityId)).toEqual([facade.ids.t103]));
    expect(nav().stack).toHaveLength(0);
    expect(await screen.findByTestId(`panel-pinned-${facade.ids.t103}`)).toBeTruthy();
    expect(target.getHash()).toContain('pin=');
  });

  it(`enforces the ${MAX_PINNED}-split cap and explains the refusal`, async () => {
    mountShell();
    await screen.findByTestId('view-home');
    const ids = [facade.ids.t101, facade.ids.t103, facade.ids.t105, facade.ids.docSpec];

    for (const id of ids.slice(0, MAX_PINNED)) {
      act(() => { nav().pushPanel({ entityId: id }); });
      fireEvent.click(await screen.findByTestId(`panel-pin-${id}`));
      await waitFor(() => expect(nav().pinned.some((r) => r.entityId === id)).toBe(true));
    }
    expect(nav().pinned).toHaveLength(MAX_PINNED);

    // One more: the store refuses, the shell says why, and nothing is docked.
    const overflow = ids[MAX_PINNED];
    act(() => { nav().pushPanel({ entityId: overflow }); });
    const pinBtn = await screen.findByTestId(`panel-pin-${overflow}`);
    expect(pinBtn).toHaveProperty('disabled', true);
    expect(pinBtn.getAttribute('aria-label')).toMatch(/limit reached/i);

    expect(nav().pinPanel(overflow)).toBe(false);
    expect(nav().pinned).toHaveLength(MAX_PINNED);
    expect(nav().stack.map((r) => r.entityId)).toEqual([overflow]);
  });

  it('unpinning frees a slot', async () => {
    mountShell();
    await screen.findByTestId('view-home');
    act(() => { nav().pushPanel({ entityId: facade.ids.t101 }); });
    fireEvent.click(await screen.findByTestId(`panel-pin-${facade.ids.t101}`));
    await waitFor(() => expect(nav().pinned).toHaveLength(1));

    fireEvent.click(await screen.findByTestId(`panel-close-${facade.ids.t101}`));
    await waitFor(() => expect(nav().pinned).toHaveLength(0));
  });
});

describe('promote to Z4', () => {
  it('promotes a panel to the route and leaves the center view as the back target', async () => {
    mountShell((ids) => `#/s/${encodeURIComponent(ids.space)}/tasks`);
    await waitFor(() => expect(nav().view).toBe('tasks'));

    act(() => { nav().pushPanel({ entityId: facade.ids.t105 }); });
    fireEvent.click(await screen.findByTestId(`panel-promote-${facade.ids.t105}`));

    await waitFor(() => expect(nav().view).toBe('entity'));
    expect(nav().entityId).toBe(facade.ids.t105);
    expect(nav().stack).toHaveLength(0);
    expect(target.getHash()).toContain('/e/');

    act(() => { target.back(); });
    await waitFor(() => expect(nav().view).toBe('tasks'));
  });
});

describe('slot interface', () => {
  it('renders injected panel bodies with the documented handlers', async () => {
    facade = createSeededFacade({ latency: 0 });
    target = createMemoryTarget('#/');
    const seen: string[] = [];
    render(
      <ShellLayout
        facade={facade}
        spaceId={facade.ids.space}
        routerTarget={target}
        enableKeyboard={false}
        renderPanel={(p) => {
          seen.push(`${p.mode}:${p.entityId}:${String(p.canPin)}`);
          return (
            <button type="button" data-testid={`slot-${p.entityId}`} onClick={() => p.onPromote()}>
              slot {p.entityId} depth {p.depth}
            </button>
          );
        }}
      />,
    );
    await screen.findByTestId('view-home');
    act(() => { nav().pushPanel({ entityId: facade.ids.t100 }); });

    fireEvent.click(await screen.findByTestId(`slot-${facade.ids.t100}`));
    await waitFor(() => expect(nav().view).toBe('entity'));
    expect(seen[0]).toBe(`stacked:${facade.ids.t100}:true`);
  });
});
