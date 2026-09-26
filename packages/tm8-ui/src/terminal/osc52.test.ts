// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';

import { OSC52_GESTURE_WINDOW_MS, attachOsc52Clipboard, decodeOsc52 } from './osc52';

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
/** The exact shape Claude Code emits: `ESC ] 52 ; c ; <base64> BEL`. */
const osc52 = (text: string) => `\x1b]52;c;${b64(text)}\x07`;

describe('decodeOsc52', () => {
  it('decodes a UTF-8 payload for any selection target', () => {
    expect(decodeOsc52(`c;${b64('héllo — wörld')}`)).toBe('héllo — wörld');
    expect(decodeOsc52(`;${b64('default target')}`)).toBe('default target');
  });

  it('never answers a clipboard READ request', () => {
    expect(decodeOsc52('c;?')).toBeNull();
  });

  it('ignores clear requests and garbage', () => {
    expect(decodeOsc52('c;')).toBeNull();
    expect(decodeOsc52('no-separator')).toBeNull();
    expect(decodeOsc52('c;!!!not base64')).toBeNull();
    expect(decodeOsc52(`c;${btoa('\xff\xfe')}`)).toBeNull(); // not UTF-8
  });
});

// The terminal is never open()ed: jsdom has no matchMedia, and the OSC
// parser this exercises does not need a renderer.
describe('attachOsc52Clipboard (real xterm parser)', () => {
  const terms: Terminal[] = [];
  afterEach(() => {
    for (const term of terms.splice(0)) term.dispose();
    document.body.innerHTML = '';
  });

  function setup(opts: { readOnly?: boolean; replaying?: boolean } = {}) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const term = new Terminal({ allowProposedApi: true });
    terms.push(term);
    let clock = 1_000_000;
    const copy = vi.fn();
    const handle = attachOsc52Clipboard(term, {
      element: container,
      isReadOnly: () => opts.readOnly ?? false,
      isReplaying: () => opts.replaying ?? false,
      now: () => clock,
      copy,
    });
    const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
    const press = () => container.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    const advance = (ms: number) => {
      clock += ms;
    };
    return { term, copy, handle, write, press, advance };
  }

  it('copies what the agent sends right after the viewer selects in the terminal', async () => {
    const { copy, write, press } = setup();
    press();
    await write(osc52('selected text'));
    expect(copy).toHaveBeenCalledWith('selected text');
  });

  it('refuses a copy with no recent gesture in this terminal', async () => {
    const { copy, write, press, advance } = setup();
    await write(osc52('unprompted'));
    press();
    advance(OSC52_GESTURE_WINDOW_MS + 1);
    await write(osc52('stale'));
    expect(copy).not.toHaveBeenCalled();
  });

  it('a cancelled press does not lend the next page-wide pointerup to this terminal', async () => {
    const { copy, write, press, advance } = setup();
    press();
    window.dispatchEvent(new Event('pointercancel'));
    advance(OSC52_GESTURE_WINDOW_MS + 1);
    window.dispatchEvent(new Event('pointerup')); // a click somewhere else on the page
    await write(osc52('not asked for'));
    expect(copy).not.toHaveBeenCalled();
  });

  it('never copies for a read-only viewer or from replayed scrollback', async () => {
    for (const opts of [{ readOnly: true }, { replaying: true }]) {
      const { copy, write, press } = setup(opts);
      press();
      await write(osc52('x'));
      expect(copy).not.toHaveBeenCalled();
    }
  });

  it('stops listening once disposed', async () => {
    const { copy, write, press, handle } = setup();
    press(); // a gesture inside the window, so only the disposal can refuse
    handle.dispose();
    await write(osc52('after dispose'));
    expect(copy).not.toHaveBeenCalled();
  });
});
