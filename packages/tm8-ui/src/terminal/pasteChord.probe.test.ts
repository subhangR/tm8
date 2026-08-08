// @vitest-environment jsdom
/**
 * Mechanism proof for the Ctrl+V paste fix, against the REAL xterm module.
 *
 * The whole fix rests on one claim about xterm internals: returning `false`
 * from `attachCustomKeyEventHandler` returns from `_keyDown` BEFORE xterm
 * calls `preventDefault`, so the browser is left free to perform its own
 * paste. If that claim is wrong the fix is silently useless, so it is asserted
 * here rather than trusted.
 *
 * jsdom has no renderer and no PTY, so this asserts exactly the two observable
 * things that decide the outcome — whether the event was cancelled, and what
 * bytes xterm wanted to send — and nothing about pixels.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';

import { isTerminalPasteChord } from '../keyboard/contract';

// xterm's CoreBrowserService reads devicePixelRatio through matchMedia, which
// jsdom does not implement. Nothing under test depends on the value.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

function mount(applyFix: boolean) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const term = new Terminal({ rows: 8, cols: 40 });
  term.open(host);

  const pty: string[] = [];
  term.onData((d) => pty.push(d));

  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    if (applyFix && isTerminalPasteChord(event)) return false;
    return true;
  });

  dispose = () => {
    term.dispose();
    host.remove();
  };

  const textarea = host.querySelector('textarea');
  if (!textarea) throw new Error('xterm did not create its helper textarea');

  return {
    pty,
    press(init: Partial<KeyboardEventInit> & { key: string }) {
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        keyCode: init.key.toUpperCase().charCodeAt(0),
        ...init,
      } as KeyboardEventInit);
      textarea.dispatchEvent(event);
      return event;
    },
  };
}

describe('Ctrl+V reaches the browser, not the PTY', () => {
  it('WITHOUT the fix: xterm cancels Ctrl+V and encodes it as 0x16', () => {
    // This is the bug. A cancelled keydown means the browser never performs
    // its default paste, so no `paste` event is ever dispatched and the
    // terminal's clipboard handler cannot run.
    const t = mount(false);
    const event = t.press({ key: 'v', ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(t.pty.join('')).toBe('\x16');
  });

  it('WITH the fix: Ctrl+V is not cancelled and sends nothing to the PTY', () => {
    const t = mount(true);
    const event = t.press({ key: 'v', ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(t.pty.join('')).toBe('');
  });

  it('WITH the fix: Cmd+V is not cancelled either', () => {
    const t = mount(true);
    const event = t.press({ key: 'v', metaKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(t.pty.join('')).toBe('');
  });

  it('WITHOUT the fix: Ctrl+Shift+V and Cmd+V already escape xterm', () => {
    // Why the currently-deployed build is not a total loss: xterm's Ctrl+letter
    // branch requires !shiftKey, and its Mac branch only claims Cmd+A. Both
    // chords therefore fall through uncancelled today, which is what makes
    // "use Ctrl+Shift+V / Cmd+V" a real workaround before this ships.
    const shift = mount(false);
    const shiftEvent = shift.press({ key: 'V', ctrlKey: true, shiftKey: true });
    expect(shiftEvent.defaultPrevented).toBe(false);
    expect(shift.pty.join('')).toBe('');
    dispose?.();

    const meta = mount(false);
    const metaEvent = meta.press({ key: 'v', metaKey: true });
    expect(metaEvent.defaultPrevented).toBe(false);
    expect(meta.pty.join('')).toBe('');
  });

  it('does not disturb Ctrl+C — SIGINT still reaches the PTY', () => {
    const t = mount(true);
    const event = t.press({ key: 'c', ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(t.pty.join('')).toBe('\x03');
  });

  it('does not disturb a plain v', () => {
    const t = mount(true);
    t.press({ key: 'v' });
    expect(t.pty.join('')).toBe('v');
  });
});
