// @vitest-environment jsdom
/**
 * TURN GRAPH — the pure fold of chat tool calls and its strip mount.
 *
 * The graph derives from the SAME turns + `extractEntityRefs` walk the chips
 * use, so these tests feed it turns, never a server: no port, no reads, by
 * design. Entity ids must be UUIDv7 or the extractor (correctly) ignores them.
 */
import { describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { LiveGraphStrip } from '../channel-screen/LiveToolGraph';
import { foldTurnGraph, toolVerb } from './turn-graph';
import type { ChatTurn, ChatTurnPart } from './types';

const TASK = '01900000-0000-7000-8000-00000000aaaa';
const DOC = '01900000-0000-7000-8000-00000000bbbb';
const OWN_MSG = '01900000-0000-7000-8000-00000000cccc';

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

const turn = (parts: ChatTurnPart[], createdAt = '2026-08-15T10:00:00.000Z'): ChatTurn => ({
  messageId: `msg-${(seq += 1)}` as EntityId,
  role: 'assistant',
  author: null,
  createdAt,
  body: '',
  parts,
});

describe('foldTurnGraph', () => {
  it('one node per distinct referenced entity; repeat tool calls accumulate, never add nodes', () => {
    const model = foldTurnGraph([
      turn([
        ...call('tm8_update_entity', { id: TASK }, { id: TASK, kind: 'task', title: 'Fix login' }),
        ...call('tm8_update_entity', { entityId: TASK }),
        ...call('tm8_create_entity', {}, { id: DOC, kind: 'doc', title: 'Runbook' }),
      ]),
    ]);
    expect(model.touches.map((t) => t.id)).toEqual([TASK, DOC]);
    expect(model.activityCount).toBe(3);
    const task = model.touches[0]!;
    expect(task.count).toBe(2);
    expect(task.verbs).toEqual({ tm8_update_entity: 2 });
    expect(task.title).toBe('Fix login');
    expect(task.kind).toBe('task');
  });

  it('placement order is FIRST reference, stable while later turns stream in', () => {
    const early = foldTurnGraph([turn(call('tm8_get', { id: DOC }))]);
    const later = foldTurnGraph([
      turn(call('tm8_get', { id: DOC })),
      turn([...call('tm8_update', { id: TASK }), ...call('tm8_update', { id: DOC })]),
    ]);
    expect(early.touches[0]!.id).toBe(DOC);
    expect(later.touches.map((t) => t.id)).toEqual([DOC, TASK]);
  });

  it('suppresses this thread\'s own message ids and ignores non-entity payloads', () => {
    const model = foldTurnGraph(
      [
        turn([
          ...call('tm8_send_message', { messageId: OWN_MSG }),
          ...call('Bash', { command: 'ls -la' }),
          { kind: 'text', seq: (seq += 1), text: 'done' },
        ]),
      ],
      new Set([OWN_MSG]),
    );
    expect(model.touches).toHaveLength(0);
    expect(model.activityCount).toBe(0);
  });

  it('a bare id chips with a truncated label, upgraded when a richer result names it', () => {
    const bare = foldTurnGraph([turn(call('tm8_get', { taskId: TASK }))]);
    expect(bare.touches[0]!.title).toBe(`${TASK.slice(0, 8)}…${TASK.slice(-4)}`);
    expect(bare.touches[0]!.kind).toBe('entity');
    const upgraded = foldTurnGraph([
      turn(call('tm8_get', { taskId: TASK })),
      turn(call('tm8_get', {}, { id: TASK, kind: 'task', title: 'Fix login' })),
    ]);
    expect(upgraded.touches[0]!.title).toBe('Fix login');
    expect(upgraded.touches[0]!.kind).toBe('task');
  });

  it('strips MCP server prefixes off the edge verb', () => {
    expect(toolVerb('mcp__tm8__tm8_update_entity')).toBe('tm8_update_entity');
    expect(toolVerb('tm8_update_entity')).toBe('tm8_update_entity');
  });
});

describe('LiveGraphStrip over a turn fold', () => {
  it('renders nothing when no tool call referenced an entity', () => {
    render(
      <LiveGraphStrip
        model={foldTurnGraph([turn(call('Bash', { command: 'pwd' }))])}
        anchorNoun="this conversation"
        focusKind="message"
      />,
    );
    expect(screen.queryByTestId('chs-livegraph')).toBeNull();
    cleanup();
  });

  it('draws the star by default with honest counts; nodes open entities', () => {
    const opened: string[] = [];
    render(
      <LiveGraphStrip
        model={foldTurnGraph([
          turn([
            ...call('tm8_update', {}, { id: TASK, kind: 'task', title: 'Fix login' }),
            ...call('tm8_update', { id: TASK }),
            ...call('tm8_create', {}, { id: DOC, kind: 'doc', title: 'Runbook' }),
          ]),
        ])}
        anchorNoun="this conversation"
        focusKind="message"
        onOpenEntity={(id) => opened.push(id)}
      />,
    );
    const toggle = screen.getByRole('button', { name: /live graph/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain('2 entities');
    expect(toggle.textContent).toContain('3 touches');
    expect(
      screen.getByRole('img', { name: /this conversation touched 2 entities/i }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /task: fix login/i }));
    expect(opened).toEqual([TASK]);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    cleanup();
  });
});
