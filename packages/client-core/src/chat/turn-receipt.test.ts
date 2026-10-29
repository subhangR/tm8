/**
 * THE RECEIPT FOLD (`turn-receipt.ts`) — one row per entity per run. The
 * claims under test are the ones a wrong answer would draw twice or not at
 * all: a create and its moves are one row; a worker is a pill on its task,
 * not a second row with the same title; an edge nests; a running write is
 * pending in place; a refused one is a red row unless it was retried; and the
 * step list leaves out exactly the calls a row stands for.
 */
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { buildChatLedger } from './ledger';
import { flattenReceipt, buildTurnReceipt, type TurnReceipt } from './turn-receipt';
import { projectTurnParts } from './turn-model';
import { buildStepViews, isStepTool } from './turn-step-lines';
import type { ChatTurn, ChatTurnPart } from './types';

const id = (n: number): string => `01a14a99-0000-7000-8000-${String(n).padStart(12, '0')}`;
const TASK = id(1);
const CHILD = id(2);
const DOC = id(3);
const SESSION = id(4);
const OTHER = id(5);
const ACT = 'mcp__tm8__tm8_act';
const receipt = (fields: Record<string, unknown>) => ({ schemaVersion: 'tm8.receipt.v1', ok: true, ...fields });
const refused = { schemaVersion: 'tm8.mcp.error.v1', error: { code: 'version_conflict', message: 'version conflict' } };

let seq = 0;
function call(name: string, args: unknown, result?: unknown, state: 'completed' | 'error' | 'running' = 'completed'): ChatTurnPart[] {
  const toolCallId = `tc-${(seq += 1)}`;
  const parts: ChatTurnPart[] = [{ kind: 'tool_call', seq: (seq += 1), toolCallId, name, args, state }];
  if (result !== undefined) {
    parts.push({ kind: 'tool_result', seq: (seq += 1), toolCallId, content: result, ...(state === 'error' ? { isError: true } : {}) });
  }
  return parts;
}
const createTask = (entityId: string, title: string, parentId: string | null = null) =>
  call(ACT, { operation: 'entities.create', body: { kind: 'task', title, parentId } }, receipt({ id: entityId, kind: 'task', title, parentId, status: { to: 'open' } }));
const work = (entityId: string, to: string, from = 'open') =>
  call(ACT, { operation: 'entities.commands.work', params: { id: entityId }, body: { status: to } }, receipt({ id: entityId, kind: 'task', status: { from, to }, changed: ['state.status'] }));
const tick = (entityId: string) =>
  call(ACT, { operation: 'entities.commands.tick', params: { id: entityId }, body: { criterionIds: ['c1'] } }, receipt({ id: entityId, kind: 'task', changed: ['content.acceptanceCriteria'] }));
const spawn = (sessionId: string, taskId: string) =>
  call('mcp__tm8__tm8_delegate', { operation: 'execution.spawn', body: { taskIds: [taskId] } }, { entity: { id: sessionId, kind: 'work_session', title: 'Worker', state: { status: 'running' } } });
const edge = (srcId: string, dstId: string, type: string) =>
  call(ACT, { operation: 'edges.create', body: { srcId, dstId, type } }, receipt({}));

/** The receipt of a one-run turn, folded exactly as `TurnParts` folds it. */
function receiptOf(...calls: ChatTurnPart[][]): TurnReceipt & { steps: number[] } {
  const parts = calls.flat();
  const turn: ChatTurn = { messageId: 'm1' as EntityId, role: 'assistant', author: null, createdAt: '', body: '', parts };
  const ledger = buildChatLedger([turn]);
  const steps = projectTurnParts(parts).filter(isStepTool);
  const views = buildStepViews(steps, { settled: false, endSeq: -1, labels: ledger.labels });
  return { ...buildTurnReceipt({ steps, views, turn: ledger.turns[0], labels: ledger.labels }), steps: steps.map((s) => s.seq) };
}

const shape = (r: TurnReceipt) =>
  flattenReceipt(r.rows).map(({ row, depth }) => `${'  '.repeat(depth)}${row.mark} ${row.entityId ?? row.text}`);

describe('one row per entity', () => {
  it('folds a create, its moves and its edits in one run into ONE row with the net move', () => {
    const r = receiptOf(createTask(TASK, 'T'), work(TASK, 'working'), tick(TASK), work(TASK, 'in_review', 'working'));
    expect(shape(r)).toEqual([`made ${TASK}`]);
    const [row] = r.rows;
    expect(row!.move).toEqual({ from: 'open', to: 'in_review' });
    expect(row!.edits).toEqual(['acceptance criteria']);
    // Every one of those calls is the row: the step list leaves them all out.
    expect([...r.seqs].sort((a, b) => a - b)).toEqual(r.steps);
  });

  it('marks what happened by rank: made > moved > edited', () => {
    expect(shape(receiptOf(work(TASK, 'working'), tick(TASK)))).toEqual([`moved ${TASK}`]);
    expect(shape(receiptOf(tick(TASK)))).toEqual([`edited ${TASK}`]);
  });

  it('a settled doc_update is an edited doc row', () => {
    const r = receiptOf(call('mcp__tm8__doc_update', { docId: DOC, body: '#' }, { ok: true }));
    expect(r.rows[0]).toMatchObject({ mark: 'edited', entityId: DOC, kind: 'doc', edits: ['body'] });
  });

  it('skips an edit a host already narrated, and keeps its call in the step list', () => {
    const parts = tick(TASK);
    const turn: ChatTurn = { messageId: 'm1' as EntityId, role: 'assistant', author: null, createdAt: '', body: '', parts };
    const ledger = buildChatLedger([turn]);
    const steps = projectTurnParts(parts).filter(isStepTool);
    const views = buildStepViews(steps, { settled: true, endSeq: -1 });
    const r = buildTurnReceipt({ steps, views, turn: ledger.turns[0], skipEdits: new Set([steps[0]!.seq]) });
    expect(r.rows).toHaveLength(0);
    expect(r.seqs.size).toBe(0);
  });
});

describe('a worker folds into its task', () => {
  it('is a pill on its task’s row — not a second row with the same title', () => {
    const r = receiptOf(createTask(TASK, 'Fix the loading page'), spawn(SESSION, TASK));
    expect(shape(r)).toEqual([`made ${TASK}`]);
    expect(r.rows[0]!.sessions.map((s) => s.id)).toEqual([SESSION]);
    expect(r.seqs.size).toBe(2);
  });

  it('is its own row, naming its task, when the task has no row in the run', () => {
    const r = receiptOf(spawn(SESSION, TASK));
    expect(r.rows[0]).toMatchObject({ mark: 'made', entityId: SESSION, kind: 'work_session' });
    expect(r.rows[0]!.session!.subjectId).toBe(TASK);
  });
});

describe('nesting — hierarchy, attachments and links', () => {
  it('nests a child and an attached doc under their task; a parent sits where its subtree began', () => {
    const r = receiptOf(
      createTask(TASK, 'Parent'),
      call('mcp__tm8__doc_create', { title: 'D', body: 'x', attachTo: TASK }, receipt({ id: DOC, kind: 'doc', title: 'D' })),
      createTask(CHILD, 'Child', TASK),
    );
    expect(shape(r)).toEqual([`made ${TASK}`, `  made ${DOC}`, `  made ${CHILD}`]);
  });

  it('a produced entity nests under its producer, even when the producer was only moved here', () => {
    const r = receiptOf(createTask(CHILD, 'Doc-ish'), work(TASK, 'in_review', 'working'), edge(TASK, CHILD, 'produces'));
    // The task moved LAST but heads the row it produced.
    expect(shape(r)).toEqual([`moved ${TASK}`, `  made ${CHILD}`]);
    expect(r.rows[0]!.children[0]!.link).toEqual({ type: 'produces', otherId: null });
  });

  it('a link to something made elsewhere is a linked row under the row it joins', () => {
    const r = receiptOf(createTask(TASK, 'T'), edge(TASK, OTHER, 'produces'));
    expect(shape(r)).toEqual([`made ${TASK}`, `  linked ${OTHER}`]);
  });

  it('a link that nests nothing is a fact on its source row, or a linked row of its own', () => {
    const onRow = receiptOf(createTask(TASK, 'T'), edge(TASK, OTHER, 'depends_on'));
    expect(shape(onRow)).toEqual([`made ${TASK}`]);
    expect(onRow.rows[0]!.link).toEqual({ type: 'depends_on', otherId: OTHER });
    const alone = receiptOf(edge(TASK, OTHER, 'depends_on'));
    expect(shape(alone)).toEqual([`linked ${TASK}`]);
  });

  it('a nest that loops is cut, so every row still renders exactly once', () => {
    const r = receiptOf(createTask(TASK, 'A', CHILD), createTask(CHILD, 'B', TASK));
    const ids = flattenReceipt(r.rows).map(({ row }) => row.entityId);
    expect(ids.sort()).toEqual([TASK, CHILD].sort());
  });
});

describe('pending, failed, retried', () => {
  it('a running write is a pending row keyed by its call, so the real row replaces it in place', () => {
    const running = call(ACT, { operation: 'entities.create', body: { kind: 'task', title: 'Soon' } }, undefined, 'running');
    const r = receiptOf(running);
    expect(r.rows[0]).toMatchObject({ mark: 'pending', entityId: null, kind: 'task', text: 'Creating task “Soon”' });
    const settled = receiptOf(createTask(TASK, 'Soon'));
    // Same shape of key — `r<seq of the create call>` — in both.
    expect(r.rows[0]!.key).toMatch(/^r\d+$/);
    expect(settled.rows[0]!.key).toMatch(/^r\d+$/);
  });

  it('a refused write is a failed row with the server’s reason, aimed at its target', () => {
    const r = receiptOf(call(ACT, { operation: 'entities.commands.complete', params: { id: TASK } }, refused, 'error'));
    expect(r.rows[0]).toMatchObject({ mark: 'failed', entityId: TASK, reason: 'version conflict' });
    expect(r.retried.size).toBe(0);
  });

  it('a refused write a later call fixed is no row — only counted as retried', () => {
    const failing = call(ACT, { operation: 'entities.commands.tick', params: { id: TASK }, body: {} }, refused, 'error');
    const r = receiptOf(failing, tick(TASK));
    expect(shape(r)).toEqual([`edited ${TASK}`]);
    expect(r.retried.size).toBe(1);
    expect(r.seqs.size).toBe(2);
  });

  it('a write the receipt cannot draw stays a step line', () => {
    const r = receiptOf(call(ACT, { operation: 'messages.post', body: { text: 'hi' } }, { ok: true }));
    expect(r.rows).toHaveLength(0);
    expect(r.seqs.size).toBe(0);
  });
});
