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
import { lineageOf, orderActive } from './HomePage';
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

/**
 * THE SESSION TREE ON THE STRIP (owner ruling, 2026-08-31: "the
 * session/sub-session tree must be visible in the grid").
 *
 * THE CONSTRAINT THAT DECIDED THE SHAPE, and it is what these cases actually
 * defend: a running CHILD session is active work in its own right, so nothing
 * may nest children inside a parent behind an expand. Hiding running work is
 * the exact opposite of what this strip is for. Every row is still emitted;
 * what the hierarchy buys is ORDER (a child follows its parent) and DEPTH (the
 * row band indents on it, the card band ignores it).
 */
describe('orderActive walks the session tree', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 7, 30, 12, 0) - m * 60_000).toISOString();
  const row = (id: string, minutes: number, extra: Partial<Row> = {}): Row => ({
    id,
    kind: null,
    title: id,
    word: null,
    tone: 'idle',
    dot: null,
    activityAt: at(minutes),
    lens: 'sessions',
    ...extra,
  });

  it('puts a child immediately after its parent, at depth 1, and drops nothing', () => {
    /* The live shape, measured: one session with one child that carries the
       parent id back. The child is OLDER than an unrelated session, so a flat
       sort would separate the two — the walk keeps them together. */
    const out = orderActive([
      row('other', 5),
      row('parent', 10),
      row('child', 90, { parentId: 'parent' }),
    ]);
    expect(out.map((r) => r.id)).toEqual(['other', 'parent', 'child']);
    expect(out.map((r) => r.depth)).toEqual([0, 0, 1]);
    /* AND THE CHILD IS ITS OWN ROW. Not a chip inside its parent, not behind an
       expand — a card and a row in its own right, which is the whole ruling. */
    expect(out).toHaveLength(3);
  });

  it('is n-deep in the model — today is depth two and that is a fact about the data', () => {
    const out = orderActive([
      row('a', 10),
      row('b', 20, { parentId: 'a' }),
      row('c', 30, { parentId: 'b' }),
      row('d', 40, { parentId: 'c' }),
    ]);
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(out.map((r) => r.depth)).toEqual([0, 1, 2, 3]);
  });

  it('ranks SIBLINGS by the same running-first rule at every level', () => {
    /* The cap's one real job survives inside the tree: a running child outranks
       an idle sibling that is newer, exactly as a running root outranks a newer
       chat at the top level. */
    const out = orderActive([
      row('parent', 10),
      row('idle-newer', 1, { parentId: 'parent' }),
      row('running-older', 300, { parentId: 'parent', dot: 'pulse' }),
    ]);
    expect(out.map((r) => r.id)).toEqual(['parent', 'running-older', 'idle-newer']);
    expect(out.map((r) => r.depth)).toEqual([0, 1, 1]);
  });

  it('treats a parent that is not on screen as a root — the lens filtered it, not us', () => {
    /* `parentId` pointing outside the current set is not an error and not a
       reason to drop the row: it is a session whose parent this lens did not
       return. It stands at the top level and says it has a parent in words
       (`lineageOf`), which is a different claim from naming one. */
    const out = orderActive([row('orphan', 5, { parentId: 'not-here' })]);
    expect(out.map((r) => r.id)).toEqual(['orphan']);
    expect(out[0]!.depth).toBe(0);
  });

  it('survives a cycle on the wire without losing a row or hanging', () => {
    /* `parentId` comes off the wire. A cycle would make a naive depth-first
       walk never return, and work is never dropped from this strip — so the
       stranded rows come out at the top level rather than disappearing. */
    const out = orderActive([
      row('x', 5, { parentId: 'y' }),
      row('y', 6, { parentId: 'x' }),
      row('free', 7),
    ]);
    expect(new Set(out.map((r) => r.id))).toEqual(new Set(['x', 'y', 'free']));
    expect(out).toHaveLength(3);
  });

  it('does not let a row parent itself', () => {
    const out = orderActive([row('self', 5, { parentId: 'self' })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.depth).toBe(0);
  });
});

/**
 * WHAT A CHILD CARD SAYS, and the middle case is the one worth a test: a parent
 * we cannot resolve must not produce an empty "↳ from ", which reads as a
 * missing name rather than an unresolved one.
 */
describe('lineageOf', () => {
  const base: HomeRow = { id: 'r', kind: null, title: 'r', word: null, tone: 'idle', dot: null };

  it('says nothing at all when there is no parent — absence is not a claim', () => {
    expect(lineageOf(base, () => undefined)).toBeNull();
  });

  it('names the parent when the parent is on screen', () => {
    expect(lineageOf({ ...base, parentId: 'p' }, () => 'Calm pass lane C')).toBe(
      '↳ from Calm pass lane C',
    );
  });

  it('states the relationship without naming an unresolvable parent', () => {
    expect(lineageOf({ ...base, parentId: 'p' }, () => undefined)).toBe('↳ sub-session');
    /* A blank title is the same case as a missing one — an empty name is not a
       name, and "↳ from " with nothing after it is the defect. */
    expect(lineageOf({ ...base, parentId: 'p' }, () => '   ')).toBe('↳ sub-session');
  });
});
