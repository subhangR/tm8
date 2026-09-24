// @vitest-environment jsdom
/**
 * `toolNote` — a host's one-line note under a tool call (Craft names the
 * blueprint nodes a patch changed). Additive: absent, a plain patch call
 * still renders NOTHING (the no-tool-boxes law); present, only the host's
 * sentence appears — never the tool name or its payload.
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
  it('absent: a plain patch call renders nothing, exactly as before', () => {
    const view = render(<TurnParts parts={parts} />);
    expect(view.container.querySelector('.tch-ledger')).toBeNull();
    expect(view.container.textContent).toBe('');
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
    expect(view.container.textContent).not.toContain('tm8_act');
    expect(view.container.textContent).not.toContain('entities.patch');
    const last = seen[seen.length - 1]!;
    expect(last.state).toBe('completed');
    expect(last.result).toEqual({ id: GRAPH, kind: 'graph', version: 3 });
  });

  it('a host that returns null adds nothing', () => {
    const view = render(<TurnParts parts={parts} toolNote={() => null} />);
    expect(view.container.querySelector('.tch-ledger')).toBeNull();
  });
});
