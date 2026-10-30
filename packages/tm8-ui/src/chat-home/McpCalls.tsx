import { useId, useMemo, useState } from 'react';
import { formatPayload, type McpCallView, type McpServerCalls } from './mcp-calls';
import './turn-steps.css';

const ICON: Record<McpCallView['state'], string> = {
  completed: '✓',
  running: '●',
  error: '✕',
  stopped: '■',
};

/**
 * `Used tm8 MCP · 3 calls ▸` — one line per MCP server the run called, at the
 * foot of its step block (task 01a18e32). Pressing it lists each call by its
 * tool name and operation; pressing a call shows the Input it was sent and
 * the Output it returned. Buttons with aria-expanded, never `<details>`,
 * like every other toggle in the step list — and nothing raw renders until
 * the reader asks for it.
 */
export function McpCalls({ groups }: { groups: readonly McpServerCalls[] }) {
  if (groups.length === 0) return null;
  return (
    <>
      {groups.map((group) => (
        <McpServerLine key={group.server} group={group} />
      ))}
    </>
  );
}

function McpServerLine({ group }: { group: McpServerCalls }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const n = group.calls.length;
  return (
    <div className="tch-mcp" data-testid="chat-mcp" data-server={group.server}>
      <button
        type="button"
        className="tch-mcp__toggle"
        data-testid="chat-mcp-toggle"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tch-mcp__badge">MCP</span>
        {`Used ${group.server} MCP · ${n} ${n === 1 ? 'call' : 'calls'}`}
        <span className="tch-steps__caret" aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <ol id={id} className="tch-mcp__calls">
          {group.calls.map((call) => (
            <McpCallLine key={call.seq} call={call} />
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function McpCallLine({ call }: { call: McpCallView }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <li className="tch-mcp__call" data-testid="chat-mcp-call" data-state={call.state}>
      <button
        type="button"
        className="tch-mcp__call-toggle"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tch-steps__icon" aria-hidden>{ICON[call.state]}</span>
        <span className="tch-mcp__tool">{call.tool}</span>
        {call.operation ? <span className="tch-mcp__op">{call.operation}</span> : null}
        <span className="tch-steps__caret" aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open ? <McpCallPayload id={id} call={call} /> : null}
    </li>
  );
}

function McpCallPayload({ id, call }: { id: string; call: McpCallView }) {
  const input = useMemo(() => formatPayload(call.input), [call.input]);
  const output = useMemo(
    () => (call.output === undefined ? null : formatPayload(call.output)),
    [call.output],
  );
  return (
    <div id={id} className="tch-mcp__payload" data-testid="chat-mcp-payload">
      <div className="tch-mcp__label">Input</div>
      <pre className="tch-mcp__pre" data-testid="chat-mcp-input">{input}</pre>
      <div className="tch-mcp__label">{call.state === 'error' ? 'Output · error' : 'Output'}</div>
      {output === null ? (
        <p className="tch-mcp__pending">
          {call.state === 'running' ? 'Waiting for the result…' : 'No result was recorded.'}
        </p>
      ) : (
        <pre className="tch-mcp__pre" data-testid="chat-mcp-output" data-error={call.state === 'error' ? 'true' : undefined}>
          {output}
        </pre>
      )}
    </div>
  );
}
