/**
 * EVERYTHING IS ON THE SCREEN, RUNNING WORK FIRST.
 *
 * THIS FILE USED TO PIN A TOP-TEN CAP. Ten cards, the other fifty-three behind
 * a button as rows. The owner's verdict on the deployed build was that the grid
 * was right and the ceiling was not — "showing only top few is not scalable and
 * limiting" — so the cap is gone and the grid scrolls instead. Every assertion
 * about `splitActive` went with it; what survives is the one job the cap was
 * really doing, which was stopping sixty chats burying five running sessions.
 * That is the SORT now, and a sort has no ceiling.
 *
 * The scroll region itself is a CSS claim and is pinned in
 * home-navigation-style.test.ts. This file only asks questions with answers.
 */
import { describe, expect, it } from 'vitest';
import { orderActive } from './HomePage';
import type { HomeRow } from '../home';

type Lens = 'chats' | 'sessions' | 'tasks';
type Row = HomeRow & { lens: Lens };

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

/** The shape of the real space: chats outnumber the work ten to one, and every
 *  one of them is newer than every running session. */
const flood: Row[] = rows([
  ...Array.from({ length: 40 }, (_, i) => ['chats', i] as const),
  ['sessions', 100, true],
  ['sessions', 200, true],
  ['tasks', 300],
  ['tasks', 400],
]);

describe('the active list', () => {
  it('drops nobody and duplicates nobody', () => {
    /* THE POINT OF RETIRING THE CAP. Fifty-three of these used to be behind a
       button; a list that hides work is a list you cannot trust to answer
       "what is happening". */
    const out = orderActive(flood);
    expect(out).toHaveLength(flood.length);
    expect(new Set(out.map((r) => r.id)).size).toBe(flood.length);
  });

  it('puts everything running above everything that is not', () => {
    const out = orderActive(flood);
    const lastLive = out.findLastIndex((r) => r.dot === 'pulse');
    const firstIdle = out.findIndex((r) => r.dot !== 'pulse');
    expect(lastLive, 'a running session sank below an idle chat').toBeLessThan(firstIdle);
  });

  it('orders by activity within each half', () => {
    const out = orderActive(flood);
    const live = out.filter((r) => r.dot === 'pulse').map((r) => r.activityAt ?? '');
    const idle = out.filter((r) => r.dot !== 'pulse').map((r) => r.activityAt ?? '');
    for (const half of [live, idle]) {
      expect([...half].sort((a, b) => b.localeCompare(a))).toEqual(half);
    }
  });

  it('does not mutate what it was handed', () => {
    const input = rows([['chats', 1], ['sessions', 9, true]]);
    const before = input.map((r) => r.id);
    orderActive(input);
    expect(input.map((r) => r.id)).toEqual(before);
  });

  it('is stable on an empty list', () => {
    expect(orderActive([])).toEqual([]);
  });
});
