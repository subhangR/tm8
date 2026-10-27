import type { Terminal } from '@xterm/xterm';

export type ScrollTerminal = Pick<Terminal, 'buffer' | 'rows' | 'scrollLines' | 'element' | 'modes'>;

/** Match desktop wheel behavior: TUIs own mouse scrolling, xterm owns history. */
export function scrollTerminalLines(term: ScrollTerminal, lines: number): boolean {
  if (!lines) return false;
  if (term.modes.mouseTrackingMode !== 'none' || term.buffer.active.type === 'alternate') {
    const screen = term.element?.querySelector('.xterm-screen');
    if (!screen) return false;
    const box = screen.getBoundingClientRect();
    // xterm emits one mouse report per wheel event, regardless of its delta.
    for (let i = 0; i < Math.abs(lines); i++) {
      screen.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaMode: WheelEvent.DOM_DELTA_LINE,
        deltaY: Math.sign(lines), clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
      }));
    }
    return true;
  }
  const { viewportY, baseY } = term.buffer.active;
  if ((lines < 0 && viewportY === 0) || (lines > 0 && viewportY === baseY)) return false;
  term.scrollLines(lines);
  return true;
}

/*
 * THE MOUNTED TERMINALS, by their host element — so a surface that does not
 * own a terminal (the Work tab's content, task 01a1156f) can scroll the one on
 * screen with the keyboard without reaching into React. Weak, so a host that
 * leaves the DOM takes its entry with it; LiveTerminal also unregisters.
 */
const mounted = new WeakMap<Element, ScrollTerminal>();

/** Register a terminal under its host; returns the unregister. */
export function registerScrollTerminal(host: Element, term: ScrollTerminal): () => void {
  mounted.set(host, term);
  return () => {
    if (mounted.get(host) === term) mounted.delete(host);
  };
}

/** The first VISIBLE registered terminal inside `root` (pooled, hidden ones have no box). */
export function visibleScrollTerminal(root: ParentNode): ScrollTerminal | null {
  for (const el of root.querySelectorAll<HTMLElement>('.xterm')) {
    if (el.getClientRects().length === 0) continue;
    for (let node: Element | null = el; node && node !== root; node = node.parentElement) {
      const term = mounted.get(node);
      if (term) return term;
    }
  }
  return null;
}
