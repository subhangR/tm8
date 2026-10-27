// @vitest-environment jsdom
/**
 * Issue #35: the story graph opens with no edges drawn; an edge-type filter
 * lists the types present (with counts) and toggling one draws or hides those
 * edges. The selection is shared across stories and kept in localStorage.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';

import { STORY_FIXTURE } from '../fixture';
import { StoryGraph } from './StoryGraph';
import { EDGE_TYPES_STORAGE_KEY, edgeTypeCounts, resetEdgeTypesForTest } from './edge-filter';
import { layoutStoryGraph } from './layout';

beforeEach(() => {
  window.localStorage.clear();
  resetEdgeTypesForTest();
});
afterEach(cleanup);

const drawn = (c: HTMLElement) => c.querySelectorAll('path.stg-e').length;

describe('story graph edge-type filter', () => {
  it('opens with no edges drawn', () => {
    const { container } = render(<StoryGraph view={STORY_FIXTURE} actions={{} as never} />);
    expect(drawn(container)).toBe(0);
  });

  it('lists the edge types present with counts, and toggling shows / hides them', () => {
    const counts = edgeTypeCounts(layoutStoryGraph(STORY_FIXTURE, Date.now(), 3).edges);
    expect(counts.length).toBeGreaterThan(1);
    const { container, getByRole } = render(<StoryGraph view={STORY_FIXTURE} actions={{} as never} />);
    const group = getByRole('group', { name: 'Edge types shown' });
    const first = counts[0]!;
    const chip = within(group).getByRole('button', { name: new RegExp(`^${first.type.replace(/_/g, ' ')}\\s*${first.count}$`) });
    expect(chip.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    const shown = drawn(container);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(first.count);
    expect(JSON.parse(window.localStorage.getItem(EDGE_TYPES_STORAGE_KEY)!)).toEqual([first.type]);

    fireEvent.click(chip);
    expect(drawn(container)).toBe(0);
  });

  it('keeps the selection across remounts (navigating away and back)', () => {
    const first = render(<StoryGraph view={STORY_FIXTURE} actions={{} as never} />);
    fireEvent.click(within(first.getByRole('group', { name: 'Edge types shown' })).getByRole('button', { name: 'all' }));
    const all = drawn(first.container);
    expect(all).toBeGreaterThan(0);
    first.unmount();

    resetEdgeTypesForTest();
    const again = render(<StoryGraph view={STORY_FIXTURE} actions={{} as never} />);
    expect(drawn(again.container)).toBe(all);
  });
});
