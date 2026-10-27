// @vitest-environment jsdom
/**
 * The story page opens on the graph (#36, #37): a one-row header, the
 * description and stat strip folded behind "details", and a trail-cut note
 * only when the hops on show reach the level the cut landed on.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import { StoryPage } from './StoryPage';
import { STORY_FIXTURE } from './fixture';
import type { StoryView } from './model';

const cut = (view: StoryView): StoryView => ({
  ...view,
  state: { ...view.state, truncated: true },
  page: { ...view.page, follow: { ...view.page.follow, truncated: true } },
});

describe('StoryPage header', () => {
  it('opens with the graph and the details folded', () => {
    const { getByTestId, queryByTestId, getByLabelText } = render(<StoryPage view={STORY_FIXTURE} actions={{}} />);
    const header = getByTestId('story-header');
    expect(within(header).getByText(STORY_FIXTURE.title)).toBeTruthy();
    expect(queryByTestId('story-stats')).toBeNull();
    expect(header.querySelector('.sty-lede')).toBeNull();
    expect(getByLabelText('The graph').closest('.sty-graphbox')).toBeTruthy();

    const toggle = within(header).getByRole('button', { name: /details/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(queryByTestId('story-stats')).toBeTruthy();
    expect(header.querySelector('.sty-herometa')).toBeTruthy();
  });

  it('warns of a cut trail only when it was cut, naming the level', () => {
    const plain = render(<StoryPage view={STORY_FIXTURE} actions={{}} />);
    expect(plain.container.querySelector('.stg-count--warn')).toBeNull();
    plain.unmount();

    const view = cut(STORY_FIXTURE);
    const deepest = view.page.nodes.reduce((d, n) => Math.max(d, n.depth), 0);
    const { container } = render(<StoryPage view={view} actions={{}} />);
    const warn = container.querySelector('.stg-count--warn');
    expect(warn?.textContent).toContain('trail cut at 500 rows');
    expect(warn?.textContent).toContain(`${deepest}`);
  });

  it('drops the note when the hops on show stop above the cut', () => {
    const view = cut(STORY_FIXTURE);
    const deepest = view.page.nodes.reduce((d, n) => Math.max(d, n.depth), 0);
    expect(deepest).toBeGreaterThan(1);
    const { container } = render(
      <StoryPage view={view} actions={{}} filterRoute={{ hops: 1, kinds: null, set: () => {} }} />,
    );
    expect(container.querySelector('.stg-count--warn')).toBeNull();
  });
});
