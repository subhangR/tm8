// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TurnParts } from './TurnParts';
import type { ChatTurnPart } from './types';

const SOURCE_ID = '019f0000-0000-7000-8000-000000000101';
const TARGET_ID = '019f0000-0000-7000-8000-000000000102';
const EDGE_ID = '019f0000-0000-7000-8000-000000000103';
const FILE_ID = '019f0000-0000-7000-8000-000000000104';

function toolParts(name: string, args: unknown, result?: unknown): ChatTurnPart[] {
  return [
    { seq: 0, kind: 'tool_call', toolCallId: 'call-1', name, args, state: result ? 'completed' : 'running' },
    ...(result === undefined ? [] : [{
      seq: 1, kind: 'tool_result' as const, toolCallId: 'call-1', content: result,
    }]),
  ];
}

describe('Explain-mode presentation tools', () => {
  it('renders Mermaid as the primary output and keeps raw tool JSON secondary', () => {
    const view = render(<TurnParts parts={toolParts('mcp__tm8__explain_diagram', {
      title: 'Delegation flow',
      source: 'flowchart LR\n  Human --> Agent',
      caption: 'One visible handoff.',
    })} />);

    expect(view.getByTestId('explain-diagram')).toBeTruthy();
    expect(view.getByText('Delegation flow')).toBeTruthy();
    expect(view.getByTestId('chat-mermaid')).toBeTruthy();
    expect(view.getByText('One visible handoff.')).toBeTruthy();
    // The diagram is the content, so the card stays — but it wears no tool
    // chrome any more: no tool name, no raw "Tool details" payload dump.
    expect(view.queryByText('Tool details')).toBeNull();
    expect(view.container.textContent).not.toContain('explain_diagram');
  });

  it('draws verified persisted and inferred graph links differently and opens real entity nodes', () => {
    const open = vi.fn();
    const result = {
      schemaVersion: 'tm8.mcp.result.v1', tool: 'explain_graph', presentation: 'focused_graph',
      title: 'Dependency story', focusNodeId: 'source',
      nodes: [
        { id: 'source', label: 'Source task', entityId: SOURCE_ID, kind: 'task' },
        { id: 'target', label: 'Target task', entityId: TARGET_ID, kind: 'task' },
        { id: 'meaning', label: 'Why it matters' },
      ],
      edges: [
        { from: 'source', to: 'target', label: 'depends on', basis: 'persisted', edgeId: EDGE_ID, relationshipType: 'depends_on' },
        { from: 'target', to: 'meaning', label: 'explains', basis: 'inferred' },
      ],
    };
    const view = render(<TurnParts
      parts={toolParts('explain_graph', result, [{ type: 'text', text: JSON.stringify(result) }])}
      onOpenEntity={open}
    />);

    const svg = view.getByTestId('explanation-graph-svg');
    expect(svg.querySelector(".tch-xgraph__edges g[data-basis='persisted']")).toBeTruthy();
    expect(svg.querySelector(".tch-xgraph__edges g[data-basis='inferred']")).toBeTruthy();
    expect(view.getByText(/solid · persisted/)).toBeTruthy();
    expect(view.getByText(/dashed · agent-inferred/)).toBeTruthy();
    fireEvent.click(svg.querySelector(`g[data-entity='true']`)!);
    expect(open).toHaveBeenCalledWith(SOURCE_ID);
  });

  it('never styles an unverified persisted claim as persisted while the tool is running', () => {
    const args = {
      title: 'Pending graph',
      nodes: [
        { id: 'a', label: 'A', entityId: SOURCE_ID },
        { id: 'b', label: 'B', entityId: TARGET_ID },
      ],
      edges: [{ from: 'a', to: 'b', label: 'stored link', basis: 'persisted', edgeId: EDGE_ID, relationshipType: 'relates_to' }],
    };
    const view = render(<TurnParts parts={toolParts('explain_graph', args)} />);
    const svg = view.getByTestId('explanation-graph-svg');
    expect(svg.querySelector(".tch-xgraph__edges g[data-basis='persisted']")).toBeNull();
    expect(svg.querySelector(".tch-xgraph__edges g[data-basis='pending']")).toBeTruthy();
    expect(view.getAllByText(/awaiting verification/).length).toBeGreaterThan(0);
  });

  it('renders exact code with language, line numbers, syntax colour, annotations and controls', () => {
    const result = {
      schemaVersion: 'tm8.mcp.result.v1', tool: 'explain_code', presentation: 'code',
      sourceKind: 'repository', title: 'Policy branch', path: 'packages/mcp/src/modes.ts',
      language: 'typescript', code: 'const allowed = mode === "explain";\nreturn allowed;',
      startLine: 41, endLine: 42, totalLines: 90,
      highlights: [{ startLine: 41, endLine: 41, label: 'The mode gate.', tone: 'focus' }],
    };
    const view = render(<TurnParts parts={toolParts('explain_code', { path: result.path }, result)} />);

    expect(view.getByTestId('explain-code')).toBeTruthy();
    expect(view.getByText('Repository excerpt')).toBeTruthy();
    expect(view.getByText('lines 41–42 of 90')).toBeTruthy();
    expect(view.getByText('The mode gate.')).toBeTruthy();
    expect(view.container.querySelector('.tch-code__tok--keyword')?.textContent).toBe('const');
    const collapse = view.getByRole('button', { name: 'Collapse' });
    fireEvent.click(collapse);
    expect(view.queryByLabelText('Policy branch source')).toBeNull();
    expect(view.getByRole('button', { name: 'Expand' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('previews safe same-Space file assets and presents durable docs as output cards', () => {
    const asset = {
      schemaVersion: 'tm8.mcp.result.v1', tool: 'explain_asset', presentation: 'asset',
      fileEntityId: FILE_ID, name: 'architecture.png', mimeType: 'image/png', sizeBytes: 4096,
      title: 'Current architecture', alt: 'Architecture nodes', caption: 'Solid arrows are stored.',
    };
    const assetView = render(<TurnParts
      parts={toolParts('explain_asset', { fileEntityId: FILE_ID }, [{ type: 'text', text: JSON.stringify(asset) }])}
      assetHref={(id) => `/v2/files/${id}/download`}
    />);
    expect(assetView.getByAltText('Architecture nodes').getAttribute('src')).toBe(`/v2/files/${FILE_ID}/download`);
    expect(assetView.getByText('Solid arrows are stored.')).toBeTruthy();

    const docView = render(<TurnParts parts={toolParts('doc_create', {
      title: 'Mode guide', body: '# Guide', spaceId: 'space-a',
    }, { id: '019f0000-0000-7000-8000-000000000105', kind: 'doc', title: 'Mode guide' })} />);
    expect(docView.getByTestId('durable-explanation-output')).toBeTruthy();
    expect(docView.getByText('Durable document')).toBeTruthy();
    expect(docView.getAllByText('Mode guide').length).toBe(2);
  });
});

/**
 * A FAILED CALL SAYS WHY.
 *
 * The regression these guard against is precise and it shipped: on 2026-08-22
 * an `artifact_create` call was rejected with `manifest.files needs objects`
 * and the card rendered the words "Output was not created." and nothing more.
 * The agent, reading its own transcript, could not tell a malformed call from
 * a dead backend, so it abandoned the artifact instead of retrying — and the
 * human only learned the reason because it happened to appear in prose.
 */
describe('a failed tool call renders the reason, not only the failure', () => {
  function failedParts(name: string, args: unknown, result: unknown): ChatTurnPart[] {
    return [
      { seq: 0, kind: 'tool_call', toolCallId: 'call-1', name, args, state: 'error' },
      { seq: 1, kind: 'tool_result', toolCallId: 'call-1', content: result, isError: true },
    ];
  }

  it('shows the code and message under a failed artifact_create — the live failure', () => {
    const view = render(<TurnParts parts={failedParts(
      'mcp__tm8__artifact_create',
      { name: 'Harness registry — UI prototype', spaceId: 'space-a' },
      { schemaVersion: 'tm8.mcp.error.v1', error: { code: 'invalid_input', message: 'manifest.files needs objects' } },
    )} />);

    // The existing verdict is unchanged — it was never wrong, only incomplete.
    expect(view.getByText('Output was not created.')).toBeTruthy();
    // ...and now the card also carries the fact that makes it actionable.
    const reason = view.getByTestId('tool-failure-reason');
    expect(reason.textContent).toContain('manifest.files needs objects');
    expect(reason.textContent).toContain('invalid_input');
  });

  it('shows the reason on a failed explain_* presentation too', () => {
    const view = render(<TurnParts parts={failedParts(
      'explain_code',
      { path: 'packages/mcp/src/direct-tools.ts', startLine: 1, endLine: 10 },
      [{ type: 'text', text: '{"error":{"code":"not_found","message":"path is outside the project root"}}' }],
    )} />);

    expect(view.getByText('This presentation could not be prepared.')).toBeTruthy();
    expect(view.getByTestId('tool-failure-reason').textContent)
      .toContain('path is outside the project root');
  });

  it('draws no reason line when the payload carried none, rather than an empty one', () => {
    const view = render(<TurnParts parts={failedParts(
      'doc_update',
      { docId: '019f0000-0000-7000-8000-000000000105', expectedVersion: 1, body: '# x' },
      { ok: false },
    )} />);

    expect(view.getByText('Document was not updated.')).toBeTruthy();
    expect(view.queryByTestId('tool-failure-reason')).toBeNull();
  });

  it('says nothing extra while the call is still running', () => {
    const view = render(<TurnParts parts={[
      { seq: 0, kind: 'tool_call', toolCallId: 'call-1', name: 'artifact_create', args: { name: 'Prototype' }, state: 'running' },
    ]} />);
    expect(view.queryByTestId('tool-failure-reason')).toBeNull();
  });
});
