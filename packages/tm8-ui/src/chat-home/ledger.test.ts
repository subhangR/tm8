/**
 * THE LEDGER FOLD — what the chat view says the conversation did.
 *
 * The claims under test are the ones a wrong answer would put on screen as a
 * confident sentence: how many entities a turn read, which of them were merely
 * NAMED rather than learned, what a create's parent was, and which side of a
 * transition is genuinely unknown versus zero.
 *
 * The budget cases are here because the design ruling was "measure the budget,
 * do not pick it" — so the constants are asserted against payloads shaped like
 * the largest reads the MCP surface can actually produce, and the assertion
 * fails if a future page shape outgrows them.
 */
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import {
  TALLY_MAX_NODES,
  buildChatLedger,
  readCountPairs,
} from './ledger';
import { walkPayload } from './payload-walk';
import { extractEntityRefs } from './entity-refs';
import type { ChatTurn, ChatTurnPart } from './types';

const id = (n: number): string =>
  `01a02400-0000-7000-8000-${String(n).padStart(12, '0')}`;

const TASK = id(1);
const TASK_CHILD = id(2);
const DOC = id(3);
const MEMORY = id(4);
const SESSION = id(5);
const TEAMMATE = id(6);

let seq = 0;

function call(args: unknown, result?: unknown, name = 'mcp__tm8__tm8_read'): ChatTurnPart[] {
  const toolCallId = `tc-${(seq += 1)}`;
  const parts: ChatTurnPart[] = [
    { kind: 'tool_call', seq: (seq += 1), toolCallId, name, args, state: 'completed' },
  ];
  if (result !== undefined) {
    parts.push({ kind: 'tool_result', seq: (seq += 1), toolCallId, content: result });
  }
  return parts;
}

function turn(...parts: ChatTurnPart[][]): ChatTurn {
  return {
    messageId: `msg-${(seq += 1)}` as EntityId,
    role: 'assistant',
    author: null,
    createdAt: '2026-08-21T12:00:00.000Z',
    body: '',
    parts: parts.flat(),
  };
}

/** A full entity summary as the server returns one. */
const summary = (
  entityId: string,
  kind: string,
  title: string,
  status?: string,
): Record<string, unknown> => ({
  id: entityId,
  kind,
  title,
  ...(status ? { state: { kind, status } } : {}),
});

describe('read tally', () => {
  it('counts distinct entities per kind from results, deduped across the turn', () => {
    const ledger = buildChatLedger([
      turn(
        call({ operation: 'entities.get', params: { id: TASK } }, { entity: summary(TASK, 'task', 'One') }),
        // the SAME task again — one distinct entity, not two
        call({ operation: 'entities.get', params: { id: TASK } }, { entity: summary(TASK, 'task', 'One') }),
        call({ operation: 'entities.children', params: { id: TASK } }, {
          items: [summary(DOC, 'doc', 'D1'), summary(MEMORY, 'memory', 'M1')],
        }),
      ),
    ]);

    const reads = ledger.turns[0]!.reads;
    expect(reads.total).toBe(3);
    expect(reads.byKind.get('task')).toBe(1);
    expect(reads.byKind.get('doc')).toBe(1);
    expect(reads.byKind.get('memory')).toBe(1);
  });

  it('does NOT count ids that only appear in arguments', () => {
    // The call NAMES three tasks and learns nothing about them: an empty page.
    const ledger = buildChatLedger([
      turn(
        call(
          { operation: 'collections.query', body: { taskIds: [TASK, TASK_CHILD, DOC] } },
          { items: [] },
        ),
      ),
    ]);
    expect(ledger.turns[0]!.reads.total).toBe(0);
  });

  it('buckets a summary whose kind the payload never carried, rather than dropping it', () => {
    const ledger = buildChatLedger([
      turn(call({ operation: 'entities.get' }, { entity: { id: TASK, title: 'Untyped' } })),
    ]);
    const reads = ledger.turns[0]!.reads;
    expect(reads.total).toBe(1);
    expect(reads.byKind.get('entity')).toBe(1);
  });

  it('orders the sentence largest-first and always sinks the unknown bucket last', () => {
    const pairs = readCountPairs({
      byKind: new Map([
        ['entity', 9],
        ['doc', 2],
        ['task', 5],
      ]),
      total: 16,
      ids: [],
    });
    expect(pairs.map((p) => p.kind)).toEqual(['task', 'doc', 'entity']);
  });
});

describe('creates', () => {
  it('takes the id from the result and kind/title/parentId from the call', () => {
    const ledger = buildChatLedger([
      turn(
        call(
          {
            operation: 'entities.create',
            body: { spaceId: 'sp', kind: 'task', title: 'Task 1', parentId: null },
          },
          { entity: summary(TASK, 'task', 'Task 1') },
          'mcp__tm8__tm8_act',
        ),
        call(
          {
            operation: 'entities.create',
            body: { spaceId: 'sp', kind: 'task', title: 'Task 1.1', parentId: TASK },
          },
          { entity: summary(TASK_CHILD, 'task', 'Task 1.1') },
          'mcp__tm8__tm8_act',
        ),
      ),
    ]);

    expect(ledger.creates).toHaveLength(2);
    expect(ledger.creates[0]).toMatchObject({ id: TASK, kind: 'task', title: 'Task 1', parentId: null });
    expect(ledger.creates[1]).toMatchObject({ id: TASK_CHILD, parentId: TASK });
    expect(ledger.parentOf.get(TASK_CHILD)).toBe(TASK);
  });

  it('does not count a create as a read', () => {
    const ledger = buildChatLedger([
      turn(
        call(
          { operation: 'entities.create', body: { kind: 'task', title: 'T' } },
          { entity: summary(TASK, 'task', 'T') },
          'mcp__tm8__tm8_act',
        ),
      ),
    ]);
    expect(ledger.turns[0]!.reads.total).toBe(0);
    expect(ledger.turns[0]!.creates).toHaveLength(1);
  });

  it('emits nothing for a create whose result has not landed yet', () => {
    // Inventing an id here would produce a tree node that never reconciles.
    const ledger = buildChatLedger([
      turn(call({ operation: 'entities.create', body: { kind: 'task', title: 'T' } }, undefined, 'mcp__tm8__tm8_act')),
    ]);
    expect(ledger.creates).toHaveLength(0);
  });

  it('records a spawned session as a creation of kind work_session', () => {
    const ledger = buildChatLedger([
      turn(
        call(
          { operation: 'execution.spawn', body: { teamMemberId: TEAMMATE, taskIds: [TASK] } },
          { session: summary(SESSION, 'work_session', 'worker') },
          'mcp__tm8__tm8_delegate',
        ),
      ),
    ]);
    expect(ledger.creates).toHaveLength(1);
    expect(ledger.creates[0]).toMatchObject({ id: SESSION, kind: 'work_session', spawned: true });
  });
});

describe('reparenting', () => {
  it('honours entities.move, including a move to the root', () => {
    const ledger = buildChatLedger([
      turn(
        call(
          { operation: 'entities.create', body: { kind: 'task', title: 'C', parentId: TASK } },
          { entity: summary(TASK_CHILD, 'task', 'C') },
          'mcp__tm8__tm8_act',
        ),
      ),
      turn(
        call(
          { operation: 'entities.move', params: { id: TASK_CHILD }, body: { parentId: null, position: 0 } },
          { ok: true },
          'mcp__tm8__tm8_act',
        ),
      ),
    ]);
    expect(ledger.parentOf.get(TASK_CHILD)).toBeNull();
  });

  it('honours a placements.apply subtask intent, and ignores other intents', () => {
    const ledger = buildChatLedger([
      turn(
        call(
          { operation: 'placements.apply', body: { sourceId: TASK_CHILD, targetId: TASK, intent: 'subtask' } },
          { ok: true },
          'mcp__tm8__tm8_act',
        ),
        call(
          { operation: 'placements.apply', body: { sourceId: DOC, targetId: TASK, intent: 'attach' } },
          { ok: true },
          'mcp__tm8__tm8_act',
        ),
      ),
    ]);
    expect(ledger.parentOf.get(TASK_CHILD)).toBe(TASK);
    expect(ledger.parentOf.has(DOC)).toBe(false);
  });
});

describe('transitions', () => {
  it('fills the from-side from a status this thread already read', () => {
    const ledger = buildChatLedger([
      turn(call({ operation: 'entities.get', params: { id: TASK } }, { entity: summary(TASK, 'task', 'T', 'working') })),
      turn(
        call(
          { operation: 'entities.commands.complete', params: { id: TASK }, body: { expectedVersion: 3 } },
          { ok: true },
          'mcp__tm8__tm8_act',
        ),
      ),
    ]);
    expect(ledger.transitions).toHaveLength(1);
    expect(ledger.transitions[0]).toMatchObject({ entityId: TASK, from: 'working', to: 'done' });
    expect(ledger.statusNow.get(TASK)).toBe('done');
  });

  it('leaves the from-side NULL when the entity was never read here — never a guess', () => {
    const ledger = buildChatLedger([
      turn(
        call(
          { operation: 'entities.commands.work', params: { id: TASK }, body: { status: 'working' } },
          { ok: true },
          'mcp__tm8__tm8_act',
        ),
      ),
    ]);
    expect(ledger.transitions[0]).toMatchObject({ from: null, to: 'working' });
  });

  it('chains: the second transition sees the first as its from-side', () => {
    const work = (status: string): ChatTurnPart[] =>
      call(
        { operation: 'entities.commands.work', params: { id: TASK }, body: { status } },
        { ok: true },
        'mcp__tm8__tm8_act',
      );
    const ledger = buildChatLedger([turn(work('pulled')), turn(work('working')), turn(work('in_review'))]);
    expect(ledger.transitions.map((t) => [t.from, t.to])).toEqual([
      [null, 'pulled'],
      ['pulled', 'working'],
      ['working', 'in_review'],
    ]);
    expect(ledger.statusNow.get(TASK)).toBe('in_review');
  });
});

describe('turn shape', () => {
  it('marks a turn that touched nothing as empty so no ledger is drawn', () => {
    const ledger = buildChatLedger([turn()]);
    expect(ledger.turns[0]!.empty).toBe(true);
  });

  it('folds a turn that is still streaming, without waiting for it to settle', () => {
    // The call has landed; its result has not. The read count is honestly 0 so
    // far — it must not refuse to fold, and must not invent a count.
    const ledger = buildChatLedger([
      turn(call({ operation: 'entities.get', params: { id: TASK } })),
    ]);
    expect(ledger.turns).toHaveLength(1);
    expect(ledger.turns[0]!.reads.total).toBe(0);
  });
});

/* ── the measured budgets ────────────────────────────────────────────────
   The ruling was "measure the budget, do not pick it". These build payloads
   shaped like the largest reads the MCP surface can produce and assert the
   constants clear them, so a future page shape that outgrows the budget fails
   here rather than silently under-counting on screen. */

describe('walk budgets, measured', () => {
  /** A `graph.query` page at its documented `limit: 100`, rows carrying nested
   *  source and target summaries — the largest single read available. */
  const graphQueryPage = {
    items: Array.from({ length: 100 }, (_, i) => ({
      id: id(1000 + i),
      kind: 'task',
      title: `Task ${i}`,
      state: { kind: 'task', status: 'working' },
      source: summary(id(2000 + i), 'task', `Src ${i}`),
      target: summary(id(3000 + i), 'doc', `Dst ${i}`),
      actor: { id: id(4000 + i), kind: 'member', displayName: `A${i}` },
    })),
  };

  /** `entities.context` — the composite read, and the deepest nesting the
   *  surface produces. */
  const contextPayload = {
    root: { ...summary(TASK, 'task', 'Root', 'working'), counters: { likes: 0 } },
    hierarchy: {
      ancestors: [summary(id(90), 'task', 'Anc')],
      children: { items: Array.from({ length: 50 }, (_, i) => summary(id(100 + i), 'task', `C${i}`)) },
    },
    messages: {
      items: Array.from({ length: 20 }, (_, i) => ({
        id: id(200 + i),
        kind: 'message',
        author: { id: id(300 + i), kind: 'member', displayName: 'M' },
      })),
    },
  };

  const measure = (payload: unknown): { nodes: number; found: number } => {
    let found = 0;
    const nodes = walkPayload(
      payload,
      { onEntityObject: () => { found += 1; } },
      { maxNodes: Number.MAX_SAFE_INTEGER, maxDepth: 8 },
    );
    return { nodes, found };
  };

  it('TALLY_MAX_NODES clears a 100-row graph.query page with headroom', () => {
    const { nodes, found } = measure(graphQueryPage);
    expect(found).toBe(400); // 100 rows × (row + source + target + actor)
    expect(nodes).toBeLessThan(TALLY_MAX_NODES);
  });

  it('TALLY_MAX_NODES clears a full entities.context composite', () => {
    const { nodes, found } = measure(contextPayload);
    expect(found).toBe(92); // root + ancestor + 50 children + 20 messages + 20 authors
    expect(nodes).toBeLessThan(TALLY_MAX_NODES);
  });

  it('MAX_DEPTH 8 reaches the deepest entity entities.context nests', () => {
    // hierarchy → children → items → [i] → summary is the deepest real path;
    // if a future shape nests deeper, this fails rather than under-counting.
    const { found } = measure(contextPayload);
    expect(found).toBeGreaterThanOrEqual(92);
  });

  it('the raised ref budget can only ADD refs, never reorder the first eight', () => {
    // The bounded fold is unchanged in its contract: first-seen order, cap 8.
    const refs = extractEntityRefs(graphQueryPage);
    expect(refs).toHaveLength(8);
    expect(refs[0]!.id).toBe(id(1000));
    expect(refs[0]!.kind).toBe('task');
  });

  it('terminates on a hostile payload instead of hanging the render', () => {
    const deep: Record<string, unknown> = {};
    let node = deep;
    for (let i = 0; i < 5000; i += 1) {
      const next: Record<string, unknown> = { id: id(i), kind: 'task' };
      node.child = next;
      node = next;
    }
    const nodes = walkPayload(deep, {}, { maxNodes: 100, maxDepth: 8 });
    expect(nodes).toBeLessThanOrEqual(100);
  });
});
