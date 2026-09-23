// @vitest-environment jsdom
/**
 * SKILLS TAB BY THEIR OWN FACTS, not by lifecycle (task 01a0ccd9: "i dont
 * want this status based thing on skills"). A skill is seeded `done`, so the
 * ruled four showed three empty tabs and a Done holding everything.
 *
 * The skill tabs OVERLAP (a missing skill can still be equipped), which is
 * the part the panel has to get right: the kind total is All's own count, not
 * the sum of four bands, and there is no footer line pretending to be a
 * breakdown that adds up.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { ActionContext, ListPageState, QueryFilter } from '../domain';
import { FIXTURE_SPACE_ID } from '../fixtures';
import { EntityListPanel } from './index';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

/** Server totals per tab, keyed by the one fact each skill tab narrows on. */
function totalFor(filter: QueryFilter): number {
  if (filter.skillMissing) return 2;
  if (filter.skillEquipped === true) return 3;
  if (filter.skillEquipped === false) return 9;
  return 12;
}

function mount() {
  const asks: QueryFilter[] = [];
  const view = render(
    <EntityListPanel
      kind="skill"
      rowsFor={(filter) => {
        asks.push(filter);
        return [];
      }}
      pageStateOf={(filter): ListPageState => ({ hasMore: false, loading: false, total: totalFor(filter) })}
      ctx={ctx}
    />,
  );
  return { ...view, asks };
}

describe('the skill list panel', () => {
  it('draws All · Equipped · Not equipped · Missing files, and no lifecycle tab', () => {
    const { getAllByRole } = mount();
    const tabs = getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['All12', 'Equipped3', 'Not equipped9', 'Missing files2']);
  });

  it('totals the kind from All, not the sum of overlapping tabs, and draws no footer', () => {
    const { getByTestId, queryByTestId } = mount();
    expect(getByTestId('kind-total').textContent).toBe('12');
    expect(queryByTestId('list-footer')).toBeNull();
  });

  it('opens on All and asks the seam for the equipped band when that tab is picked', () => {
    const { getAllByRole, asks } = mount();
    expect(getAllByRole('tab')[0]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(getAllByRole('tab')[1]!);
    expect(asks.some((f) => f.skillEquipped === true && f.category === undefined)).toBe(true);
  });
});
