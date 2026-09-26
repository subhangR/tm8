// @vitest-environment jsdom
/**
 * `toolNote` — a host's one-line note under a tool call (Craft names the
 * blueprint nodes a patch changed). Absent, a plain patch call draws its
 * counted step (advisor D15) and the ledger's quiet edit line (D11) — never a
 * box, the tool name or its payload; present, the host's sentence STANDS IN
 * for that edit line rather than saying the same edit twice.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TurnParts, type ToolNoteInput } from './TurnParts';
import type { ChatTurnPart } from './types';

afterEach(cleanup);

const GRAPH = '01a0d3c5-0000-7000-8000-0000000000aa';
const parts: ChatTurnPart[] = [
  {
    seq: 1,
    kind: 'tool_call',
    toolCallId: 't1',
    name: 'mcp__tm8__tm8_act',
    args: { operation: 'entities.patch', params: { id: GRAPH }, body: { expectedVersion: 2, content: { nodes: [] } } },
    state: 'completed',
  },
  { seq: 2, kind: 'tool_result', toolCallId: 't1', content: { id: GRAPH, kind: 'graph', version: 3 } },
];

describe('toolNote', () => {
  it('absent: a plain patch call draws its counted step and the quiet edit line — nothing else', () => {
    const view = render(<TurnParts parts={parts} />);
    expect(view.getByTestId('chat-steps-head').textContent).toContain('1 step');
    expect(view.getByTestId('chat-ledger-edit').textContent).toMatch(/^✎ Edited Graph \(nodes\)$/);
    expect(view.container.textContent).not.toContain('tm8_act');
    expect(view.container.textContent).not.toContain('entities.patch');
  });

  it('present: the host sees the settled call and its note renders under it — and nothing else does', () => {
    const seen: ToolNoteInput[] = [];
    const view = render(
      <TurnParts
        parts={parts}
        toolNote={(call) => {
          seen.push(call);
          return <span data-testid="host-note">Updated the blueprint</span>;
        }}
      />,
    );
    expect(view.getByTestId('host-note').textContent).toBe('Updated the blueprint');
    // The host narrated this edit; the generic line does not repeat it.
    expect(view.queryByTestId('chat-ledger-edit')).toBeNull();
    expect(view.container.textContent).not.toContain('tm8_act');
    expect(view.container.textContent).not.toContain('entities.patch');
    const last = seen[seen.length - 1]!;
    expect(last.state).toBe('completed');
    expect(last.result).toEqual({ id: GRAPH, kind: 'graph', version: 3 });
  });

  it('a host that returns null adds nothing — the call reads exactly as with no host', () => {
    // Text, not innerHTML: two renders mint different `useId` values.
    const bare = render(<TurnParts parts={parts} />).container.textContent;
    cleanup();
    const view = render(<TurnParts parts={parts} toolNote={() => null} />);
    expect(view.container.textContent).toBe(bare);
    expect(view.getByTestId('chat-ledger-edit')).toBeTruthy();
  });
});
