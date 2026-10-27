import { describe, expect, it } from 'vitest';
import type { EntityCounters } from '@tm8/contract';
import { TILE_LINK_GROUPS, UNCOUNTED_LINK_GROUPS, hasTileLinkCounts, tileLinkCountsOf } from './tile-counts';

/**
 * THE COUNTS LINE'S DATA (design doc 01a1465d §6, approved 2026-10-16).
 *
 * The interesting cases here are all about ABSENCE: a node older than
 * migration 329 sends no `prs`, `artifacts` or `drawings` (and one older than
 * 108 no `docs`/`memories`), so this module's correctness is mostly "what does
 * it do with a number it has not been given", and the answer has to be
 * "nothing", never "zero".
 */

const counters = (patch: Record<string, unknown> = {}): EntityCounters =>
  ({
    likes: 0,
    dislikes: 0,
    stars: 0,
    points: 0,
    messages: 0,
    viewerReaction: null,
    ...patch,
  }) as EntityCounters;

describe('TILE_LINK_GROUPS — one constant, one order', () => {
  it('is Docs · PRs · Artifacts · Drawings · Memories · Sessions, in that order', () => {
    expect(TILE_LINK_GROUPS.map((group) => group.id)).toEqual([
      'docs',
      'prs',
      'artifacts',
      'drawings',
      'memories',
      'sessions',
    ]);
  });

  /**
   * THE FIFTH SLOT IS THE SWAPPABLE ONE. The brief states that Memories may
   * become Files, so the test that matters is not "the fifth is memories" but
   * "the fifth is whatever this one constant says, everywhere". Nothing may
   * re-derive the list or hard-code a group id outside it.
   */
  it('carries a drawable kind and a singular noun for every group', () => {
    for (const group of TILE_LINK_GROUPS) {
      expect(group.kind, `${group.id} names no kind`).toBeTruthy();
      expect(group.counter, `${group.id} names no counter`).toBeTruthy();
      expect(group.label, `${group.id} has no noun`).toBeTruthy();
      /* A singular noun, so the renderer can pluralise it. */
      expect(group.label.endsWith('s')).toBe(false);
    }
  });

  it('has no duplicate ids, kinds or counters', () => {
    for (const key of ['id', 'kind', 'counter'] as const) {
      const values = TILE_LINK_GROUPS.map((group) => group[key]);
      expect(new Set(values).size, `duplicate ${key}`).toBe(values.length);
    }
  });
});

describe('tileLinkCountsOf', () => {
  it('draws nothing for a server that never counted — absence is not zero', () => {
    expect(tileLinkCountsOf(counters())).toEqual([]);
    expect(hasTileLinkCounts(counters())).toBe(false);
  });

  it('draws nothing for an explicit zero either', () => {
    expect(tileLinkCountsOf(counters({ docs: 0, memories: 0, prs: 0 }))).toEqual([]);
    expect(hasTileLinkCounts(counters({ docs: 0 }))).toBe(false);
  });

  it('keeps the constant order whatever order the counters arrive in', () => {
    const got = tileLinkCountsOf(counters({ memories: 3, docs: 1, artifacts: 2 }));
    expect(got.map((entry) => [entry.group.id, entry.count])).toEqual([
      ['docs', 1],
      ['artifacts', 2],
      ['memories', 3],
    ]);
    expect(hasTileLinkCounts(counters({ memories: 3 }))).toBe(true);
  });

  /**
   * THE DEFENSIVE READ, which is the whole reason the counters are addressed
   * as a bag of strings rather than through `keyof EntityCounters`. A node
   * mid-rollout can send a shape nobody declared; the honest rendering of a
   * number that is not a number is NO number, not a guess at one.
   */
  it('treats a non-number, a NaN and a negative as absent', () => {
    expect(tileLinkCountsOf(counters({ docs: '4', memories: null, prs: Number.NaN, artifacts: -2 }))).toEqual([]);
  });

  it('truncates a fractional count rather than printing a fraction', () => {
    expect(tileLinkCountsOf(counters({ docs: 2.7 })).map((entry) => entry.count)).toEqual([2]);
    /* 0.4 truncates to 0, which is absent — a row does not claim half a doc. */
    expect(tileLinkCountsOf(counters({ docs: 0.4 }))).toEqual([]);
  });

  it('reads the three counters migration 329 added', () => {
    const got = tileLinkCountsOf(counters({ prs: 1, artifacts: 4, drawings: 2 }));
    expect(got.map((entry) => entry.group.id)).toEqual(['prs', 'artifacts', 'drawings']);
  });
});

describe('UNCOUNTED_LINK_GROUPS', () => {
  it('marks none of the five groups: the server counts all of them since 329', () => {
    for (const group of TILE_LINK_GROUPS) {
      expect(UNCOUNTED_LINK_GROUPS.has(group.id), `${group.id} still marked not counted`).toBe(false);
    }
  });
});
