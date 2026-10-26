// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';
import type { ActionContext, QueryFilter } from '../../domain';
import { FIXTURE_SPACE_ID, docLayoutSpec, storyAsAnEntity } from '../../fixtures';
import { EntityListPanel } from '../index';
import { TileProgressBar } from './TileProgressBar';
import { resetRowViewCache, writeHiddenFacets } from './row-view';

/**
 * A STORY ROW SAYS HOW FAR ALONG IT IS. The story list drew a title and a
 * status word; how many of its tasks were done was only on the story page.
 * The registry's `tile.progress` projects `taskProgress` — the hero's own
 * "N of M tasks done" — onto a small bar at the row's right edge.
 */

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const rowsFor =
  (rows: readonly EntitySummary[]) =>
  (_filter: QueryFilter): readonly EntitySummary[] =>
    rows;

function storyWith(
  id: string,
  title: string,
  tp: { work: number; done: number; inProgress?: number; blocked?: number },
): EntitySummary {
  if (storyAsAnEntity.state.kind !== 'story') throw new Error('fixture is not a story');
  const taskProgress = {
    work: tp.work,
    done: tp.done,
    inProgress: tp.inProgress ?? 0,
    blocked: tp.blocked ?? 0,
    toDo: tp.work - tp.done - (tp.inProgress ?? 0) - (tp.blocked ?? 0),
    cancelled: 0,
  };
  return {
    ...storyAsAnEntity,
    id,
    title,
    parentId: null,
    state: { ...storyAsAnEntity.state, taskProgress, childStoryCount: 0 },
  } as EntitySummary;
}

function tileTitled(container: HTMLElement, title: string): HTMLElement {
  const tile = [...container.querySelectorAll<HTMLElement>('[data-testid="list-tile"]')].find(
    (el) => el.querySelector('.lp__title')?.textContent === title,
  );
  if (!tile) throw new Error(`no tile titled ${title}`);
  return tile;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetRowViewCache();
});

describe('story progress on the list tile', () => {
  it('draws done-of-total in the badge slot, at the right of the title', () => {
    const { container } = render(
      <EntityListPanel
        kind="story"
        rowsFor={rowsFor([storyWith('s-1', 'Halfway', { work: 8, done: 3, inProgress: 2, blocked: 1 })])}
        ctx={ctx}
      />,
    );
    const tile = tileTitled(container, 'Halfway');
    const bar = tile.querySelector<HTMLElement>('[data-testid="tile-progress"]');
    expect(bar).not.toBeNull();
    // In the right-hand badge slot, not the leading icon.
    expect(bar?.closest('.lp__badges')).not.toBeNull();
    expect(bar?.getAttribute('aria-label')).toBe('3 of 8 tasks done · 2 in progress · 1 blocked');
    expect(bar?.querySelector('.lp__progress-figure')?.textContent).toBe('3/8');
    expect(bar?.querySelector<HTMLElement>('.lp__progress-seg--done')?.style.width).toBe('37.5%');
    expect(bar?.querySelector<HTMLElement>('.lp__progress-seg--active')?.style.width).toBe('25%');
    expect(bar?.querySelector<HTMLElement>('.lp__progress-seg--blocked')?.style.width).toBe('12.5%');
  });

  it('a story with no tasks draws nothing rather than an empty bar', () => {
    const { container } = render(
      <EntityListPanel kind="story" rowsFor={rowsFor([storyWith('s-0', 'Empty', { work: 0, done: 0 })])} ctx={ctx} />,
    );
    expect(tileTitled(container, 'Empty').querySelector('[data-testid="tile-progress"]')).toBeNull();
  });

  it('a finished story is marked done', () => {
    const { container } = render(
      <EntityListPanel kind="story" rowsFor={rowsFor([storyWith('s-2', 'Shipped', { work: 4, done: 4 })])} ctx={ctx} />,
    );
    const bar = tileTitled(container, 'Shipped').querySelector('[data-testid="tile-progress"]');
    expect(bar?.classList.contains('lp__progress--done')).toBe(true);
  });

  it('the View menu can hide it, per kind', () => {
    writeHiddenFacets('story', ['progress']);
    const { container } = render(
      <EntityListPanel kind="story" rowsFor={rowsFor([storyWith('s-3', 'Hidden', { work: 2, done: 1 })])} ctx={ctx} />,
    );
    expect(tileTitled(container, 'Hidden').querySelector('[data-testid="tile-progress"]')).toBeNull();
  });

  it('a kind without `tile.progress` draws no bar', () => {
    const { container } = render(<EntityListPanel kind="doc" rowsFor={rowsFor([docLayoutSpec])} ctx={ctx} />);
    expect(container.querySelector('[data-testid="tile-progress"]')).toBeNull();
  });
});

describe('TileProgressBar', () => {
  it('clamps bands that over-report so the segments never exceed the track', () => {
    const { container } = render(
      <TileProgressBar progress={{ done: 3, work: 4, inProgress: 3, blocked: 2, noun: 'tasks' }} />,
    );
    const width = (sel: string) => container.querySelector<HTMLElement>(sel)?.style.width ?? '0%';
    const total = ['--done', '--active', '--blocked']
      .map((m) => parseFloat(width(`.lp__progress-seg${m}`)))
      .reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(100);
  });
});
