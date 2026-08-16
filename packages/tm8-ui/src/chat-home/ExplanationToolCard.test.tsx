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
    expect(view.getByText('Tool details').closest('details')?.open).toBe(false);
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
