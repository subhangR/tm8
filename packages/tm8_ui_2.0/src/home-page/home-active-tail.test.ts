/**
 * TOP TEN, THEN A LIST — the owner's ruling of 2026-08-30 ("1 and 2 are good
 * displaying top 10 rest everything as expansion button like row items").
 *
 * WHAT THIS FILE EXISTS TO CATCH. The live space has sixty chats and five
 * sessions. Sorted by activity alone, the ten cards at the top of Home are ten
 * chats, and the sessions and tasks the owner opened Home to see are below a
 * fold they have to click through. That is not a styling defect and no CSS
 * assertion can see it — it is a SELECTION defect, so it is tested here as
 * behaviour, on the function that selects.
 *
 * The CSS half of the change is pinned in home-navigation-style.test.ts, which
 * is where this package keeps its source-shape claims. This file only asks
 * questions with answers.
 */
import { describe, expect, it } from 'vitest';
import { splitActive, TOP_N } from './HomePage';
import type { HomeRow } from '../home';

type Lens = 'chats' | 'sessions' | 'tasks';
type Row = HomeRow & { lens: Lens };

/** Rows as the strip receives them: already newest-first, across all kinds. */
function rows(spec: readonly (readonly [Lens, number, boolean?])[]): Row[] {
  return spec.map(([lens, minutesAgo, live], i) => ({
    id: `${lens}-${i}`,
    kind: null,
    title: `${lens} ${i}`,
    word: null,
    tone: 'idle' as const,
    dot: live ? ('pulse' as const) : null,
    activityAt: new Date(Date.UTC(2026, 7, 30, 12, 0) - minutesAgo * 60_000).toISOString(),
    lens,
  }));
}

/** The shape of the real space: chats outnumber the work ten to one. */
const flood: Row[] = rows([
  ...Array.from({ length: 40 }, (_, i) => ['chats', i] as const),
  ['sessions', 100, true],
  ['sessions', 200, true],
  ['tasks', 300],
  ['tasks', 400],
]);

describe('the active list splits at ten', () => {
  it('gives a card to exactly ten and a row to the rest', () => {
    const { top, rest } = splitActive(flood, TOP_N);
    expect(top).toHaveLength(TOP_N);
    expect(rest).toHaveLength(flood.length - TOP_N);
  });

  it('splits nothing when there is nothing to split', () => {
    const short = rows([['chats', 1], ['sessions', 2, true]]);
    const { top, rest } = splitActive(short, TOP_N);
    expect(top).toEqual(short);
    // No tail means no expansion button — the control appears because there is
    // something behind it, never as furniture.
    expect(rest).toEqual([]);
  });

  it('loses nobody and duplicates nobody', () => {
    const { top, rest } = splitActive(flood, TOP_N);
    const ids = [...top, ...rest].map((r) => r.id);
    expect(new Set(ids).size).toBe(flood.length);
  });

  it('never lets one kind take every seat', () => {
    /* THE WHOLE POINT. Forty chats are newer than every session and task here,
       so a straight recency cut fills all ten cards with chats. */
    const { top } = splitActive(flood, TOP_N);
    const kinds = new Set(top.map((r) => r.lens));
    expect(kinds, 'the newest kind swallowed the top of Home').toEqual(
      new Set(['chats', 'sessions', 'tasks']),
    );
  });

  it('seats everything that is running before anything that is not', () => {
    const { top } = splitActive(flood, TOP_N);
    const live = flood.filter((r) => r.dot === 'pulse');
    for (const row of live) {
      expect(top.map((r) => r.id), `a running ${row.lens} was pushed below the fold`).toContain(
        row.id,
      );
    }
  });

  it('still reads newest-first once the seats are filled', () => {
    /* Selection is balanced; ORDER is time. Both halves are filtered out of an
       already-sorted list, so neither may reorder it. */
    const { top, rest } = splitActive(flood, TOP_N);
    for (const half of [top, rest]) {
      const times = half.map((r) => r.activityAt ?? '');
      expect([...times].sort((a, b) => b.localeCompare(a))).toEqual(times);
    }
  });

  it('fills all ten seats even when only one kind has anything', () => {
    const only = rows(Array.from({ length: 25 }, (_, i) => ['chats', i] as const));
    const { top, rest } = splitActive(only, TOP_N);
    expect(top).toHaveLength(TOP_N);
    expect(rest).toHaveLength(15);
  });
});
