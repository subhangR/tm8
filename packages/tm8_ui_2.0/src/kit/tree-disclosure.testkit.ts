import { fireEvent } from '@testing-library/react';

/**
 * TEST HELPER — open a tree that now ships COLLAPSED.
 *
 * Every tree in this app starts shut (user ruling 2026-08-17, see
 * `useTreeDisclosure`), so a test that wants to assert something about a CHILD
 * row must first perform the gesture a viewer would. This exists so the four
 * suites that need it do not each re-author the disclosure control's selector:
 * the control is drawn by four different tiles, and the one thing they agree on
 * is the accessible-name grammar below.
 *
 * Not exported from `kit/index.ts` — it imports the testing library, and a
 * production import of this file would drag that into the bundle.
 */

/**
 * The accessible name every disclosure control composes:
 * `Expand|Collapse <title>, <n> child|children`. Shared by `MaestroTaskTile`,
 * `MaestroSessionTile`, `EntityListPanel`'s default tile and `EntityTree`.
 */
const DISCLOSURE_LABEL = /^(Expand|Collapse) .+, \d+ (child|children)$/;

/** Every disclosure control in this subtree, open or shut. */
export function disclosureControls(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[aria-label]')].filter((el) =>
    DISCLOSURE_LABEL.test(el.getAttribute('aria-label') ?? ''),
  );
}

/**
 * Click every shut control until none is left, so the whole hierarchy is on
 * screen. Iterative because opening a row reveals ITS children's controls,
 * which did not exist to be clicked on the previous pass. The bound is a
 * runaway guard, not a depth limit — a tree deeper than this in a test is
 * almost certainly a cycle.
 */
export function expandTree(container: HTMLElement, maxDepth = 12): void {
  for (let pass = 0; pass < maxDepth; pass += 1) {
    const shut = disclosureControls(container).filter(
      (el) => el.getAttribute('aria-expanded') === 'false',
    );
    if (shut.length === 0) return;
    for (const control of shut) fireEvent.click(control);
  }
  throw new Error(`expandTree: still finding closed rows after ${maxDepth} passes — cycle?`);
}
