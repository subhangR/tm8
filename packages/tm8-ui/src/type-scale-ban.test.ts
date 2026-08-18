/**
 * TYPE THROUGH TOKENS — hex-ban's sibling, for the chat surfaces' font sizes.
 *
 * Colour has been guard-enforced since hex-ban; type never was, and the two
 * chat stylesheets accumulated ~130 hardcoded px sizes across nineteen
 * distinct values, nine of them off the scale entirely (8.5, 9.5, 10.5,
 * 11.5, 12.5, 13.5 …). The 2026-08-18 sweep mapped every one onto the
 * `--pn-fs-*` scale (extended deliberately with `fine: 10px` and `tick: 9px`
 * for the chrome band the scale never covered); this guard keeps them there.
 *
 * THE PINNED SURVIVORS, each with a reason a token cannot express:
 * - `.tch-xgraph__*` — SVG canvas text: the size is plot geometry, tuned to
 *   the node box it must fit, not typography (hex-ban's terminal exclusion,
 *   same logic).
 * - two 20px pictographic glyphs (`.chs-refusal__glyph`,
 *   `.tch-asset__file > span`) — icon boxes drawn with a character; the
 *   scale has 18 and 22, and either direction visibly resizes the icon.
 * - the mobile `.tch-find` 16px — iOS Safari's zoom-on-focus floor, a
 *   FUNCTIONAL constant (the comment above it in chat-home.css measures the
 *   failure), never a typographic choice.
 *
 * The inventory may SHRINK, never grow: removing a pin is progress, adding
 * one is a decision this file forces you to write down.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const HERE = new URL('.', import.meta.url).pathname;

const GUARDED: readonly string[] = [
  'chat-home/chat-home.css',
  'channel-screen/channel-screen.css',
];

const PINNED: readonly { file: string; marker: string; why: string }[] = [
  { file: 'chat-home/chat-home.css', marker: '.tch-xgraph__node-label', why: 'SVG canvas text — geometry, not type' },
  { file: 'chat-home/chat-home.css', marker: '.tch-xgraph__node-kind', why: 'SVG canvas text — geometry, not type' },
  { file: 'chat-home/chat-home.css', marker: '.tch-asset__file > span', why: '20px pictographic glyph box' },
  { file: 'chat-home/chat-home.css', marker: 'mobile-frame .tch-find', why: "iOS zoom-on-focus floor — functional 16px" },
  { file: 'channel-screen/channel-screen.css', marker: '.chs-refusal__glyph', why: '20px pictographic glyph box' },
];

const PX_SIZE = /(?:font-size|font): ?[0-9.]+px/;

describe('chat font sizes resolve through the type scale', () => {
  it.each(GUARDED.map((f) => [f]))('%s declares no un-pinned px font size', (file) => {
    const lines = readFileSync(`${HERE}${file}`, 'utf8').split('\n');
    const pinsHere = PINNED.filter((p) => p.file === file);
    const offenders: string[] = [];
    let pinnedBlock: string | null = null;
    for (const [index, line] of lines.entries()) {
      const opensPin = pinsHere.find((p) => line.includes(p.marker));
      if (opensPin) pinnedBlock = opensPin.marker;
      const pinned = pinnedBlock !== null;
      if (pinnedBlock !== null && line.includes('}')) pinnedBlock = null;
      if (PX_SIZE.test(line) && !pinned) offenders.push(`${file}:${index + 1} ${line.trim()}`);
    }
    expect(
      offenders,
      'a px font size outside the pinned inventory — map it onto --pn-fs-* ' +
        '(or add a pin WITH its reason, which this test makes a written decision)',
    ).toEqual([]);
  });

  it('every pin still exists — a stale pin is a hole in the guard', () => {
    for (const pin of PINNED) {
      expect(
        readFileSync(`${HERE}${pin.file}`, 'utf8').includes(pin.marker),
        `${pin.file} no longer contains ${pin.marker} (${pin.why}) — delete the pin`,
      ).toBe(true);
    }
  });
});
