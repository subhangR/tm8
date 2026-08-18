/**
 * THE FLEET FOLD — the delegation record read out of the transcript.
 *
 * The claim under test is narrow and load-bearing: a conversation that spawns
 * workers already SAYS SO in its tool-call payloads, so the Cockpit needs no
 * new record to render its fleet. Everything here is the honesty of that
 * reading — which side of a call produced an id, which verb was actually
 * called, and what happens when any of it is missing.
 */
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { MAX_FLEET_REFS, foldFleet, originSentence } from './fleet-model';
import type { ChatTurn, ChatTurnPart } from '../types';

const id = (n: number): string => `01a01400-00cc-7000-8000-${String(n).padStart(12, '0')}`;
const TASK = id(1);
const SESSION = id(2);
const TEAMMATE = id(3);
const DOC = id(4);

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
  createdAt: '2026-08-18T12:00:00.000Z',
  body: '',
  parts,
});

/** The shape a real `tm8_delegate` spawn takes: the group schema's
 *  `{operation, body}` in, the created work session out. */
const spawn = (taskId: string, sessionId: string): ChatTurnPart[] =>
  call(
    'mcp__tm8__tm8_delegate',
    {
      operation: 'execution.spawn',
      body: { spaceId: 'space-1', teamMemberId: TEAMMATE, taskIds: [taskId], mode: 'worker' },
    },
    { id: sessionId, kind: 'work_session', title: 'Opus 5 · fleet lane' },
  );

describe('foldFleet — which side of the call produced the id', () => {
  it('a spawn PRODUCES the session and is HANDED the task; the two never collapse', () => {
    const { refs } = foldFleet([turn(spawn(TASK, SESSION))]);
    const session = refs.find((r) => r.id === SESSION);
    const task = refs.find((r) => r.id === TASK);

    expect(session).toMatchObject({ origin: 'spawned', kind: 'work_session', title: 'Opus 5 · fleet lane' });
    expect(task).toMatchObject({ origin: 'delegated' });
    // The teammate rode along in the args and is honestly `delegated` too — it
    // is a real reference, and inventing a fourth origin for it would claim
    // knowledge of kind the fold does not have.
    expect(refs.find((r) => r.id === TEAMMATE)?.origin).toBe('delegated');
  });

  it('dispatch is kept apart from spawn — the dispatcher chose, we did not', () => {
    const { refs } = foldFleet([
      turn(
        call(
          'tm8_delegate',
          { operation: 'execution.dispatch', body: { spaceId: 'space-1', subjectId: TASK } },
          { id: SESSION },
        ),
      ),
    ]);
    expect(refs.find((r) => r.id === SESSION)?.origin).toBe('dispatched');
    expect(refs.find((r) => r.id === TASK)?.origin).toBe('delegated');
  });

  it('the operation is READ, never inferred from the tool name', () => {
    // Same tool, no recognised operation: the call produced something, but we
    // cannot say what act it was. `delegated` is the floor — never `spawned`.
    const { refs } = foldFleet([
      turn(call('tm8_delegate', { operation: 'execution.somethingNew' }, { id: SESSION })),
    ]);
    expect(refs.find((r) => r.id === SESSION)?.origin).toBe('delegated');
  });

  it('a delegate call with unparseable args still yields refs, at the floor', () => {
    const { refs } = foldFleet([turn(call('tm8_delegate', 'not-an-object', { id: SESSION }))]);
    expect(refs.find((r) => r.id === SESSION)?.origin).toBe('delegated');
  });
});

describe('foldFleet — lifecycle is recorded beside origin, never over it', () => {
  it('spawned then terminated is TWO facts', () => {
    const { refs } = foldFleet([
      turn(spawn(TASK, SESSION)),
      turn(call('tm8_delegate', { operation: 'execution.terminate', params: { id: SESSION } }, {})),
    ]);
    const session = refs.find((r) => r.id === SESSION)!;
    expect(session.origin).toBe('spawned');
    expect(session.lifecycle).toEqual(['terminated']);
    expect(originSentence(session)).toBe('Spawned from this conversation · terminated here');
  });

  it('a lifecycle verb is recorded once however often it is called', () => {
    const resume = call('tm8_delegate', { operation: 'execution.resume', params: { id: SESSION } }, {});
    const { refs } = foldFleet([turn([...resume, ...resume])]);
    expect(refs.find((r) => r.id === SESSION)?.lifecycle).toEqual(['resumed']);
  });
});

describe('foldFleet — origin accumulates upward only', () => {
  it('a later mention does not demote a session this thread spawned', () => {
    const { refs } = foldFleet([
      turn(spawn(TASK, SESSION)),
      turn(call('tm8_read', { id: SESSION })),
    ]);
    expect(refs.find((r) => r.id === SESSION)?.origin).toBe('spawned');
  });

  it('an earlier mention IS promoted when the thread later spawns it', () => {
    const { refs } = foldFleet([
      turn(call('tm8_read', { id: SESSION })),
      turn(spawn(TASK, SESSION)),
    ]);
    expect(refs.find((r) => r.id === SESSION)?.origin).toBe('spawned');
    // First-reference order is preserved through the promotion — a row that
    // moved when its origin sharpened would jump under the viewer's cursor.
    expect(refs[0]?.id).toBe(SESSION);
  });

  it('a write-shaped non-delegate call reads as created; a read does not', () => {
    const { refs } = foldFleet([
      turn(call('mcp__tm8__tm8_act', { operation: 'entities.create' }, { id: TASK })),
      turn(call('tm8_read', { id: DOC })),
    ]);
    expect(refs.find((r) => r.id === TASK)).toMatchObject({ origin: 'created', mutated: true });
    expect(refs.find((r) => r.id === DOC)).toMatchObject({ origin: 'referenced', mutated: false });
  });

  /**
   * THE DEFECT THIS FOLD REFUSES TO INHERIT. Chat writes the graph through two
   * GROUP tools whose names carry no verb, so a name-only classifier — which
   * is what `graph-seeds.ts` ships — calls every chat mutation a read. These
   * two cases are the exact calls that regress there; they must pass here.
   */
  it('classifies the GROUP tools by their operation, which is where chat’s verb lives', () => {
    const { refs } = foldFleet([
      turn(call('mcp__tm8__tm8_act', { operation: 'entities.update' }, { id: TASK })),
      turn(call('mcp__tm8__tm8_act', { operation: 'entities.get' }, { id: DOC })),
    ]);
    expect(refs.find((r) => r.id === TASK)?.mutated).toBe(true);
    // A read operation on the very same group tool stays a read.
    expect(refs.find((r) => r.id === DOC)?.mutated).toBe(false);
  });

  it('a direct tool still classifies by its name, which does carry its verb', () => {
    const { refs } = foldFleet([turn(call('Edit', { path: 'x', id: TASK }))]);
    expect(refs.find((r) => r.id === TASK)?.mutated).toBe(true);
  });
});

describe('foldFleet — the cap counts, it does not swallow', () => {
  it('every ref is folded; only the draw set is capped, and the rest is reported', () => {
    const parts = Array.from({ length: MAX_FLEET_REFS + 5 }, (_, n) =>
      call('tm8_read', { id: id(100 + n) }),
    ).flat();
    const fold = foldFleet([turn(parts)]);
    expect(fold.refs).toHaveLength(MAX_FLEET_REFS + 5);
    expect(fold.drawn).toHaveLength(MAX_FLEET_REFS);
    expect(fold.overflow).toBe(5);
  });
});

describe('foldFleet — suppression applies at merge', () => {
  it('the thread’s own message ids never become fleet rows', () => {
    const own = new Set([SESSION]);
    const { refs } = foldFleet([turn(spawn(TASK, SESSION))], own);
    expect(refs.some((r) => r.id === SESSION)).toBe(false);
    expect(refs.some((r) => r.id === TASK)).toBe(true);
  });

  it('a turn folded once under one suppression set folds correctly under another', () => {
    // The per-turn cache is keyed on the turn object and must not have baked
    // the suppression in — a growing own-id set would otherwise permanently
    // poison every settled turn.
    const shared = turn(spawn(TASK, SESSION));
    expect(foldFleet([shared], new Set([SESSION])).refs.some((r) => r.id === SESSION)).toBe(false);
    expect(foldFleet([shared]).refs.some((r) => r.id === SESSION)).toBe(true);
  });
});
