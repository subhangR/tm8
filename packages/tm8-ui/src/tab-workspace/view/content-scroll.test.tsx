// @vitest-environment jsdom
/**
 * ↑/↓ scroll the active tab (task 01a1156f): the content host scrolls the
 * terminal on screen, else the tab's largest scroller, and a tab switch only
 * takes focus from the page, the tab strip or the browser list.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerScrollTerminal, type ScrollTerminal } from '../../terminal/scrollTerminal';
import {
  ARROW_SCROLL_PX,
  HOLD_MAX_BOOST,
  HOLD_RAMP_MS,
  holdBoost,
  mainScroller,
  mayTakeFocus,
  scrollContentForKey,
} from './contentScroll';

const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
  ({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

function visible(el: HTMLElement) {
  el.getClientRects = () => [{}] as unknown as DOMRectList;
}

function scroller(height: number, width = 100): HTMLElement {
  const el = document.createElement('div');
  el.style.overflowY = 'auto';
  Object.defineProperty(el, 'scrollHeight', { value: height * 3 });
  Object.defineProperty(el, 'clientHeight', { value: height });
  Object.defineProperty(el, 'clientWidth', { value: width });
  el.scrollBy = vi.fn() as unknown as HTMLElement['scrollBy'];
  visible(el);
  return el;
}

function fakeTerm(): ScrollTerminal & { scrollLines: ReturnType<typeof vi.fn> } {
  return {
    rows: 24,
    element: undefined,
    modes: { mouseTrackingMode: 'none' },
    buffer: { active: { type: 'normal', viewportY: 50, baseY: 100 } },
    scrollLines: vi.fn(),
  } as unknown as ScrollTerminal & { scrollLines: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('scrollContentForKey', () => {
  it('scrolls the largest visible scroller by a line, and by a page', () => {
    const root = document.createElement('main');
    const small = scroller(50);
    const big = scroller(400);
    root.append(small, big);
    expect(mainScroller(root)).toBe(big);

    expect(scrollContentForKey(root, key('ArrowDown'))).toBe(true);
    expect(big.scrollBy).toHaveBeenLastCalledWith({ top: 100, behavior: 'smooth' });
    scrollContentForKey(root, key('ArrowUp'));
    expect(big.scrollBy).toHaveBeenLastCalledWith({ top: -100, behavior: 'smooth' });
    scrollContentForKey(root, key('PageDown'));
    expect(big.scrollBy).toHaveBeenLastCalledWith({ top: 300, behavior: 'smooth' });
    expect(small.scrollBy).not.toHaveBeenCalled();
  });

  it('skips a hidden scroller and one that does not overflow', () => {
    const root = document.createElement('main');
    const hidden = scroller(400);
    hidden.getClientRects = () => [] as unknown as DOMRectList;
    const clipped = scroller(300);
    clipped.style.overflowY = 'hidden';
    root.append(hidden, clipped);
    expect(mainScroller(root)).toBeNull();
    // Still the host's key: it never falls through to a page binding.
    expect(scrollContentForKey(root, key('ArrowDown'))).toBe(true);
  });

  it('scrolls the visible registered terminal instead of the page', () => {
    const root = document.createElement('main');
    const host = document.createElement('div');
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    visible(xterm);
    host.append(xterm);
    root.append(host, scroller(400));
    const term = fakeTerm();
    const unregister = registerScrollTerminal(host, term);

    // 2.5 lines a tap: 2, then the carried half makes 3.
    scrollContentForKey(root, key('ArrowDown'));
    expect(term.scrollLines).toHaveBeenLastCalledWith(2);
    scrollContentForKey(root, key('ArrowDown', { repeat: true } as Partial<KeyboardEvent>));
    expect(term.scrollLines).toHaveBeenLastCalledWith(3);
    scrollContentForKey(root, key('PageUp'));
    expect(term.scrollLines).toHaveBeenLastCalledWith(-23);

    unregister();
    term.scrollLines.mockClear();
    scrollContentForKey(root, key('ArrowDown'));
    expect(term.scrollLines).not.toHaveBeenCalled();
  });

  it('a held arrow speeds up along the hold curve, and a new press starts over', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const root = document.createElement('main');
      const big = scroller(400);
      root.append(big);
      const steps = () => (big.scrollBy as ReturnType<typeof vi.fn>).mock.calls.map(([o]) => (o as ScrollToOptions).top);
      scrollContentForKey(root, key('ArrowDown'));
      vi.advanceTimersByTime(HOLD_RAMP_MS / 2);
      scrollContentForKey(root, key('ArrowDown', { repeat: true } as Partial<KeyboardEvent>));
      vi.advanceTimersByTime(HOLD_RAMP_MS * 2);
      scrollContentForKey(root, key('ArrowDown', { repeat: true } as Partial<KeyboardEvent>));
      scrollContentForKey(root, key('ArrowDown'));
      expect(steps()).toEqual([
        ARROW_SCROLL_PX,
        Math.round(ARROW_SCROLL_PX * holdBoost(HOLD_RAMP_MS / 2)),
        ARROW_SCROLL_PX * HOLD_MAX_BOOST,
        ARROW_SCROLL_PX,
      ]);
      expect((big.scrollBy as ReturnType<typeof vi.fn>).mock.calls[1]![0]).toMatchObject({ behavior: 'auto' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('the curve eases in from 1× to the cap', () => {
    expect(holdBoost(0)).toBe(1);
    expect(holdBoost(HOLD_RAMP_MS / 2)).toBeCloseTo(1 + (HOLD_MAX_BOOST - 1) / 4);
    expect(holdBoost(HOLD_RAMP_MS)).toBe(HOLD_MAX_BOOST);
    expect(holdBoost(HOLD_RAMP_MS * 10)).toBe(HOLD_MAX_BOOST);
  });

  it('leaves modified and other keys alone', () => {
    const root = document.createElement('main');
    const big = scroller(400);
    root.append(big);
    expect(scrollContentForKey(root, key('ArrowDown', { shiftKey: true }))).toBe(false);
    expect(scrollContentForKey(root, key('ArrowDown', { metaKey: true }))).toBe(false);
    expect(scrollContentForKey(root, key('j'))).toBe(false);
    expect(big.scrollBy).not.toHaveBeenCalled();
  });
});

describe('mayTakeFocus', () => {
  function layout() {
    document.body.innerHTML = `
      <div data-testid="tws-strip"><button id="tab">Tab</button></div>
      <div data-testid="tws-browser-list" tabindex="-1" id="list"></div>
      <input id="elsewhere" />
      <main data-testid="tws-content" tabindex="-1"><textarea id="field"></textarea></main>`;
    return document.querySelector<HTMLElement>('main')!;
  }

  it('takes focus from the page, the tab strip and the browser list', () => {
    const host = layout();
    expect(mayTakeFocus(host)).toBe(true);
    document.getElementById('tab')!.focus();
    expect(mayTakeFocus(host)).toBe(true);
    document.getElementById('list')!.focus();
    expect(mayTakeFocus(host)).toBe(true);
  });

  it('never from a field in the new tab or elsewhere on the page', () => {
    const host = layout();
    document.getElementById('field')!.focus();
    expect(mayTakeFocus(host)).toBe(false);
    document.getElementById('elsewhere')!.focus();
    expect(mayTakeFocus(host)).toBe(false);
  });
});
