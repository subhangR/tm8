import { describe, expect, it } from 'vitest';
import { reduceEdges, type ReducibleEdge } from './edge-reduction';
import { blueprintView } from './blueprint-model';
import { DENSE_CRAFT } from './dense-craft.fixture';
import { diffBlueprintViews } from './blueprint-diff';

/** `a>b` = a pure ordering edge drawn a → b; key is the spec itself. */
const dep = (spec: string, extra: Partial<ReducibleEdge> = {}): ReducibleEdge => {
  const [from, to] = spec.split('>') as [string, string];
  return { key: spec, from, to, ranked: true, reducible: true, fold: false, ...extra };
};

describe('reduceEdges — transitive reduction', () => {
  it('drops A→C when A→B→C exists', () => {
    const r = reduceEdges([dep('a>b'), dep('b>c'), dep('a>c')], 'reduced');
    expect(r.kept).toEqual(['a>b', 'b>c']);
    expect([...r.implied]).toEqual(['a>c']);
  });

  it('drops a skip over any longer path, and keeps the unique reduction of a DAG', () => {
    const r = reduceEdges([dep('a>d'), dep('a>b'), dep('b>c'), dep('c>d'), dep('a>c'), dep('b>d')], 'reduced');
    expect(r.kept).toEqual(['a>b', 'b>c', 'c>d']);
    expect([...r.implied].sort()).toEqual(['a>c', 'a>d', 'b>d']);
  });

  it('keeps edges no path covers (diamond)', () => {
    const r = reduceEdges([dep('a>b'), dep('a>c'), dep('b>d'), dep('c>d')], 'reduced');
    expect(r.kept).toHaveLength(4);
  });

  it('never drops an edge that is not reducible, but lets it cover others', () => {
    const r = reduceEdges([
      dep('t1>doc', { reducible: false }), dep('doc>t2', { reducible: false }), dep('t1>t2'),
    ], 'reduced');
    expect(r.kept).toEqual(['t1>doc', 'doc>t2']);
    expect([...r.implied]).toEqual(['t1>t2']);
  });

  it('does not let an unranked edge imply anything', () => {
    const r = reduceEdges([dep('a>b', { ranked: false, reducible: false }), dep('b>c'), dep('a>c')], 'reduced');
    expect(r.kept).toHaveLength(3);
  });

  it('keeps a cycle closed and preserves reachability inside it', () => {
    const r = reduceEdges([dep('a>b'), dep('b>c'), dep('c>a'), dep('a>c')], 'reduced');
    expect(r.kept).toEqual(['a>b', 'b>c', 'c>a']);
    const two = reduceEdges([dep('a>b'), dep('b>a')], 'reduced');
    expect(two.kept).toEqual(['a>b', 'b>a']);
  });

  it('preserves reachability exactly, even on a dense cyclic graph', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const edges = ids.flatMap((x, i) => ids.filter((_, j) => j !== i && (i * 7 + j * 3) % 4 !== 0).map((y) => dep(`${x}>${y}`)));
    const reach = (es: ReducibleEdge[]) => ids.map((s) => {
      const seen = new Set([s]);
      const stack = [s];
      while (stack.length) {
        const at = stack.pop()!;
        es.filter((e) => e.from === at && !seen.has(e.to)).forEach((e) => { seen.add(e.to); stack.push(e.to); });
      }
      return [...seen].sort().join('');
    });
    const r = reduceEdges(edges, 'reduced');
    expect(r.kept.length).toBeLessThan(edges.length);
    expect(reach(edges.filter((e) => r.kept.includes(e.key)))).toEqual(reach(edges));
  });

  it('ignores self-loops as paths and keeps them', () => {
    const r = reduceEdges([dep('a>a'), dep('a>b')], 'reduced');
    expect(r.kept).toEqual(['a>a', 'a>b']);
  });

  it("draws everything at 'all'", () => {
    const r = reduceEdges([dep('a>b'), dep('b>c'), dep('a>c'), { ...dep('a>b'), key: 'x' }], 'all');
    expect(r.kept).toHaveLength(4);
    expect(r.implied.size + r.mergedInto.size + r.folded.size).toBe(0);
  });
});

describe('reduceEdges — parallel edges', () => {
  it('merges edges with the same drawn pair into the first one', () => {
    const r = reduceEdges([dep('a>b'), { ...dep('a>b'), key: 'a>b#2' }, dep('b>a')], 'reduced');
    expect(r.kept).toEqual(['a>b', 'b>a']);
    expect(r.mergedInto.get('a>b#2')).toBe('a>b');
    expect(r.carries.get('a>b')).toEqual(['a>b', 'a>b#2']);
  });

  it('keeps a merged line when any edge it carries is not pure ordering', () => {
    const r = reduceEdges([
      dep('a>b'), dep('b>c'), dep('a>c'), { ...dep('a>c', { reducible: false }), key: 'a>c#flow' },
    ], 'reduced');
    expect(r.kept).toEqual(['a>b', 'b>c', 'a>c']);
    expect(r.carries.get('a>c')).toEqual(['a>c', 'a>c#flow']);
  });

  it('counts the merged edges of an implied line as implied, not merged', () => {
    const r = reduceEdges([dep('a>b'), dep('b>c'), dep('a>c'), { ...dep('a>c'), key: 'a>c#2' }], 'reduced');
    expect([...r.implied].sort()).toEqual(['a>c', 'a>c#2']);
    expect(r.mergedInto.size).toBe(0);
  });
});

describe('reduceEdges — folding', () => {
  it("folds context links only at 'essential'", () => {
    const edges = [dep('a>b'), dep('a>m', { ranked: false, reducible: false, fold: true })];
    expect(reduceEdges(edges, 'reduced').kept).toEqual(['a>b', 'a>m']);
    const r = reduceEdges(edges, 'essential');
    expect(r.kept).toEqual(['a>b']);
    expect([...r.folded]).toEqual(['a>m']);
  });
});

describe('blueprintView edgeDetail', () => {
  const count = (detail: 'all' | 'reduced' | 'essential') => {
    const view = blueprintView(DENSE_CRAFT, undefined, { edgeDetail: detail });
    return { lines: view.lines.length, hidden: view.hiddenEdges, view };
  };

  it('draws every non-assignment edge by default', () => {
    const view = blueprintView(DENSE_CRAFT);
    expect(view.edgeDetail).toBe('all');
    expect(view.lines).toHaveLength(DENSE_CRAFT.edges.length - 5);
    expect(view.hiddenEdges).toEqual({ merged: 0, implied: 0, folded: 0 });
  });

  it('cuts the dense craft down without touching the lists', () => {
    const all = count('all');
    const reduced = count('reduced');
    const essential = count('essential');
    expect(reduced.lines).toBeLessThan(all.lines);
    expect(essential.lines).toBeLessThan(reduced.lines);
    expect(reduced.lines + reduced.hidden.merged + reduced.hidden.implied).toBe(all.lines);
    expect(essential.lines + essential.hidden.merged + essential.hidden.implied + essential.hidden.folded).toBe(all.lines);
    expect(reduced.view.lists.rows).toEqual(all.view.lists.rows);
    // launch → research is restated by every path through the plan
    expect(reduced.view.lines.some((l) => l.src === 't-launch' && l.dst === 't-research')).toBe(false);
  });

  it('merges a parallel pair into one line with both labels and both sentences', () => {
    const merged = count('reduced').view.lines.find((l) => l.merged.length > 0);
    expect(merged).toBeDefined();
    const both = count('reduced').view.lines.find((l) => l.src === 't-spec' && l.dst === 't-research');
    expect(both?.label).toBe('blocks · relates to');
    expect(both?.sentence).toBe('t-spec depends_on t-research; t-spec relates_to t-research');
  });

  it('never hides an edge a warning names', () => {
    const content = {
      kind: 'graph', graphType: 'entity',
      nodes: [
        { id: 'a', spec: { kind: 'task', title: 'A' } },
        { id: 'b', spec: { kind: 'task', title: 'B' } },
        { id: 'd', spec: { kind: 'doc', title: 'D' } },
      ],
      edges: [
        { src: 'b', dst: 'a', type: 'depends_on' },
        { src: 'd', dst: 'b', type: 'depends_on' },
        { src: 'd', dst: 'a', type: 'depends_on' },
      ],
    };
    const view = blueprintView(content, undefined, { edgeDetail: 'reduced' });
    expect(view.findings.length).toBeGreaterThan(0);
    expect(view.lines.map((l) => `${l.src}>${l.dst}`)).toContain('d>a');
  });
});

describe('patch diff under reduction', () => {
  it('counts edges, not drawn lines: an edge that becomes implied is not "removed"', () => {
    const base = {
      kind: 'graph', graphType: 'entity',
      nodes: ['a', 'b', 'c'].map((id) => ({ id, spec: { kind: 'task', title: id } })),
      edges: [{ src: 'c', dst: 'a', type: 'depends_on' }, { src: 'b', dst: 'a', type: 'depends_on' }],
    };
    const next = { ...base, edges: [...base.edges, { src: 'c', dst: 'b', type: 'depends_on' }] };
    const prev = blueprintView(base, undefined, { edgeDetail: 'reduced' });
    const after = blueprintView(next, undefined, { edgeDetail: 'reduced' });
    expect(after.lines).toHaveLength(prev.lines.length); // c→a went implied, c→b came in
    const diff = diffBlueprintViews(prev, after);
    expect(diff.removedLines).toBe(0);
    expect(diff.addedLines).toEqual(['c:b:depends_on']);
  });
});
