// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installTerminalArrowScroll, shouldScrollTerminal } from './terminalArrowScroll';
import { registerScrollTarget } from '../../terminal/scrollTargets';

const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('shouldScrollTerminal', () => {
  it('takes arrows from the body and the tab strip, not from fields, lists or terminals', () => {
    document.body.innerHTML = `
      <div class="tws-strip" role="tablist"><div role="tab" tabindex="0" id="tab"></div></div>
      <input id="field" /><div role="listbox" tabindex="0" id="list"></div>
      <div class="xterm"><textarea id="xt"></textarea></div>`;
    const check = (id: string | null, key = 'ArrowDown', init: KeyboardEventInit = {}) => {
      let seen = false;
      const target = id ? document.getElementById(id)! : document.body;
      const listener = (e: KeyboardEvent) => (seen = shouldScrollTerminal(e));
      window.addEventListener('keydown', listener);
      press(target, key, init);
      window.removeEventListener('keydown', listener);
      return seen;
    };
    expect(check(null)).toBe(true);
    expect(check('tab', 'ArrowUp')).toBe(true);
    expect(check('tab', 'PageDown')).toBe(true);
    expect(check('field')).toBe(false);
    expect(check('list')).toBe(false);
    expect(check('xt')).toBe(false);
    expect(check('tab', ']')).toBe(false);
    expect(check('tab', 'ArrowDown', { shiftKey: true })).toBe(false);
  });
});

describe('installTerminalArrowScroll', () => {
  it('scrolls the terminal inside the Work content and never focuses it', () => {
    document.body.innerHTML = `<main data-testid="tws-content"><div id="term" class="xterm"></div></main>`;
    const element = document.getElementById('term')!;
    element.getClientRects = () => [{}] as unknown as DOMRectList;
    const scrollLines = vi.fn();
    const off = registerScrollTarget({
      element,
      rows: 40,
      scrollLines,
      modes: { mouseTrackingMode: 'none' },
      buffer: { active: { type: 'normal', viewportY: 10, baseY: 100 } },
    } as never);
    const remove = installTerminalArrowScroll();
    const down = press(document.body, 'ArrowDown');
    press(document.body, 'PageUp');
    expect(scrollLines).toHaveBeenNthCalledWith(1, 1);
    expect(scrollLines).toHaveBeenNthCalledWith(2, -20);
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.body);
    remove();
    off();
  });
});
