// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { FIXTURE_SPACE_ID } from '../fixtures';
import { createFixtureSeam } from '../data';
import { DesignsNav } from './DesignsNav';
import { fixtureDesignSource, type DesignPageRow } from './design-source';
import { fixtureDesignsSource } from './designs-source';

const SPACE = FIXTURE_SPACE_ID as never;
const A = 'design-a' as EntityId;
const B = 'design-b' as EntityId;
const page = (id: string, title: string, kind = 'doc'): DesignPageRow => ({
  id: id as EntityId, kind, title, version: 1, activityAt: new Date(0).toISOString(), position: null, running: false,
});

afterEach(cleanup);

function mount(designId?: EntityId, pageId?: EntityId) {
  const designs = fixtureDesignsSource([
    { id: A, title: 'Launch plan', pages: [{ kind: 'doc' }, { kind: 'graph' }] },
    { id: B, title: 'Pricing', pages: [] },
  ]);
  const source = fixtureDesignSource(createFixtureSeam(), SPACE, [
    { id: A, title: 'Launch plan', pages: [page('p1', 'Brief'), page('p2', 'Flow', 'graph')] },
    { id: B, title: 'Pricing' },
  ]);
  const onNavigate = vi.fn();
  const view = render(<DesignsNav designs={designs} source={source} designId={designId} pageId={pageId} onNavigate={onNavigate} />);
  return { view, onNavigate };
}

const rows = (nav: HTMLElement) => [...nav.querySelectorAll('.frame-nav__list .frame-nav__row')].map((n) => n.querySelector('.frame-nav__label')?.textContent);

describe("Design's left panel", () => {
  it('lists the designs, and the open design with its pages under it', async () => {
    const { view } = mount(A, 'p2' as EntityId);
    const nav = view.getByRole('navigation', { name: 'Designs' });
    await waitFor(() => expect(rows(nav)).toEqual(['Launch plan', 'Brief', 'Flow', 'Pricing']));
    expect(within(nav).getByRole('button', { name: /Flow/ }).getAttribute('aria-current')).toBe('page');
  });

  it('opens a design, a page, and the home', async () => {
    const { view, onNavigate } = mount(A);
    const nav = view.getByRole('navigation', { name: 'Designs' });
    await waitFor(() => expect(rows(nav)).toContain('Brief'));
    /* No page in the route: the first page is the one showing. */
    expect(within(nav).getByRole('button', { name: /Brief/ }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(within(nav).getByRole('button', { name: /Pricing/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ designId: B });
    fireEvent.click(within(nav).getByRole('button', { name: /Flow/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ designId: A, pageId: 'p2' });
    fireEvent.click(within(nav).getByRole('button', { name: 'All designs' }));
    expect(onNavigate).toHaveBeenLastCalledWith({});
  });

  it('filters by name', async () => {
    const { view } = mount();
    const nav = view.getByRole('navigation', { name: 'Designs' });
    await waitFor(() => expect(rows(nav)).toEqual(['Launch plan', 'Pricing']));
    fireEvent.change(within(nav).getByRole('searchbox'), { target: { value: 'pri' } });
    expect(rows(nav)).toEqual(['Pricing']);
  });
});
