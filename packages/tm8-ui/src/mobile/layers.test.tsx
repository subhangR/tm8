// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileDrawer, resetDrawerOpenState } from './MobileDrawer';
import { MobileSheet } from './MobileSheet';
import { MobileSurfaceProvider } from './surface';
import { LAYER_EXIT_MS, usePresence } from './layerMotion';
import { resetRailStores } from '../tab-workspace/runtime/railStore';
import { resetOverlayHistory } from '../stores/overlayHistory';

/**
 * THE LAYER CONTRACT (task t-layers; audit C3/C4/D1/D2): focus moves in, Tab
 * stays in, the screen behind is inert, focus returns to the opener; the
 * drawer swipes closed and plays an exit; a sheet drags down to dismiss.
 * jsdom has no layout and no animation, so sizes are stubbed and the exit is
 * asserted through `usePresence`'s mount window.
 */

const NOOP = () => undefined;

function frame() {
  const root = document.createElement('div');
  root.className = 'mobile-frame';
  const screen = document.createElement('main');
  const opener = document.createElement('button');
  opener.textContent = '☰';
  screen.appendChild(opener);
  const host = document.createElement('div');
  root.append(screen, host);
  document.body.appendChild(root);
  return { root, screen, opener, host };
}

function drawer(host: HTMLElement, over: Partial<Parameters<typeof MobileDrawer>[0]> = {}) {
  return (
    <MobileSurfaceProvider sheetHost={host}>
      <MobileDrawer
        spaceLabel="tm8"
        activeTarget={null}
        navigateTo={NOOP}
        countsFor={() => undefined}
        rowsOf={() => []}
        ensureKind={NOOP}
        onOpenEntity={NOOP}
        onOpenChat={NOOP}
        onOpenChats={NOOP}
        onNewThread={NOOP}
        onDismiss={NOOP}
        {...over}
      />
    </MobileSurfaceProvider>
  );
}

function setMotion(reduce: boolean | null) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value:
      reduce === null
        ? undefined
        : (query: string) => ({
            matches: query.includes('reduced-motion') ? reduce : false,
            media: query,
            addEventListener: NOOP,
            removeEventListener: NOOP,
            addListener: NOOP,
            removeListener: NOOP,
          }),
  });
}

function sized(el: HTMLElement, width: number, height: number) {
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: width });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height });
}

function drag(el: HTMLElement, from: [number, number], to: [number, number], start: Element = el) {
  fireEvent.pointerDown(start, { pointerId: 7, button: 0, clientX: from[0], clientY: from[1] });
  const steps = 4;
  for (let i = 1; i <= steps; i += 1) {
    fireEvent.pointerMove(el, {
      pointerId: 7,
      clientX: from[0] + ((to[0] - from[0]) * i) / steps,
      clientY: from[1] + ((to[1] - from[1]) * i) / steps,
    });
  }
  fireEvent.pointerUp(el, { pointerId: 7, clientX: to[0], clientY: to[1] });
}

beforeEach(() => {
  window.localStorage.clear();
  resetRailStores();
  resetDrawerOpenState();
  resetOverlayHistory();
  setMotion(null);
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('drawer focus (audit C3)', () => {
  it('focuses ＋ New chat, makes the screen inert, and returns focus to the ☰ on close', () => {
    const { screen, opener, host } = frame();
    opener.focus();
    const view = render(drawer(host), { container: host });
    expect(document.activeElement).toBe(view.getByTestId('mobile-drawer-new-chat'));
    expect(screen.hasAttribute('inert')).toBe(true);
    view.unmount();
    expect(screen.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('releases focus at the start of the exit, not the end', () => {
    const { screen, opener, host } = frame();
    opener.focus();
    const view = render(drawer(host), { container: host });
    view.rerender(drawer(host, { closing: true }));
    expect(screen.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(view.getByTestId('mobile-drawer').getAttribute('data-state')).toBe('closing');
  });

  it('traps Tab inside the drawer', () => {
    const { host } = frame();
    const view = render(drawer(host), { container: host });
    const panel = view.getByRole('dialog');
    const buttons = Array.from(panel.querySelectorAll<HTMLElement>('button'));
    const last = buttons[buttons.length - 1]!;
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

describe('drawer swipe to close (audit C4)', () => {
  it('a swipe left past a third of the panel closes it', () => {
    const { host } = frame();
    const onDismiss = vi.fn();
    const view = render(drawer(host, { onDismiss }), { container: host });
    const panel = view.getByRole('dialog');
    sized(panel, 300, 700);
    drag(panel, [250, 300], [100, 305]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(panel.style.getPropertyValue('--mdrawer-drag')).toBe('-150px');
  });

  it('a short swipe springs back, and a vertical drag is the scroll’s', () => {
    const { host } = frame();
    const onDismiss = vi.fn();
    const view = render(drawer(host, { onDismiss }), { container: host });
    const panel = view.getByRole('dialog');
    sized(panel, 300, 700);
    /* A slow finger: 100ms between events, so no move reads as a flick. */
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 100));
    drag(panel, [250, 300], [200, 300]);
    drag(panel, [150, 100], [140, 500]);
    now.mockRestore();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(panel.style.transform).toBe('');
  });

  it('a swipe right (the opening direction) does nothing', () => {
    const { host } = frame();
    const onDismiss = vi.fn();
    const view = render(drawer(host, { onDismiss }), { container: host });
    const panel = view.getByRole('dialog');
    sized(panel, 300, 700);
    drag(panel, [50, 300], [290, 300]);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe('usePresence — the drawer stays mounted through its exit', () => {
  it('lingers for the exit when motion is allowed', () => {
    vi.useFakeTimers();
    try {
      setMotion(false);
      const hook = renderHook(({ open }) => usePresence(open), { initialProps: { open: true } });
      hook.rerender({ open: false });
      expect(hook.result.current).toEqual({ mounted: true, closing: true });
      act(() => vi.advanceTimersByTime(LAYER_EXIT_MS));
      expect(hook.result.current).toEqual({ mounted: false, closing: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('unmounts at once under prefers-reduced-motion', () => {
    setMotion(true);
    const hook = renderHook(({ open }) => usePresence(open), { initialProps: { open: true } });
    hook.rerender({ open: false });
    expect(hook.result.current).toEqual({ mounted: false, closing: false });
  });
});

describe('MobileSheet (audit D1/D2)', () => {
  function sheet(host: HTMLElement, onDismiss: () => void) {
    return (
      <MobileSurfaceProvider sheetHost={host}>
        <MobileSheet title="Account" onDismiss={onDismiss}>
          <input aria-label="search" />
          <button type="button">First row</button>
        </MobileSheet>
      </MobileSurfaceProvider>
    );
  }

  it('focuses the first row of the body, skipping a text field and the ✕', () => {
    const { host, screen } = frame();
    const view = render(sheet(host, NOOP), { container: host });
    expect(document.activeElement).toBe(view.getByText('First row'));
    expect(screen.hasAttribute('inert')).toBe(true);
  });

  it('dragging the head down dismisses; dragging the body does not', () => {
    const { host } = frame();
    const onDismiss = vi.fn();
    const view = render(sheet(host, onDismiss), { container: host });
    const panel = view.getByRole('dialog');
    sized(panel, 390, 600);
    drag(panel, [200, 300], [200, 600], view.getByText('First row'));
    expect(onDismiss).not.toHaveBeenCalled();
    const head = panel.querySelector('.msheet__title')!;
    drag(panel, [200, 20], [200, 300], head);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
