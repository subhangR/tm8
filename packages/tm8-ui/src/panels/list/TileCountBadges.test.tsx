// @vitest-environment jsdom
/**
 * Tile count badges (108, 327) — the two directions of nothing, as unit
 * truths: zero renders no badge, and ABSENT (a server that never counted)
 * also renders no badge; only a positive count draws glyph+number. 327: the
 * five linked counts, in their fixed order, and no message tallies at all.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityCounters } from '@tm8/contract';
import { TileCountBadges, hasTileCounts } from './TileCountBadges.js';

function counters(overrides: Partial<EntityCounters> = {}): EntityCounters {
  return {
    likes: 0,
    dislikes: 0,
    stars: 0,
    points: 0,
    messages: 0,
    viewerReaction: null,
    ...overrides,
  };
}

const noneLinked = { docs: 0, pullRequests: 0, artifacts: 0, drawings: 0, memories: 0 };

describe('hasTileCounts', () => {
  it('is false for all-zero and for the pre-108 shape with no docs/memories keys', () => {
    expect(hasTileCounts(counters())).toBe(false);
    expect(hasTileCounts(counters({ docs: 0, memories: 0 }))).toBe(false);
  });

  it('is true the moment any counted thing exists', () => {
    expect(hasTileCounts(counters({ docs: 1 }))).toBe(true);
    expect(hasTileCounts(counters({ memories: 2 }))).toBe(true);
    expect(hasTileCounts(counters({ linked: { ...noneLinked, drawings: 1 } }))).toBe(true);
  });

  it('ignores message tallies: they left the tile (327)', () => {
    expect(hasTileCounts(counters({ messages: 3, humanMessages: 2, agentMessages: 1 }))).toBe(false);
  });
});

describe('TileCountBadges', () => {
  it('renders NOTHING for zeros and for the pre-108 shape', () => {
    const zero = render(<TileCountBadges counters={counters({ docs: 0, memories: 0 })} />);
    expect(zero.container.innerHTML).toBe('');
    const pre108 = render(<TileCountBadges counters={counters()} />);
    expect(pre108.container.innerHTML).toBe('');
  });

  it('draws the five linked counts in order, glyph + number, named for a reader', () => {
    render(<TileCountBadges counters={counters({
      docs: 9, memories: 9, messages: 5, humanMessages: 2, agentMessages: 3,
      linked: { docs: 2, pullRequests: 1, artifacts: 3, drawings: 1, memories: 4 },
    })} />);
    const root = screen.getByTestId('tile-count-badges');
    const badges = [...root.querySelectorAll('.pn-st__count')];
    expect(badges.map((b) => b.getAttribute('data-count-kind')))
      .toEqual(['doc', 'pull_request', 'artifact', 'drawing', 'memory']);
    expect(badges.map((b) => b.textContent)).toEqual(['2', '1', '3', '1', '4']);
    expect(root.querySelector('[data-count-kind="doc"]')?.getAttribute('title')).toBe('2 docs');
    expect(root.querySelector('[data-count-kind="pull_request"]')?.getAttribute('title')).toBe('1 pull request');
    // Each badge carries a drawn mark, not a bare number.
    for (const badge of badges) expect(badge.querySelector('svg')).not.toBeNull();
  });

  it('falls back to 108\'s docs and memories on a server without linked counts', () => {
    render(<TileCountBadges counters={counters({ docs: 2, memories: 1, messages: 5 })} />);
    const root = screen.getByTestId('tile-count-badges');
    expect([...root.querySelectorAll('.pn-st__count')].map((b) => b.getAttribute('data-count-kind')))
      .toEqual(['doc', 'memory']);
  });

  it('never replaces a server-counted number with the row\'s own hydrated count', () => {
    render(<TileCountBadges
      counters={counters({ linked: { ...noneLinked, docs: 3 } })}
      countOf={() => 1}
    />);
    expect(screen.getByTestId('tile-count-badges').querySelector('[data-count-kind="doc"]')?.textContent).toBe('3');
  });

  it('drops only the zero rows, keeping the rest', () => {
    render(<TileCountBadges counters={counters({ docs: 0, memories: 4 })} />);
    const root = screen.getByTestId('tile-count-badges');
    expect(root.querySelector('[data-count-kind="doc"]')).toBeNull();
    expect(root.querySelector('[data-count-kind="memory"]')?.textContent).toBe('4');
    expect(root.querySelector('[data-count-kind="message"]')).toBeNull();
  });
});
