import { describe, expect, it } from 'vitest';
import { placePopover } from './anchoredPopover';

/* Task 01a112b9: sideways popovers (the rail's Needs-you / Status, the action
   strip's forms popover) must stay inside the viewport on every edge, and must
   write CSS lengths that survive the shell's `zoom`. */
const VP = { width: 1440, height: 900 };
const at = (top: number, left: number, size = 30) => ({ top, bottom: top + size, left, right: left + size });

describe('placePopover', () => {
  it('opens to the right of the anchor, bottom-aligned, when there is room', () => {
    const p = placePopover(at(500, 20), { width: 400, height: 200 }, VP, 1, { side: 'right', align: 'end', gap: 8 });
    expect(p).toMatchObject({ left: 58, top: 330, side: 'right' });
  });

  it('opens to the left of the anchor, top-aligned', () => {
    const p = placePopover(at(276, 1400), { width: 520, height: 300 }, VP, 1, { side: 'left', align: 'start', gap: 14 });
    expect(p).toMatchObject({ left: 1400 - 14 - 520, top: 276, side: 'left' });
  });

  it('pushes a top-aligned popover up instead of past the bottom edge', () => {
    const p = placePopover(at(276, 1060), { width: 520, height: 400 }, { width: 1100, height: 520 }, 1, { side: 'left', align: 'start' });
    expect(p.top + 400).toBeLessThanOrEqual(520 - 8);
    expect(p.top).toBe(520 - 8 - 400);
  });

  it('never lets a bottom-aligned popover leave through the top edge', () => {
    const p = placePopover(at(60, 20), { width: 400, height: 300 }, { width: 900, height: 420 }, 1, { side: 'right', align: 'end' });
    expect(p.top).toBe(8);
  });

  it('caps the height at the viewport so a tall form scrolls inside it', () => {
    const p = placePopover(at(100, 1060), { width: 520, height: 2000 }, { width: 1100, height: 520 }, 1, { side: 'left', align: 'start' });
    expect(p.maxHeight).toBe(520 - 16);
    expect(p.top).toBe(8);
  });

  it('flips to the other side when its own side has no room, and clamps horizontally', () => {
    const flipped = placePopover(at(100, 20), { width: 400, height: 100 }, VP, 1, { side: 'left', align: 'start' });
    expect(flipped.side).toBe('right');
    expect(flipped.left).toBeGreaterThanOrEqual(8);
    const narrow = placePopover(at(100, 300), { width: 520, height: 100 }, { width: 560, height: 600 }, 1, { side: 'left', align: 'start' });
    expect(narrow.left).toBeGreaterThanOrEqual(8);
    expect(narrow.left + Math.min(520, narrow.maxWidth)).toBeLessThanOrEqual(560 - 8);
  });

  it('measures in screen px and writes CSS px: divides by the host zoom', () => {
    // Under zoom 1.1 a fixed `left: 60px` lands at 66 screen px; the rail edge is at 57.2.
    const p = placePopover({ top: 520, bottom: 561, left: 6, right: 57.2 }, { width: 433, height: 135 }, VP, 1.1, { side: 'right', align: 'end', gap: 8 });
    expect(p.left * 1.1).toBeCloseTo(57.2 + 8 * 1.1);
    expect((p.top * 1.1) + 135).toBeCloseTo(561);
  });
});
