// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { FIXTURE_SPACE_ID } from '../fixtures';
import { createFixtureSeam } from '../data';
import { CraftsNav } from './CraftsNav';
import { fixtureCraftSource, type CraftPageRow } from './craft-source';
import { fixtureCraftsSource } from './crafts-source';

const SPACE = FIXTURE_SPACE_ID as never;
const A = 'craft-a' as EntityId;
const B = 'craft-b' as EntityId;
const page = (id: string, title: string, kind = 'doc'): CraftPageRow => ({
  id: id as EntityId, kind, title, version: 1, activityAt: new Date(0).toISOString(), position: null, running: false,
});

afterEach(cleanup);

function mount(craftId?: EntityId, pageId?: EntityId) {
  const crafts = fixtureCraftsSource([
    { id: A, title: 'Launch plan', pages: [{ kind: 'doc' }, { kind: 'graph' }] },
    { id: B, title: 'Pricing', pages: [] },
  ]);
  const source = fixtureCraftSource(createFixtureSeam(), SPACE, [
    { id: A, title: 'Launch plan', pages: [page('p1', 'Brief'), page('p2', 'Flow', 'graph')] },
    { id: B, title: 'Pricing' },
  ]);
  const onNavigate = vi.fn();
  const view = render(<CraftsNav crafts={crafts} source={source} craftId={craftId} pageId={pageId} onNavigate={onNavigate} />);
  return { view, onNavigate };
}

const rows = (nav: HTMLElement) => [...nav.querySelectorAll('.frame-nav__list .frame-nav__row')].map((n) => n.querySelector('.frame-nav__label')?.textContent);

describe("Craft's left panel", () => {
  it('lists the crafts, and the open craft with its pages under it', async () => {
    const { view } = mount(A, 'p2' as EntityId);
    const nav = view.getByRole('navigation', { name: 'Crafts' });
    await waitFor(() => expect(rows(nav)).toEqual(['Launch plan', 'Brief', 'Flow', 'Pricing']));
    expect(within(nav).getByRole('button', { name: /Flow/ }).getAttribute('aria-current')).toBe('page');
  });

  it('opens a craft, a page, and the home', async () => {
    const { view, onNavigate } = mount(A);
    const nav = view.getByRole('navigation', { name: 'Crafts' });
    await waitFor(() => expect(rows(nav)).toContain('Brief'));
    /* No page in the route: the first page is the one showing. */
    expect(within(nav).getByRole('button', { name: /Brief/ }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(within(nav).getByRole('button', { name: /Pricing/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ craftId: B });
    fireEvent.click(within(nav).getByRole('button', { name: /Flow/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ craftId: A, pageId: 'p2' });
    fireEvent.click(within(nav).getByRole('button', { name: 'All crafts' }));
    expect(onNavigate).toHaveBeenLastCalledWith({});
  });

  it('filters by name', async () => {
    const { view } = mount();
    const nav = view.getByRole('navigation', { name: 'Crafts' });
    await waitFor(() => expect(rows(nav)).toEqual(['Launch plan', 'Pricing']));
    fireEvent.change(within(nav).getByRole('searchbox'), { target: { value: 'pri' } });
    expect(rows(nav)).toEqual(['Pricing']);
  });
});
