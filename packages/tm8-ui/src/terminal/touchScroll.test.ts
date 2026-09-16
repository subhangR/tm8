// @vitest-environment jsdom
/**
 * Touch-scroll tests.
 *
 * The load-bearing ones are the two "hand it back" cases: a horizontal drag and
 * an overscroll at either end must NOT call preventDefault, or the terminal
 * silently eats gestures that belong to the surrounding layout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { attachTouchScroll } from './touchScroll.js';

interface Host {
  container: HTMLElement;
  viewport: HTMLElement;
  detach: () => void;
}

/** A stand-in for xterm's DOM: jsdom never lays out, so sizes are defined. */
function makeHost(scrollHeight = 1000, clientHeight = 200): Host {
  const container = document.createElement('div');
  const viewport = document.createElement('div');
  viewport.className = 'xterm-viewport';
  container.appendChild(viewport);
  document.body.appendChild(container);

  Object.defineProperty(viewport, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(viewport, 'clientHeight', { value: clientHeight, configurable: true });
  let top = 0;
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, scrollHeight - clientHeight));
    },
  });

  return { container, viewport, detach: attachTouchScroll(container) };
}

function touch(x: number, y: number): Touch {
  return { clientX: x, clientY: y } as Touch;
}

function fire(
  el: HTMLElement,
  type: string,
  touches: Touch[],
  timeStamp = 0,
): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: type === 'touchmove' }) as TouchEvent;
  Object.defineProperty(event, 'touches', { value: touches });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  el.dispatchEvent(event);
  return event;
}

let host: Host;

beforeEach(() => {
  host = makeHost();
});

afterEach(() => {
  host.detach();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('attachTouchScroll', () => {
  it('scrolls the viewport on a vertical drag', () => {
    host.viewport.scrollTop = 500;
    fire(host.container, 'touchstart', [touch(50, 300)], 0);
    // Dragging the finger UP scrolls the content DOWN.
    fire(host.container, 'touchmove', [touch(50, 260)], 16);
    expect(host.viewport.scrollTop).toBe(540);
  });

  it('consumes the gesture it acted on', () => {
    host.viewport.scrollTop = 500;
    fire(host.container, 'touchstart', [touch(50, 300)], 0);
    const moved = fire(host.container, 'touchmove', [touch(50, 260)], 16);
    expect(moved.defaultPrevented).toBe(true);
  });

  it('ignores movement below the axis-lock threshold', () => {
    host.viewport.scrollTop = 500;
    fire(host.container, 'touchstart', [touch(50, 300)], 0);
    fire(host.container, 'touchmove', [touch(50, 297)], 16);
    expect(host.viewport.scrollTop).toBe(500);
  });

  it('leaves horizontal drags to the surrounding layout', () => {
    host.viewport.scrollTop = 500;
    fire(host.container, 'touchstart', [touch(50, 300)], 0);
    const moved = fire(host.container, 'touchmove', [touch(90, 303)], 16);
    expect(host.viewport.scrollTop).toBe(500);
    expect(moved.defaultPrevented).toBe(false);
    // The axis stays locked for the rest of the gesture.
    const later = fire(host.container, 'touchmove', [touch(90, 240)], 32);
    expect(host.viewport.scrollTop).toBe(500);
    expect(later.defaultPrevented).toBe(false);
  });

  it('hands overscroll back at the top of the scrollback', () => {
    host.viewport.scrollTop = 0;
    fire(host.container, 'touchstart', [touch(50, 300)], 0);
    const moved = fire(host.container, 'touchmove', [touch(50, 360)], 16);
    expect(host.viewport.scrollTop).toBe(0);
    expect(moved.defaultPrevented).toBe(false);
  });

  it('does nothing when there is no scrollback to move', () => {
    host.detach();
    host = makeHost(200, 200);
    fire(host.container, 'touchstart', [touch(50, 300)], 0);
    const moved = fire(host.container, 'touchmove', [touch(50, 240)], 16);
    expect(host.viewport.scrollTop).toBe(0);
    expect(moved.defaultPrevented).toBe(false);
  });

  it('ignores multi-touch gestures', () => {
    host.viewport.scrollTop = 500;
    fire(host.container, 'touchstart', [touch(50, 300), touch(80, 300)], 0);
    fire(host.container, 'touchmove', [touch(50, 240), touch(80, 240)], 16);
    expect(host.viewport.scrollTop).toBe(500);
  });

  it('coasts after the finger lifts and settles', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);

    host.viewport.scrollTop = 500;
    fire(host.container, 'touchstart', [touch(50, 300)], 0);
    fire(host.container, 'touchmove', [touch(50, 260)], 16);
    fire(host.container, 'touchend', [], 32);

    const afterDrag = host.viewport.scrollTop;
    expect(frames.length).toBe(1);
    // Drain the fling; it must terminate on its own rather than spin forever.
    for (let i = 0; i < 500 && frames.length > 0; i += 1) frames.shift()!(0);
    expect(frames.length).toBe(0);
    expect(host.viewport.scrollTop).toBeGreaterThan(afterDrag);
  });

  it('does not coast after a cancelled gesture', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);

    fire(host.container, 'touchstart', [touch(50, 300)], 0);
    fire(host.container, 'touchmove', [touch(50, 260)], 16);
    fire(host.container, 'touchcancel', [], 32);
    expect(frames.length).toBe(0);
  });

  it('stops listening once detached', () => {
    host.detach();
    host.viewport.scrollTop = 500;
    fire(host.container, 'touchstart', [touch(50, 300)], 0);
    fire(host.container, 'touchmove', [touch(50, 240)], 16);
    expect(host.viewport.scrollTop).toBe(500);
  });
});
