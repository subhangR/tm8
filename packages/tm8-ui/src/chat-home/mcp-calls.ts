/**
 * MCP USAGE — which of a run's calls went through an MCP server, and what
 * each one sent and got back. Pure.
 *
 * The step list says what the agent DID in human words and never names a
 * tool (graph-seeds R8). This is the deliberate exception (task 01a18e32):
 * a reader who wants to see that chat used the tm8 MCP, and audit exactly
 * what it asked and what came back, presses one line and gets the raw call.
 * Nothing here renders until that press.
 *
 * An MCP call is recognised by its name, the only place the runtimes record
 * it: Claude writes `mcp__<server>__<tool>`, Codex `<server>.<tool>`. A name
 * that matches neither is a native tool and is not MCP usage.
 */
import { toolStepState, type ToolStepPart, type ToolStepState } from './turn-steps';
import { operationOf } from './write-classifier';

export interface McpToolName {
  server: string;
  tool: string;
}

const CLAUDE_MCP = /^mcp__([^_].*?)__(.+)$/;
const CODEX_MCP = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

/** `mcp__tm8__tm8_read` / `tm8.tm8_read` → `{server: 'tm8', tool: 'tm8_read'}`. */
export function mcpToolName(name: string): McpToolName | null {
  const match = CLAUDE_MCP.exec(name) ?? CODEX_MCP.exec(name);
  return match ? { server: match[1]!, tool: match[2]! } : null;
}

export interface McpCallView {
  seq: number;
  server: string;
  tool: string;
  /** A group tool's `operation` (`entities.get`), so `tm8_read` calls can be
   *  told apart before they are opened. */
  operation: string | null;
  state: ToolStepState;
  /** Raw args and result: `formatPayload` runs only when a call is opened,
   *  never on every streaming render. */
  input: unknown;
  /** Undefined while the call has no result yet. */
  output: unknown;
}

/** One server's calls in a run, in call order. */
export interface McpServerCalls {
  server: string;
  calls: readonly McpCallView[];
}

/** The run's MCP calls grouped by server, servers in first-use order. */
export function mcpCallsIn(
  steps: readonly ToolStepPart[],
  views: ReadonlyMap<number, { state: ToolStepState }>,
): McpServerCalls[] {
  const byServer = new Map<string, McpCallView[]>();
  for (const part of steps) {
    const mcp = mcpToolName(part.name);
    if (!mcp) continue;
    const view: McpCallView = {
      seq: part.seq,
      server: mcp.server,
      tool: mcp.tool,
      operation: operationOf(part.args),
      // The step list's own state for the call, so the two never disagree.
      state: views.get(part.seq)?.state ?? toolStepState(part, false),
      input: part.args,
      output: part.result,
    };
    const bucket = byServer.get(mcp.server);
    if (bucket) bucket.push(view);
    else byServer.set(mcp.server, [view]);
  }
  return [...byServer].map(([server, calls]) => ({ server, calls }));
}

/** `2 tm8 MCP calls`, `1 tm8 MCP call, 3 github MCP calls`. */
export function mcpUsageSummary(groups: readonly McpServerCalls[]): string {
  const counts = new Map<string, number>();
  for (const group of groups) counts.set(group.server, (counts.get(group.server) ?? 0) + group.calls.length);
  return [...counts].map(([server, n]) => `${n} ${server} MCP ${n === 1 ? 'call' : 'calls'}`).join(', ');
}

/** A payload past this is cut: a pane of raw JSON is for checking a call,
 *  and one 2MB result must not freeze the transcript. */
export const PAYLOAD_LIMIT = 20_000;

/**
 * A payload as readable text. MCP results arrive as content blocks
 * (`[{type: 'text', text: '{"entity": …}'}]`); their text is unwrapped and,
 * when it is JSON, pretty-printed, so the reader sees the tool's answer and
 * not the envelope it travelled in.
 */
export function formatPayload(value: unknown): string {
  return clipPayload(render(unwrapBlocks(value)));
}

function unwrapBlocks(value: unknown): unknown {
  const blocks = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.content) && Object.keys(value).every((k) => k === 'content' || k === 'isError' || k === 'is_error')
      ? value.content
      : null;
  if (!blocks || blocks.length === 0) return value;
  if (!blocks.every((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')) return value;
  const texts = blocks.map((block) => (block as { text: string }).text);
  return texts.length === 1 ? texts[0] : texts.join('\n\n');
}

function render(value: unknown): string {
  if (value === null || value === undefined) return '(none)';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return value;
      }
    }
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function clipPayload(text: string): string {
  if (text.length <= PAYLOAD_LIMIT) return text;
  const more = text.length - PAYLOAD_LIMIT;
  return `${text.slice(0, PAYLOAD_LIMIT)}\n… ${more.toLocaleString()} more characters`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
