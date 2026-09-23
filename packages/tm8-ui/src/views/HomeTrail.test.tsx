// @vitest-environment jsdom
/**
 * The Trail strip (task 01a0c864 U3/U5/U9, D4/D6).
 *
 * What is pinned here is the part of the design that is only visible in the
 * RENDER: the hop marks are derived from the data rather than stored, the
 * cursor — not the top — is the current place, and the collapse never hides
 * the forward half without leaving a way to reach it.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';

import { HomeTrail } from './HomeTrail';

const TITLES: Record<string, string> = {
  a: 'Atelier',
  b: 'Bind the lane',
  c: 'Close the gap',
  d: 'Draft the note',
  e: 'Even so',
  f: 'Fold it in',
};

function titleOf(id: string) {
  return TITLES[id] ? { title: TITLES[id]!, kind: 'task' } : null;
}

/** Hierarchy everywhere unless a case says otherwise: a→b→c→d→e→f. */
const CHAIN: Record<string, string | null> = { a: null, b: 'a', c: 'b', d: 'c', e: 'd', f: 'e' };

function setup(
  trail: string[],
  cursor: number,
  parents: Record<string, string | null | undefined> = CHAIN,
  onCrumb = vi.fn(),
) {
  const view = render(
    <HomeTrail
      trail={trail}
      cursor={cursor}
      label="Trail"
      titleOf={titleOf}
      parentOf={(id) => parents[id]}
      onCrumb={onCrumb}
    />,
  );
  return { view, onCrumb };
}

/** The separator glyphs actually painted, in order. */
function marks(container: HTMLElement): string[] {
  return [...container.querySelectorAll('nav.hp-trail > .hp-trail__seg > .hp-trail__sep')].map(
    (el) => el.textContent ?? '',
  );
}

describe('the Trail strip', () => {
  it('earns its row only when there is somewhere else to be', () => {
    const { view } = setup(['a'], 0);
    expect(view.container.querySelector('nav.hp-trail')).toBeNull();
  });

  it('DERIVES the hop marks: › for a parent step, → for a connection step (D4)', () => {
    // `c`'s parent is `b`, so a › b. `d`'s parent is NOT `c` — it was reached
    // through a connection — so b → c.
    const { view } = setup(['a', 'b', 'd'], 2, { a: null, b: 'a', d: 'zz' });
    expect(marks(view.container)).toEqual(['›', '→']);
  });

  it('renders NEUTRAL while the parent chain is not yet cached — never a guess', () => {
    // `undefined` is "the read has not landed", which is not the same answer
    // as `null` ("no parent"). It must not paint a connection mark it would
    // later have to take back.
    const { view } = setup(['a', 'b'], 1, { a: null, b: undefined });
    expect(marks(view.container)).toEqual(['›']);
  });

  it('the CURSOR is the current place, not the top', () => {
    const { view } = setup(['a', 'b', 'c'], 1);
    const here = view.container.querySelector('.hp-trail__here');
    expect(here?.textContent).toContain('Bind the lane');
    // …and the top is not rendered as current.
    expect(view.container.textContent).not.toContain('Close the gap');
  });

  it('a crumb SEEKS — it hands back the id and shortens nothing itself', () => {
    const { view, onCrumb } = setup(['a', 'b', 'c'], 2);
    fireEvent.click(view.getByRole('button', { name: /Atelier/ }));
    expect(onCrumb).toHaveBeenCalledWith('a');
  });

  it('collapses the middle to one …, keeping root › parent › current (U9/D6)', () => {
    const { view } = setup(['a', 'b', 'c', 'd', 'e'], 4);
    expect(view.container.textContent).toContain('Atelier'); // root
    expect(view.container.textContent).toContain('Draft the note'); // parent
    expect(view.container.textContent).toContain('Even so'); // current
    expect(view.container.textContent).not.toContain('Bind the lane'); // hidden
    expect(view.getAllByRole('button', { name: 'Jump to a hop on the trail' })).toHaveLength(1);
  });

  it('the jump menu lists EVERY hop, the cursor current and the forward half dimmed', () => {
    const { view, onCrumb } = setup(['a', 'b', 'c', 'd', 'e'], 2);
    fireEvent.click(view.getAllByRole('button', { name: 'Jump to a hop on the trail' })[0]!);
    const menu = view.getByTestId('hp-trail-jump');
    const items = within(menu).getAllByRole('menuitem');
    expect(items).toHaveLength(5);
    expect(items[2]!.getAttribute('aria-current')).toBe('location');
    // Ahead of the cursor: listed, and marked as ahead rather than hidden —
    // this is where "keep forward" becomes visible.
    expect(items.filter((el) => el.hasAttribute('data-ahead'))).toHaveLength(2);
    expect(items[3]!.hasAttribute('data-ahead')).toBe(true);

    fireEvent.click(items[4]!);
    expect(onCrumb).toHaveBeenCalledWith('e');
  });

  it('a Trail walked back to its root still SAYS there is something ahead', () => {
    // The trailing `…` is the only thing on this screen that says so. Without
    // it "keep forward" would be true and invisible.
    const { view } = setup(['a', 'b', 'c'], 0);
    expect(view.container.querySelector('.hp-trail__here')?.textContent).toContain('Atelier');
    expect(view.getAllByRole('button', { name: 'Jump to a hop on the trail' })).toHaveLength(1);
  });
});
