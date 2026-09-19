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
