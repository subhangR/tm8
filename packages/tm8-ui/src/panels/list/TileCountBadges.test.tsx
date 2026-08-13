// @vitest-environment jsdom
/**
 * Tile count badges (108) — the two directions of nothing, as unit truths:
 * zero renders no badge, and ABSENT (a pre-108 server that never counted)
 * also renders no badge; only a positive count draws glyph+number.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityCounters } from '@tm8/contract';
import { ada, noor } from '../../fixtures/actors.js';
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

describe('hasTileCounts', () => {
  it('is false for all-zero and for the pre-108 shape with no docs/memories keys', () => {
    expect(hasTileCounts(counters())).toBe(false);
    expect(hasTileCounts(counters({ docs: 0, memories: 0 }))).toBe(false);
  });

  it('is true the moment any counted thing exists', () => {
    expect(hasTileCounts(counters({ docs: 1 }))).toBe(true);
    expect(hasTileCounts(counters({ memories: 2 }))).toBe(true);
    expect(hasTileCounts(counters({ messages: 3 }))).toBe(true);
  });
});

describe('TileCountBadges', () => {
  it('renders NOTHING for zeros and for the pre-108 shape', () => {
    const zero = render(<TileCountBadges counters={counters({ docs: 0, memories: 0 })} />);
    expect(zero.container.innerHTML).toBe('');
    const pre108 = render(<TileCountBadges counters={counters()} />);
    expect(pre108.container.innerHTML).toBe('');
  });

  it('draws one badge per non-zero count, glyph + number, named for a reader', () => {
    render(<TileCountBadges counters={counters({ docs: 2, memories: 1, messages: 5, humanMessages: 2, agentMessages: 3 })} />);
    const root = screen.getByTestId('tile-count-badges');
    const badges = root.querySelectorAll('.pn-st__count');
    expect(badges).toHaveLength(4);
    expect(root.querySelector('[data-count-kind="doc"]')?.textContent).toBe('2');
    expect(root.querySelector('[data-count-kind="doc"]')?.getAttribute('title')).toBe('2 docs');
    expect(root.querySelector('[data-count-kind="memory"]')?.getAttribute('title')).toBe('1 memory');
    expect(root.querySelector('[data-count-kind="human-message"]')?.textContent).toBe('2');
    expect(root.querySelector('[data-count-kind="human-message"]')?.getAttribute('title')).toBe('2 human messages');
    expect(root.querySelector('[data-count-kind="human-message"]')?.classList.contains('pn-st__count--human')).toBe(true);
    expect(root.querySelector('[data-count-kind="agent-message"]')?.textContent).toBe('3');
    expect(root.querySelector('[data-count-kind="agent-message"]')?.getAttribute('title')).toBe('3 agent messages');
    expect(root.querySelector('[data-count-kind="agent-message"]')?.classList.contains('pn-st__count--human')).toBe(false);
    // Each badge carries a drawn mark, not a bare number.
    for (const badge of badges) expect(badge.querySelector('svg')).not.toBeNull();
  });

  it('keeps the legacy neutral total only when a server has not projected the split', () => {
    render(<TileCountBadges counters={counters({ messages: 5 })} />);
    expect(screen.getByTestId('tile-count-badges').querySelector('[data-count-kind="message"]')?.textContent).toBe('5');
  });

  it('shows actual human authors in a compact stack with honest overflow', () => {
    render(<TileCountBadges
      counters={counters({ messages: 7, humanMessages: 7, agentMessages: 0 })}
      humanAuthors={{ actors: [ada, noor], total: 5 }}
    />);
    const human = screen.getByTestId('tile-count-badges').querySelector('[data-count-kind="human-message"]');
    expect(human?.querySelectorAll('.kit-avatar')).toHaveLength(2);
    expect(human?.querySelector('.kit-avatarstack__more')?.textContent).toBe('+3');
    expect(human?.textContent?.endsWith('7')).toBe(true);
  });

  it('drops only the zero rows, keeping the rest', () => {
    render(<TileCountBadges counters={counters({ docs: 0, memories: 4 })} />);
    const root = screen.getByTestId('tile-count-badges');
    expect(root.querySelector('[data-count-kind="doc"]')).toBeNull();
    expect(root.querySelector('[data-count-kind="memory"]')?.textContent).toBe('4');
    expect(root.querySelector('[data-count-kind="message"]')).toBeNull();
  });
});
