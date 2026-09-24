// @vitest-environment jsdom
/**
 * TURN NOTES — recognising a blueprint write in a chat tool call, and the
 * line the transcript shows for it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { blueprintView } from './blueprint-model';
import { diffBlueprintViews } from './blueprint-diff';
import { BlueprintTurnNote, graphWriteOf, type ToolNoteCall } from './turn-notes';

afterEach(cleanup);

const GRAPH = '01a0d3c5-0000-7000-8000-000000000001';
const OTHER = '01a0d3c5-0000-7000-8000-000000000002';

const patch = (id: string, content: unknown, result?: unknown, state: ToolNoteCall['state'] = 'completed'): ToolNoteCall => ({
  name: 'mcp__tm8__tm8_act',
  args: { operation: 'entities.patch', params: { id }, body: { expectedVersion: 3, content } },
  result,
  state,
});

const CONTENT = {
  graphType: 'entity',
  nodes: [
    { id: 't-a', spec: { kind: 'task', title: 'Draft the API' } },
    { id: 'd-spec', spec: { kind: 'doc', title: 'API spec' } },
  ],
  edges: [{ src: 't-a', dst: 'd-spec', type: 'produces' }],
};

describe('graphWriteOf', () => {
  it('recognises a patch to THIS graph and reads the version from an MCP text envelope', () => {
    const write = graphWriteOf(
      patch(GRAPH, CONTENT, { content: [{ type: 'text', text: JSON.stringify({ entity: { id: GRAPH, kind: 'graph', version: 4 } }) }] }),
      GRAPH,
    );
    expect(write).toEqual({ op: 'patch', version: 4, nodeIds: ['t-a', 'd-spec'], linked: [], settled: true });
  });

  it('ignores other entities, other verbs, and reads', () => {
    expect(graphWriteOf(patch(OTHER, CONTENT), GRAPH)).toBeNull();
    expect(graphWriteOf({ name: 'mcp__tm8__tm8_read', args: { operation: 'entities.get', params: { id: GRAPH } }, state: 'completed' }, GRAPH)).toBeNull();
    expect(graphWriteOf(patch(GRAPH, CONTENT), null)).toBeNull();
  });

  it('a create counts only when its RESULT is this graph', () => {
    const create = (result: unknown): ToolNoteCall => ({
      name: 'mcp__tm8__tm8_act',
      args: { operation: 'entities.create', body: { kind: 'graph', title: 'Plan', content: CONTENT } },
      result,
      state: 'completed',
    });
    expect(graphWriteOf(create({ id: GRAPH, kind: 'graph', version: 1 }), GRAPH)?.op).toBe('create');
    expect(graphWriteOf(create({ id: OTHER, kind: 'graph', version: 1 }), GRAPH)).toBeNull();
  });

  it('a link write-back names the nodes it materialized; an unsettled call is marked so', () => {
    const write = graphWriteOf(patch(GRAPH, { link: { 't-a': OTHER } }, undefined, 'running'), GRAPH);
    expect(write?.linked).toEqual(['t-a']);
    expect(write?.settled).toBe(false);
    expect(write?.version).toBeNull();
  });
});

describe('BlueprintTurnNote', () => {
  const before = blueprintView({ graphType: 'entity', nodes: [CONTENT.nodes[0]], edges: [] });
  const after = blueprintView(CONTENT);

  it('with a recorded diff: says what changed and each node selects on the canvas', () => {
    const onSelect = vi.fn();
    const write = graphWriteOf(patch(GRAPH, CONTENT, { id: GRAPH, kind: 'graph', version: 4 }), GRAPH)!;
    const view = render(<BlueprintTurnNote write={write} diff={diffBlueprintViews(before, after)} view={after} onSelect={onSelect} />);
    const note = view.getByTestId('crf-turn-note');
    expect(note.textContent).toContain('Updated the blueprint v4');
    expect(note.textContent).toContain('+1 node');
    fireEvent.click(view.getByRole('button', { name: 'API spec' }));
    expect(onSelect).toHaveBeenCalledWith('d-spec');
  });

  it('without one (a reopened thread): still says the blueprint was written, never invents a diff', () => {
    const write = graphWriteOf(patch(GRAPH, CONTENT, { id: GRAPH, kind: 'graph', version: 4 }), GRAPH)!;
    const view = render(<BlueprintTurnNote write={write} diff={null} view={after} onSelect={() => {}} />);
    expect(view.getByTestId('crf-turn-note').textContent).toBe('✎Updated the blueprint v4');
    expect(view.queryAllByRole('button')).toHaveLength(0);
  });
});
