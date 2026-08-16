// @vitest-environment jsdom
/**
 * GRAPH SEEDS — the fold that turns a thread's tool calls into the induced
 * graph's node set (R2: same extraction as the chips, unchanged; R14:
 * incremental per turn; Q2: capped at MAX_GRAPH_SEEDS, first-seen, counted).
 */
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { MAX_GRAPH_SEEDS, foldGraphSeeds } from './graph-seeds';
import type { ChatTurn, ChatTurnPart } from './types';

const id = (n: number): string => `01900000-00cc-7000-8000-${String(n).padStart(12, '0')}`;
const TASK = id(1);
const DOC = id(2);

let seq = 0;
const call = (name: string, args: unknown, result?: unknown): ChatTurnPart[] => {
  const toolCallId = `tc-${(seq += 1)}`;
  const parts: ChatTurnPart[] = [
    { kind: 'tool_call', seq: (seq += 1), toolCallId, name, args, state: 'completed' },
  ];
  if (result !== undefined) {
    parts.push({ kind: 'tool_result', seq: (seq += 1), toolCallId, content: result });
  }
  return parts;
};

const turn = (parts: ChatTurnPart[]): ChatTurn => ({
  messageId: `msg-${(seq += 1)}` as EntityId,
  role: 'assistant',
  author: null,
  createdAt: '2026-08-16T10:00:00.000Z',
  body: '',
  parts,
});

describe('foldGraphSeeds', () => {
  it('one seed per distinct entity, first-reference order, richer fields win', () => {
    const { seeds, overflow } = foldGraphSeeds([
      turn([
        ...call('tm8_read', { id: DOC }),
        ...call('tm8_read', { id: TASK }, { id: TASK, kind: 'task', title: 'Fix login' }),
        ...call('tm8_read', { entityId: TASK }),
      ]),
    ]);
    expect(seeds.map((s) => s.id)).toEqual([DOC, TASK]);
    expect(seeds[1]).toMatchObject({ kind: 'task', title: 'Fix login' });
    expect(overflow).toBe(0);
  });

  it('R6: a write-shaped tool marks its refs mutated; reads and unknown verbs do not', () => {
    const { seeds } = foldGraphSeeds([
      turn([
        ...call('tm8_read', { id: TASK }),
        ...call('mcp__tm8__tm8_update_entity', { id: TASK }),
        ...call('tm8_read', { id: DOC }),
        ...call('Bash', { command: 'ls', cwd: DOC }), // unknown verb ⇒ read
      ]),
    ]);
    expect(seeds.find((s) => s.id === TASK)!.mutated).toBe(true);
    expect(seeds.find((s) => s.id === DOC)!.mutated).toBe(false);
  });

  it('suppression applies at merge, so a grown own-message set needs no re-extraction', () => {
    const turns = [turn(call('tm8_read', { id: TASK })), turn(call('tm8_read', { id: DOC }))];
    const before = foldGraphSeeds(turns);
    const after = foldGraphSeeds(turns, new Set([TASK]));
    expect(before.seeds.map((s) => s.id)).toEqual([TASK, DOC]);
    expect(after.seeds.map((s) => s.id)).toEqual([DOC]);
  });

  it('R14: an unchanged turn object is never re-walked (WeakMap identity cache)', () => {
    const settled = turn(call('tm8_read', { id: TASK }));
    const first = foldGraphSeeds([settled]);
    // Same turn OBJECT again ⇒ the cached refs; the fold still returns fresh
    // seed objects, so a caller can never mutate the cache through them.
    const second = foldGraphSeeds([settled, turn(call('tm8_read', { id: DOC }))]);
    expect(second.seeds.map((s) => s.id)).toEqual([TASK, DOC]);
    expect(second.seeds[0]).not.toBe(first.seeds[0]);
    expect(second.seeds[0]).toEqual(first.seeds[0]);
  });

  it('Q2 (amended): the cap splits drawn/overflow but DISCARDS NOTHING', () => {
    const parts: ChatTurnPart[] = [];
    for (let n = 1; n <= MAX_GRAPH_SEEDS + 3; n += 1) parts.push(...call('tm8_read', { id: id(n) }));
    // The 65th+ entities are referenced twice each: still 3 overflow, not 6.
    for (let n = MAX_GRAPH_SEEDS + 1; n <= MAX_GRAPH_SEEDS + 3; n += 1) {
      parts.push(...call('tm8_read', { id: id(n) }));
    }
    const { seeds, drawn, overflow } = foldGraphSeeds([turn(parts)]);
    expect(drawn).toHaveLength(MAX_GRAPH_SEEDS);
    expect(drawn[0]!.id).toBe(id(1)); // first-seen wins — stability over recency
    expect(overflow).toBe(3);
    // The fold keeps every seed it saw; drawn is a prefix of the same order.
    expect(seeds).toHaveLength(MAX_GRAPH_SEEDS + 3);
    expect(seeds.slice(0, MAX_GRAPH_SEEDS)).toEqual(drawn);
    expect(seeds[MAX_GRAPH_SEEDS]!.id).toBe(id(MAX_GRAPH_SEEDS + 1));
  });

  it('rich fields still merge onto an OVERFLOWED seed — undrawn is not untracked', () => {
    const parts: ChatTurnPart[] = [];
    for (let n = 1; n <= MAX_GRAPH_SEEDS + 1; n += 1) parts.push(...call('tm8_read', { id: id(n) }));
    const last = id(MAX_GRAPH_SEEDS + 1);
    parts.push(
      ...call('tm8_read', { id: last }, { id: last, kind: 'task', title: 'Past the cap' }),
      ...call('tm8_update_entity', { id: last }),
    );
    const { seeds, overflowByKind } = foldGraphSeeds([turn(parts)]);
    expect(seeds.at(-1)).toMatchObject({ kind: 'task', title: 'Past the cap', mutated: true });
    expect(overflowByKind.get('task')).toBe(1);
  });

  it('overflowByKind counts undrawn seeds per kind, with "entity" for the unknown', () => {
    const parts: ChatTurnPart[] = [];
    for (let n = 1; n <= 4; n += 1) parts.push(...call('tm8_read', { id: id(n) }));
    parts.push(...call('tm8_read', { id: id(5) }, { id: id(5), kind: 'task', title: 'T' }));
    parts.push(...call('tm8_read', { id: id(6) }, { id: id(6), kind: 'task', title: 'U' }));
    parts.push(...call('tm8_read', { id: id(7) }));
    const { drawn, overflow, overflowByKind } = foldGraphSeeds([turn(parts)], undefined, {
      limit: 4,
    });
    expect(drawn.map((s) => s.id)).toEqual([id(1), id(2), id(3), id(4)]);
    expect(overflow).toBe(3);
    expect([...overflowByKind.entries()].sort()).toEqual([
      ['entity', 1],
      ['task', 2],
    ]);
  });

  it('the limit option moves the split without changing the order', () => {
    const turns = [turn([...call('tm8_read', { id: TASK }), ...call('tm8_read', { id: DOC })])];
    const wide = foldGraphSeeds(turns, undefined, { limit: 256 });
    const narrow = foldGraphSeeds(turns, undefined, { limit: 1 });
    expect(wide.drawn.map((s) => s.id)).toEqual([TASK, DOC]);
    expect(wide.overflow).toBe(0);
    expect(narrow.drawn.map((s) => s.id)).toEqual([TASK]);
    expect(narrow.overflow).toBe(1);
    expect(narrow.seeds.map((s) => s.id)).toEqual([TASK, DOC]);
  });
});
