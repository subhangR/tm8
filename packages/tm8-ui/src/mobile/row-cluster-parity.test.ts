/**
 * THREE ANATOMIES CARRY THE ROW-ACTION CLUSTER, AND ALL THREE MUST HIDE IT.
 *
 * `panels.css` states the shape's membership in prose — "Member 3 of 3", "three
 * containers carry this pattern and all three now carry both signals; a fourth
 * would be a defect, and the way to know is to count them" — and then nothing
 * counted them. The session tile is what that cost: 7j amended `.pn-tt__actions`
 * and 7j' amended `.lp__rowactions`, while `.pn-st__actions` kept the
 * pinned-open treatment for as long as the phone shell has existed, putting six
 * controls on an opaque backing over every title in the Sessions list.
 *
 * So this is the count, as a test. It asserts the two halves of the amendment
 * that actually carry it — the closed row drops every child but its opener, and
 * the container comes out of the float — for each member by name.
 *
 * NAMED MEMBERS, NOT A DISCOVERED SET. A regex that harvested "every cluster
 * class in the file" would pass the moment a fourth anatomy forgot the rule,
 * because the thing it forgot is also what would keep it out of the set. The
 * list is written down here precisely so that adding an anatomy is a decision
 * someone makes in this file rather than one the tooling makes silently.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./mobile-screens.css', import.meta.url), 'utf8');

/**
 * THE UN-FLOAT IS NOT ALL IN ONE FILE, and that is a fact about the codebase
 * rather than a convenience here: the task tile was put in flow by its own
 * stylesheet long before 7j was written (7j′ says so in as many words — "the
 * task tile was already put in flow by `maestro-task-tile.css`"), while the
 * other two are un-floated by the amendment itself. So the second assertion
 * reads BOTH sheets. Asking only `mobile-screens.css` would fail the one
 * anatomy that has been correct the longest.
 */
const phoneCss =
  css + readFileSync(new URL('../panels/list/maestro-task-tile.css', import.meta.url), 'utf8');

/** `tile` is the row, `cluster` its action container, `opener` the one control a closed row keeps. */
const ANATOMIES = [
  { name: 'task tile (7j)', tile: '.pn-tt', cluster: '.pn-tt__actions', opener: '.pn-tt__ind' },
  { name: 'standard tile (7j′)', tile: '.lp__tile', cluster: '.lp__rowactions', opener: '.lp__rowaction--ind' },
  { name: 'session tile (7j″)', tile: '.pn-st', cluster: '.pn-st__actions', opener: '.pn-st__btn--ind' },
] as const;

describe('phone row-action clusters', () => {
  it.each(ANATOMIES)('$name drops every child but its opener while the row is closed', ({ tile, cluster, opener }) => {
    expect(css).toContain(
      `.cv2-root[data-shell='mobile'] ${tile}:not([data-details='open']) ${cluster} > *:not(${opener})`,
    );
  });

  it.each(ANATOMIES)('$name un-floats its cluster, so the lone opener cannot cover the row', ({ cluster }) => {
    /* The float plus an opaque backing is what put these clusters ON TOP OF the
       title and the meta rather than beside them; un-floating is the half of the
       amendment a reader actually sees. Asserted as "this selector appears, and
       somewhere after it `position: static`" rather than by parsing the block,
       which is all a text test can honestly claim. */
    const marker = `.cv2-root[data-shell='mobile'] ${cluster}`;
    expect(phoneCss.includes(marker), `${cluster} has no phone rule at all`).toBe(true);
    /* Every phone rule for this container, concatenated — the declaration may
       sit in any one of them, and on the task tile it sits in a different file
       from the rest of the amendment. */
    const blocks = phoneCss
      .split(marker)
      .slice(1)
      .map((rest) => rest.slice(0, 400))
      .join('\n');
    expect(blocks).toMatch(/position:\s*static/);
  });

  it('guards the guard: the file really is the stylesheet these rules live in', () => {
    expect(css.length).toBeGreaterThan(1_000);
    expect(css).toContain("data-shell='mobile'");
  });
});
