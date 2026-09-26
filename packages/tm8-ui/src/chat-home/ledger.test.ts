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

/* ── L4 (2026-09-26): the shapes the server ACTUALLY sends ──────────────────
   Every case below reproduced a defect before the fix, against payloads
   shaped like this node's real chat transcripts: Claude records an MCP result
   as a JSON STRING (`tm8.mcp.result.v1` with the command result under
   `data`), entity writes answer with a `tm8.receipt.v1` by default, and a
   refused call is `state: 'error'` + an `is_error` result carrying a
   `tm8.mcp.error.v1` envelope. */

function settled(
  args: unknown,
  result: unknown,
  name: string,
  outcome: { state?: 'running' | 'completed' | 'error'; isError?: boolean } = {},
): ChatTurnPart[] {
  const toolCallId = `tc-${(seq += 1)}`;
  const parts: ChatTurnPart[] = [
    { kind: 'tool_call', seq: (seq += 1), toolCallId, name, args, state: outcome.state ?? 'completed' },
  ];
  if (result !== undefined) {
    parts.push({
      kind: 'tool_result',
      seq: (seq += 1),
      toolCallId,
      content: result,
      ...(outcome.isError !== undefined ? { isError: outcome.isError } : {}),
    });
  }
  return parts;
}

/** An MCP result as Claude records it: the envelope, JSON-encoded. */
const mcp = (tool: string, payload: Record<string, unknown>): string =>
  JSON.stringify({ schemaVersion: 'tm8.mcp.result.v1', tool, ...payload });
const mcpError = (code: string, message: string): string =>
  JSON.stringify({ schemaVersion: 'tm8.mcp.error.v1', error: { code, message, retryable: false } });
const receipt = (fields: Record<string, unknown>): Record<string, unknown> => ({
  schemaVersion: 'tm8.receipt.v1',
  ok: true,
  ...fields,
});

const ACT = 'mcp__tm8__tm8_act';
const DELEGATE = 'mcp__tm8__tm8_delegate';
const FORM = id(7);
const PARENT = id(8);

const complete = (entityId: string) => ({
  operation: 'entities.commands.complete',
  params: { id: entityId },
  body: { expectedVersion: 3 },
});
const createTask = (title: string, parentId?: string) => ({
  operation: 'entities.create',
  body: { spaceId: 'sp', kind: 'task', title, ...(parentId ? { parentId } : {}) },
});

describe('outcome guard — only an ACCEPTED write draws anything', () => {
  it('a FAILED complete draws no transition and leaves statusNow alone', () => {
    const ledger = buildChatLedger([
      turn(call({ operation: 'entities.get', params: { id: TASK } }, { entity: summary(TASK, 'task', 'T', 'working') })),
      turn(
        settled(complete(TASK), mcpError('acceptance_incomplete', 'unticked criteria'), ACT, {
          state: 'error',
          isError: true,
        }),
      ),
    ]);
    expect(ledger.transitions).toEqual([]);
    expect(ledger.statusNow.get(TASK)).toBe('working');
  });

  it('an error ENVELOPE is a refusal even when the runtime never flagged is_error', () => {
    const ledger = buildChatLedger([
      turn(settled(complete(TASK), mcpError('version_conflict', 'stale version'), ACT)),
    ]);
    expect(ledger.transitions).toEqual([]);
    expect(ledger.statusNow.has(TASK)).toBe(false);
  });

  it('a RUNNING complete draws nothing until the server answers', () => {
    const ledger = buildChatLedger([turn(settled(complete(TASK), undefined, ACT, { state: 'running' }))]);
    expect(ledger.transitions).toEqual([]);
  });

  it('a FAILED create draws no card and records no parent', () => {
    const ledger = buildChatLedger([
      turn(
        settled(createTask('T', PARENT), mcpError('invalid_input', 'parent kind mismatch'), ACT, {
          state: 'error',
          isError: true,
        }),
      ),
    ]);
    expect(ledger.creates).toEqual([]);
    expect(ledger.parentOf.size).toBe(0);
  });

  it('a RUNNING create draws nothing, even once a result has streamed in', () => {
    // The tool_result can land a beat before the call's `completed` record.
    const ledger = buildChatLedger([
      turn(settled(createTask('T'), mcp('tm8_act', { data: { entity: summary(TASK, 'task', 'T') } }), ACT, {
        state: 'running',
      })),
    ]);
    expect(ledger.creates).toEqual([]);
  });

  it('a failed spawn and a failed move change nothing either', () => {
    const ledger = buildChatLedger([
      turn(
        settled(
          { operation: 'execution.spawn', body: { teamMemberId: TEAMMATE, taskIds: [TASK] } },
          mcpError('forbidden', 'no seat'),
          DELEGATE,
          { state: 'error', isError: true },
        ),
        settled(
          { operation: 'entities.move', params: { id: TASK_CHILD }, body: { parentId: TASK } },
          mcpError('invalid_input', 'cycle'),
          ACT,
          { state: 'error', isError: true },
        ),
      ),
    ]);
    expect(ledger.creates).toEqual([]);
    expect(ledger.parentOf.has(TASK_CHILD)).toBe(false);
  });
});

describe('transition from-side — read BEFORE the call absorbs its own result', () => {
  it('a full command result carrying the NEW status does not become its own from-side', () => {
    const ledger = buildChatLedger([
      turn(call({ operation: 'entities.get', params: { id: TASK } }, { entity: summary(TASK, 'task', 'T', 'open') })),
      turn(
        settled(
          { operation: 'entities.commands.work', params: { id: TASK }, body: { status: 'working' }, full: true },
          mcp('tm8_act', { data: { entity: summary(TASK, 'task', 'T', 'working') } }),
          ACT,
        ),
      ),
    ]);
    expect(ledger.transitions.map((t) => [t.from, t.to])).toEqual([['open', 'working']]);
  });

  it('prefers the receipt’s server-read `status.from` over an unread (null) prior', () => {
    const ledger = buildChatLedger([
      turn(
        settled(
          { operation: 'entities.commands.work', params: { id: TASK }, body: { status: 'working' } },
          mcp('tm8_act', {
            operation: 'entities.commands.work',
            data: receipt({ op: 'task.transition', id: TASK, kind: 'task', title: 'T', status: { from: 'open', to: 'working' }, changed: ['state.status'] }),
          }),
          ACT,
        ),
      ),
    ]);
    expect(ledger.transitions.map((t) => [t.from, t.to])).toEqual([['open', 'working']]);
  });

  it('a receipt that proves the status did not move draws no transition', () => {
    const ledger = buildChatLedger([
      turn(
        settled(
          { operation: 'entities.commands.work', params: { id: TASK }, body: { status: 'working' } },
          mcp('tm8_act', {
            data: receipt({ op: 'task.transition', id: TASK, kind: 'task', status: { to: 'working' }, changed: [] }),
          }),
          ACT,
        ),
      ),
    ]);
    expect(ledger.transitions).toEqual([]);
    expect(ledger.statusNow.get(TASK)).toBe('working');
  });

  it('a write to the status this thread already read is a no-op, not `working → working`', () => {
    const ledger = buildChatLedger([
      turn(call({ operation: 'entities.get', params: { id: TASK } }, { entity: summary(TASK, 'task', 'T', 'working') })),
      turn(settled({ operation: 'entities.commands.work', params: { id: TASK }, body: { status: 'working' } }, { ok: true }, ACT)),
    ]);
    expect(ledger.transitions).toEqual([]);
  });

  it('learns the prior status from the legacy `state.workStatus` a durable transcript still carries', () => {
    const ledger = buildChatLedger([
      turn(
        call(
          { operation: 'collections.query', body: { kinds: ['task'] } },
          mcp('tm8_read', { data: { items: [{ id: TASK, kind: 'task', title: 'T', state: { kind: 'task', workStatus: 'in_review' } }] } }),
        ),
      ),
      turn(settled(complete(TASK), { ok: true }, ACT)),
    ]);
    expect(ledger.transitions.map((t) => [t.from, t.to])).toEqual([['in_review', 'done']]);
  });

  it('learns it from an entities.context v2 root, whose status is flat', () => {
    const ledger = buildChatLedger([
      turn(
        call(
          { operation: 'entities.context', params: { id: TASK } },
          mcp('tm8_read', { data: { schemaVersion: 'tm8.entity-context.v2', id: TASK, kind: 'task', title: 'T', status: 'blocked' } }),
        ),
      ),
      turn(settled({ operation: 'entities.commands.work', params: { id: TASK }, body: { status: 'working' } }, { ok: true }, ACT)),
    ]);
    expect(ledger.transitions.map((t) => [t.from, t.to])).toEqual([['blocked', 'working']]);
  });

  it('a form’s lifecycle transition is a transition too', () => {
    const ledger = buildChatLedger([
      turn(settled({ operation: 'forms.transition', params: { formId: FORM }, body: { expectedVersion: 1, to: 'closed' } }, { ok: true }, ACT)),
    ]);
    expect(ledger.transitions).toMatchObject([{ entityId: FORM, from: null, to: 'closed' }]);
  });
});

describe('create paths the fold did not recognise', () => {
  const docResult = (entityId: string, title: string) =>
    mcp('doc_create', { data: { entity: { id: entityId, kind: 'doc', title, parentId: null, state: { kind: 'doc' } } } });

  it('doc_create is a create: kind doc, id and title from the result', () => {
    const ledger = buildChatLedger([
      turn(settled({ spaceId: 'sp', title: 'Plan', body: '# Plan', attachTo: TASK }, docResult(DOC, 'Plan'), 'mcp__tm8__doc_create')),
    ]);
    expect(ledger.creates).toMatchObject([{ id: DOC, kind: 'doc', title: 'Plan', parentId: null, subjectId: TASK }]);
    expect(ledger.turns[0]!.reads.total).toBe(0);
  });

  it('artifact_create is a create of kind artifact', () => {
    const ledger = buildChatLedger([
      turn(
        settled(
          { spaceId: 'sp', name: 'Mockup' },
          mcp('artifact_create', { data: { entity: { id: DOC, kind: 'artifact', title: 'Mockup', parentId: null } } }),
          'mcp__tm8__artifact_create',
        ),
      ),
    ]);
    expect(ledger.creates).toMatchObject([{ id: DOC, kind: 'artifact', title: 'Mockup' }]);
  });

  it('a FAILED doc_create draws no card; a RUNNING one draws none yet', () => {
    const ledger = buildChatLedger([
      turn(
        settled({ spaceId: 'sp', title: 'Plan', body: 'x' }, mcpError('invalid_input', 'spaceId'), 'mcp__tm8__doc_create', {
          state: 'error',
          isError: true,
        }),
        settled({ spaceId: 'sp', title: 'Draft', body: 'x' }, undefined, 'mcp__tm8__doc_create', { state: 'running' }),
      ),
    ]);
    expect(ledger.creates).toEqual([]);
  });

  it('memory_write is a create of kind memory', () => {
    const ledger = buildChatLedger([
      turn(
        settled(
          { spaceId: 'sp', statement: 'Spawn, do not dispatch' },
          mcp('memory_write', { data: { entity: { id: MEMORY, kind: 'memory', title: 'Spawn, do not dispatch' } } }),
          'mcp__tm8__memory_write',
        ),
      ),
    ]);
    expect(ledger.creates).toMatchObject([{ id: MEMORY, kind: 'memory', title: 'Spawn, do not dispatch' }]);
  });

  it('form_create answers with a bare formId — still a create, titled from its args', () => {
    const ledger = buildChatLedger([
      turn(
        settled(
          { spaceId: 'sp', title: 'Pick a provider', questions: [], attachTo: [TASK] },
          mcp('form_create', { formId: FORM, version: 1, status: 'open', attachedTo: [] }),
          'mcp__tm8__form_create',
        ),
      ),
    ]);
    expect(ledger.creates).toMatchObject([{ id: FORM, kind: 'form', title: 'Pick a provider', subjectId: TASK }]);
  });

  it('forms.create and containers.create are birth verbs too', () => {
    const ledger = buildChatLedger([
      turn(
        settled(
          { operation: 'forms.create', body: { spaceId: 'sp', title: 'Q', questions: [] } },
          mcp('tm8_act', { data: { entity: { id: FORM, kind: 'form', title: 'Q' } } }),
          ACT,
        ),
        settled(
          { operation: 'containers.fork', params: { containerId: DOC }, body: { title: 'Box 2' } },
          mcp('tm8_act', { data: { entity: { id: MEMORY, kind: 'container', title: 'Box 2' } } }),
          ACT,
        ),
      ),
    ]);
    expect(ledger.creates.map((c) => [c.id, c.kind])).toEqual([[FORM, 'form'], [MEMORY, 'container']]);
  });

  it('a dispatch that SPAWNED its dispatcher created a session; one that did not, did not', () => {
    const dispatch = { operation: 'execution.dispatch', body: { spaceId: 'sp', subjectId: TASK } };
    const ledger = buildChatLedger([
      turn(
        settled(dispatch, mcp('tm8_delegate', { data: { taskId: TASK, dispatcherSessionId: SESSION, dispatcherSpawned: true, delivery: 'undelivered' } }), DELEGATE),
        settled(dispatch, mcp('tm8_delegate', { data: { taskId: TASK, dispatcherSessionId: id(9), dispatcherSpawned: false } }), DELEGATE),
      ),
    ]);
    expect(ledger.creates).toMatchObject([{ id: SESSION, kind: 'work_session', spawned: true, subjectId: TASK }]);
  });
});

describe('create details — title, parent, duplicates', () => {
  it('keeps the args title whole when the receipt clamps its echo', () => {
    const long = 'Find the prod task about rendering session terminals as chat UI (read-only search of tm8.sh)';
    const ledger = buildChatLedger([
      turn(
        settled(
          createTask(long),
          mcp('tm8_act', { data: receipt({ op: 'entity.create', id: TASK, kind: 'task', title: `${long.slice(0, 79)}…`, titleTruncated: true, parentId: null }) }),
          ACT,
        ),
      ),
    ]);
    expect(ledger.creates[0]!.title).toBe(long);
    expect(ledger.labels.get(TASK)?.title).toBe(long);
  });

  it('takes the parent from the RESULT — where the entity landed — over the args', () => {
    const ledger = buildChatLedger([
      turn(
        settled(
          createTask('Child', TASK_CHILD),
          mcp('tm8_act', { data: receipt({ op: 'entity.create', id: DOC, kind: 'task', title: 'Child', parentId: PARENT }) }),
          ACT,
        ),
      ),
    ]);
    expect(ledger.creates[0]!.parentId).toBe(PARENT);
    expect(ledger.parentOf.get(DOC)).toBe(PARENT);
  });

  it('a replayed create (same entity answered twice, two turns) is ONE create', () => {
    const create = () =>
      settled(createTask('T'), mcp('tm8_act', { data: { entity: summary(TASK, 'task', 'T') } }), ACT);
    const ledger = buildChatLedger([turn(create()), turn(create())]);
    expect(ledger.creates).toHaveLength(1);
    expect(ledger.turns.map((t) => t.creates.length)).toEqual([1, 0]);
  });

  it('a spawned session carries its task and model from the spawn itself', () => {
    const ledger = buildChatLedger([
      turn(
        settled(
          { operation: 'execution.spawn', body: { teamMemberId: TEAMMATE, taskIds: [TASK], mode: 'coordinated-worker' } },
          mcp('tm8_delegate', {
            data: { entity: { id: SESSION, kind: 'work_session', title: 'Worker', state: { kind: 'work_session', status: 'running', model: 'claude-opus-5-5' } } },
          }),
          DELEGATE,
        ),
      ),
    ]);
    expect(ledger.creates[0]).toMatchObject({ id: SESSION, spawned: true, subjectId: TASK, title: 'Worker', model: 'claude-opus-5-5' });
  });
});

describe('edits (advisor D11)', () => {
  it('folds accepted non-status edits with what moved, and skips a verified no-op', () => {
    const ledger = buildChatLedger([
      turn(
        settled(
          { operation: 'entities.patch', params: { id: TASK }, body: { expectedVersion: 1, content: { description: 'x' } } },
          mcp('tm8_act', { data: receipt({ op: 'entity.update', id: TASK, changed: ['content.description'] }) }),
          ACT,
        ),
        settled({ operation: 'entities.commands.tick', params: { id: TASK_CHILD }, body: { criterionIds: ['c1'] } }, { ok: true }, ACT),
        settled(
          { operation: 'entities.patch', params: { id: DOC }, body: { expectedVersion: 1, title: 'Same' } },
          mcp('tm8_act', { data: receipt({ op: 'entity.update', id: DOC, changed: [] }) }),
          ACT,
        ),
        settled({ operation: 'entities.patch', params: { id: MEMORY }, body: { title: 'X' } }, mcpError('conflict', 'v'), ACT, {
          state: 'error',
          isError: true,
        }),
      ),
    ]);
    expect(ledger.turns[0]!.edits.map((e) => [e.entityId, e.what])).toEqual([
      [TASK, ['description']],
      [TASK_CHILD, ['acceptance criteria']],
    ]);
  });
});
