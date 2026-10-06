// @vitest-environment jsdom
/**
 * D31 (2026-10-06): the desktop has three modes — Work · Design · Observe —
 * lands on Work, and every retired desktop address lands in Work. Driven
 * through the real GateApp and router, as a link or a reload would arrive.
 *
 * The phone and the legacy desktop (`shell/desktop-modes.ts`) are pinned NOT
 * to change: the phone keeps Home as its chat screen (D16).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { GateApp } from './GateApp';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { createMemoryTarget, type MemoryTarget } from '../routes';
import { FIXTURE_SPACE_ID } from '../fixtures';
import { SHELL_OVERRIDE_KEY } from '../mobile';
import { DESKTOP_MODES_KEY } from '../shell/desktop-modes';

const SPACE = FIXTURE_SPACE_ID;
const TASK = 'task-4f8c2a9e';

let storage: Map<string, string>;
function installStorage(): Map<string, string> {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: store });
  return map;
}

beforeEach(() => {
  storage = installStorage();
  resetNav();
  screenStackStore.getState().clearAll();
});
afterEach(cleanup);

const mount = (target: MemoryTarget) => render(<GateApp routerTarget={target} />);
const at = (path: string) => createMemoryTarget(`#/s/${SPACE}${path}`);

async function settle(ms = 120): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe('the default landing is Work', () => {
  it('lands the bare space on Work, at its canonical /work address', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}`);
    const view = mount(target);
    await waitFor(() => view.getByTestId('tab-workspace'));
    await waitFor(() => expect(target.getHash()).toBe(`#/s/${SPACE}/work`));
    expect(view.queryByTestId('home-page')).toBeNull();
  });

  it('keeps /tabs as a permanent alias, rewritten in place to /work', async () => {
    const target = at('/tabs');
    const view = mount(target);
    await waitFor(() => view.getByTestId('tab-workspace'));
    await waitFor(() => expect(target.getHash()).toBe(`#/s/${SPACE}/work`));
  });
});

describe('retired desktop addresses land in Work (replace history)', () => {
  it('/home → Work', async () => {
    const target = at('/home');
    const view = mount(target);
    await waitFor(() => view.getByTestId('tab-workspace'));
    await waitFor(() => expect(target.getHash()).toBe(`#/s/${SPACE}/work`));
    expect(view.queryByTestId('home-page')).toBeNull();
  });

  it('/home/k/{slug} → Work with that kind in the browser', async () => {
    const target = at('/home/k/docs');
    const view = mount(target);
    await waitFor(() => view.getByTestId('tab-workspace'));
    await waitFor(() =>
      expect(view.container.querySelector('.tws-rail-kind[data-kind="doc"][aria-current="true"]')).not.toBeNull(),
    );
    expect(target.getHash()).toBe(`#/s/${SPACE}/work`);
  });

  it('k/{slug} for a Work kind → Work with that kind in the browser', async () => {
    const target = at('/k/tasks');
    const view = mount(target);
    await waitFor(() => view.getByTestId('tab-workspace'));
    await waitFor(() =>
      expect(view.container.querySelector('.tws-rail-kind[data-kind="task"][aria-current="true"]')).not.toBeNull(),
    );
    expect(view.queryByTestId('entity-view')).toBeNull();
  });

  it('the old Work with a stack (?p=) opens it as the active tab', async () => {
    const target = at(`/workspace?p=${TASK}`);
    const view = mount(target);
    await waitFor(() => view.getByTestId('tab-workspace'));
    await waitFor(() => expect(target.getHash()).toBe(`#/s/${SPACE}/work?tab=${TASK}`));
    expect(view.queryByTestId('workspace-grid')).toBeNull();
  });

  it('e/{id} for a Work kind → that entity as the active tab', async () => {
    const target = at(`/e/${TASK}`);
    const view = mount(target);
    await waitFor(() => view.getByTestId('tab-workspace'));
    await waitFor(() => expect(target.getHash()).toBe(`#/s/${SPACE}/work?tab=${TASK}`));
  });

  it('/board → Work', async () => {
    const target = at('/board');
    const view = mount(target);
    await waitFor(() => view.getByTestId('tab-workspace'));
    /* Work restores the tabs this viewer already has open in the space. */
    await waitFor(() => expect(target.getHash()).toMatch(new RegExp(`^#/s/${SPACE}/work(\\?tab=|$)`)));
    expect(view.queryByTestId('board-screen')).toBeNull();
  });

  it('leaves Design, Observe, Settings and Help where they are', async () => {
    for (const path of ['/graph', '/craft', '/settings', '/help']) {
      resetNav();
      const target = at(path);
      const view = mount(target);
      await settle();
      expect(view.queryByTestId('tab-workspace')).toBeNull();
      expect(target.getHash()).toBe(`#/s/${SPACE}${path}`);
      view.unmount();
    }
  });
});

describe('who is NOT redirected', () => {
  it('the phone keeps Home as its chat screen (D16)', async () => {
    storage.set(SHELL_OVERRIDE_KEY, 'mobile');
    const target = at('/home');
    const view = mount(target);
    await settle(200);
    expect(view.queryByTestId('tab-workspace')).toBeNull();
    expect(target.getHash()).toBe(`#/s/${SPACE}/home`);
  });

  it('the legacy desktop keeps Home', async () => {
    storage.set(DESKTOP_MODES_KEY, 'legacy');
    const target = at('/home');
    const view = mount(target);
    await waitFor(() => view.getByTestId('home-page'));
    expect(target.getHash()).toBe(`#/s/${SPACE}/home`);
  });
});

describe('the selector is Work · Design · Observe', () => {
  it('in Work: the view menu lists exactly the three modes, Work current', async () => {
    const view = mount(at('/work'));
    await waitFor(() => view.getByTestId('tab-workspace'));
    const trigger = view.getByTestId('tws-view-select');
    expect(trigger.textContent).toContain('Work');
    fireEvent.click(trigger);
    const rows = within(view.getByRole('menu', { name: 'Views' })).getAllByRole('menuitemradio');
    expect(rows.map((row) => row.textContent?.trim())).toEqual(['Work', 'Design', 'Observe']);
    expect(rows[0]!.getAttribute('aria-checked')).toBe('true');
  });

  it('on Observe: the bar leads with the three modes and no retired view anywhere', async () => {
    const view = mount(at('/graph'));
    const tabs = await waitFor(() => view.getByRole('tablist', { name: 'Screens' }));
    const pill = within(tabs).getByTestId('top-view-switcher');
    expect([...pill.querySelectorAll('[role="tab"]')].map((n) => n.textContent?.trim())).toEqual([
      'Work',
      'Design',
      'Observe',
    ]);
    const labels = [...tabs.querySelectorAll('[role="tab"]')].map((n) => n.textContent?.trim());
    for (const retired of ['Home', 'Workspace', 'Board', 'Craft', 'Graph']) expect(labels).not.toContain(retired);
  });

  it("Work's rail keeps Design, Settings and Help as tools, after Needs you and Status", async () => {
    const view = mount(at('/work'));
    await waitFor(() => view.getByTestId('tab-workspace'));
    const tools = view.getByRole('group', { name: 'Work tools' });
    const names = [...tools.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(names.slice(0, 2)).toEqual(['Needs you', 'Status']);
    for (const tool of ['Command palette', 'Design', 'Settings', 'Help']) expect(names).toContain(tool);
  });
});

describe('the palette', () => {
  const openPalette = async (view: ReturnType<typeof mount>) => {
    fireEvent.keyDown(window, { key: '/' });
    return waitFor(() => view.getByTestId('command-palette'));
  };
  const rowLabels = (palette: HTMLElement) =>
    [...palette.querySelectorAll('[data-testid="palette-row"] .pal__row-label')].map((n) => n.textContent);

  it('offers Work, and opening it lands on Work (not the old Work)', async () => {
    const target = at('/graph');
    const view = mount(target);
    await waitFor(() => view.getByRole('tablist', { name: 'Screens' }));
    const palette = await openPalette(view);
    fireEvent.change(palette.querySelector('input') as HTMLInputElement, { target: { value: 'Work' } });
    const row = await waitFor(() => {
      const found = [...palette.querySelectorAll<HTMLElement>('[data-testid="palette-row"]')].find(
        (n) => n.querySelector('.pal__row-label')?.textContent === 'Work',
      );
      if (!found) throw new Error('no Work row');
      return found;
    });
    fireEvent.click(row);
    await waitFor(() => view.getByTestId('tab-workspace'));
    expect(target.getHash()).toMatch(new RegExp(`^#/s/${SPACE}/work(\\?tab=|$)`));
    expect(view.queryByTestId('workspace-grid')).toBeNull();
  });

  it('has no row for a retired view', async () => {
    const view = mount(at('/graph'));
    await waitFor(() => view.getByRole('tablist', { name: 'Screens' }));
    const palette = await openPalette(view);
    for (const retired of ['Home', 'Workspace']) {
      fireEvent.change(palette.querySelector('input') as HTMLInputElement, { target: { value: retired } });
      await settle(40);
      expect(rowLabels(palette)).not.toContain(retired);
    }
  });
});

describe('Work is a remembered place', () => {
  it('a restore with Home remembered lands on Work instead', async () => {
    storage.set(
      'tm8.last-place.v1.local',
      JSON.stringify({ spaceId: SPACE, targets: { [SPACE]: { type: 'view', ref: 'dashboard' } } }),
    );
    const view = render(<GateApp />);
    await waitFor(() => view.getByTestId('tab-workspace'));
    expect(view.queryByTestId('home-page')).toBeNull();
  });

  it('entering Work writes it to last-place', async () => {
    const view = mount(at('/work'));
    await waitFor(() => view.getByTestId('tab-workspace'));
    await waitFor(() => {
      const record = JSON.parse(storage.get('tm8.last-place.v1.local') ?? '{}') as {
        targets?: Record<string, unknown>;
      };
      expect(record.targets?.[SPACE]).toEqual({ type: 'work' });
    });
  });
});
