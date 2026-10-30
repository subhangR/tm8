// @vitest-environment jsdom
/**
 * CHAT SHOWS ITS MCP USAGE (task 01a18e32).
 *
 * When a turn calls the tm8 MCP, the reader can see that it did — the turn's
 * step header counts it, an open run ends in `Used tm8 MCP · N calls` — and
 * can open any call to its raw Input and Output. Nothing raw renders until
 * asked: a settled, folded turn still has no tool name, no `<pre>`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { formatPayload, mcpToolName, PAYLOAD_LIMIT } from './mcp-calls';
import { TurnParts } from './TurnParts';
import type { ChatTurnPart } from './types';

afterEach(cleanup);

const TASK_ID = '019f0000-0000-7000-8000-000000000031';

let seq = 0;
function call(name: string, args: unknown, result?: { content: unknown; isError?: boolean }): ChatTurnPart[] {
  const toolCallId = `c${(seq += 1)}`;
  const parts: ChatTurnPart[] = [{ seq: (seq += 1), kind: 'tool_call', toolCallId, name, args, state: 'running' }];
  if (result) {
    parts.push({
      seq: (seq += 1),
      kind: 'tool_result',
      toolCallId,
      content: result.content,
      ...(result.isError ? { isError: true } : {}),
    });
  }
  return parts;
}

const READ = (): ChatTurnPart[] =>
  call(
    'mcp__tm8__tm8_read',
    { operation: 'entities.get', params: { id: TASK_ID } },
    { content: [{ type: 'text', text: JSON.stringify({ entity: { id: TASK_ID, kind: 'task', title: 'Ship it' } }) }] },
  );

describe('mcpToolName', () => {
  it('reads both runtimes’ MCP names and leaves native tools alone', () => {
    expect(mcpToolName('mcp__tm8__tm8_read')).toEqual({ server: 'tm8', tool: 'tm8_read' });
    expect(mcpToolName('tm8.tm8_act')).toEqual({ server: 'tm8', tool: 'tm8_act' });
    expect(mcpToolName('mcp__github__create_issue')).toEqual({ server: 'github', tool: 'create_issue' });
    expect(mcpToolName('Bash')).toBeNull();
    expect(mcpToolName('tm8_read')).toBeNull();
  });
});

describe('formatPayload', () => {
  it('unwraps text content blocks and pretty-prints their JSON', () => {
    expect(formatPayload([{ type: 'text', text: '{"a":1}' }])).toBe('{\n  "a": 1\n}');
    expect(formatPayload({ operation: 'entities.get' })).toBe('{\n  "operation": "entities.get"\n}');
    expect(formatPayload('plain words')).toBe('plain words');
  });

  it('clips a huge payload and says how much it cut', () => {
    const text = formatPayload('x'.repeat(PAYLOAD_LIMIT + 5));
    expect(text.startsWith('x'.repeat(PAYLOAD_LIMIT))).toBe(true);
    expect(text).toContain('5 more characters');
  });
});

describe('a turn that used the tm8 MCP', () => {
  it('counts it in the folded header, with nothing raw on screen', () => {
    const parts = [...READ(), ...READ(), { seq: (seq += 1), kind: 'done' } as ChatTurnPart];
    const view = render(<TurnParts parts={parts} settled />);

    expect(view.getByTestId('chat-steps-mcp').textContent).toBe(' · 2 tm8 MCP calls');
    expect(view.queryByTestId('chat-mcp')).toBeNull();
    expect(view.container.textContent).not.toContain('tm8_read');
    expect(view.container.querySelectorAll('pre')).toHaveLength(0);
  });

  it('opens to each call, and each call to its input and output', () => {
    const parts = [...READ(), { seq: (seq += 1), kind: 'done' } as ChatTurnPart];
    const view = render(<TurnParts parts={parts} settled />);
    fireEvent.click(view.getByTestId('chat-steps-head'));

    const toggle = view.getByTestId('chat-mcp-toggle');
    expect(toggle.textContent).toContain('Used tm8 MCP · 1 call');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    const [entry] = view.getAllByTestId('chat-mcp-call');
    expect(entry!.dataset.state).toBe('completed');
    expect(entry!.textContent).toContain('tm8_read');
    expect(entry!.textContent).toContain('entities.get');
    expect(within(entry!).queryByTestId('chat-mcp-payload')).toBeNull();

    fireEvent.click(within(entry!).getByRole('button'));
    expect(within(entry!).getByTestId('chat-mcp-input').textContent).toContain('"operation": "entities.get"');
    // The content-block envelope is unwrapped: the tool's own answer shows.
    const output = within(entry!).getByTestId('chat-mcp-output').textContent ?? '';
    expect(output).toContain('"title": "Ship it"');
    expect(output).not.toContain('"type": "text"');
  });

  it('shows a live call as waiting, and a failed one as an error', () => {
    const live = render(<TurnParts parts={call('mcp__tm8__tm8_act', { operation: 'entities.create' })} />);
    fireEvent.click(live.getByTestId('chat-mcp-toggle'));
    const [running] = live.getAllByTestId('chat-mcp-call');
    expect(running!.dataset.state).toBe('running');
    fireEvent.click(within(running!).getByRole('button'));
    expect(running!.textContent).toContain('Waiting for the result…');
    live.unmount();

    const failed = render(
      <TurnParts
        parts={[
          ...call('mcp__tm8__tm8_act', { operation: 'tasks.complete' }, { content: 'version conflict', isError: true }),
          { seq: (seq += 1), kind: 'done' },
        ]}
        settled
      />,
    );
    fireEvent.click(failed.getByTestId('chat-steps-head'));
    fireEvent.click(failed.getByTestId('chat-mcp-toggle'));
    const [errored] = failed.getAllByTestId('chat-mcp-call');
    expect(errored!.dataset.state).toBe('error');
    fireEvent.click(within(errored!).getByRole('button'));
    expect(within(errored!).getByTestId('chat-mcp-output').textContent).toBe('version conflict');
  });

  it('groups by server and leaves native tools out', () => {
    const parts = [
      ...READ(),
      ...call('mcp__github__list_issues', { repo: 'tm8' }, { content: [] }),
      ...call('Bash', { command: 'ls' }, { content: 'a\nb' }),
      { seq: (seq += 1), kind: 'done' } as ChatTurnPart,
    ];
    const view = render(<TurnParts parts={parts} settled />);
    expect(view.getByTestId('chat-steps-mcp').textContent).toBe(' · 1 tm8 MCP call, 1 github MCP call');
    fireEvent.click(view.getByTestId('chat-steps-head'));
    expect(view.getAllByTestId('chat-mcp').map((el) => el.dataset.server)).toEqual(['tm8', 'github']);
  });
});
