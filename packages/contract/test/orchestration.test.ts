/**
 * The orchestration vocabulary and its coherence check — pure, so every rule
 * is pinned here: the sentence rule (`src <type> dst`), alias folding, the
 * registry mapping materialize writes, every finding code, determinism, and
 * the ~100-node budget the craft agent reads on every patch.
 */
import { describe, expect, it } from 'vitest';
import {
  ORCHESTRATION_EDGE_TYPES,
  BLUEPRINT_NODE_URI,
  applyGraphLinks,
  blueprintNodeRef,
  parseBlueprintNodeRef,
  parseNodeMentions,
  checkGraphCoherence,
  graphEdgeKey,
  graphNodeKey,
  graphNodeMaterialized,
  graphNodeRef,
  resolveEdgeType,
  type CoherenceFinding,
} from '../src/index.js';

const REF = '019f0000-0000-7000-8000-00000000aaaa';
const REF2 = '019f0000-0000-7000-8000-00000000bbbb';

const spec = (id: string, kind: string, extra: Record<string, unknown> = {}) =>
  ({ id, spec: { kind, title: id, ...extra } });

const codes = (findings: CoherenceFinding[]) => findings.map((f) => `${f.code}:${f.nodes.join(',')}`);

describe('vocabulary', () => {
  it('pins the canonical set and every type maps to a registered edge, same direction', () => {
    expect(ORCHESTRATION_EDGE_TYPES.map((t) => t.type)).toEqual(
      ['assigned_to', 'produces', 'consumes', 'depends_on', 'remembers', 'equips', 'relates_to'],
    );
    for (const t of ORCHESTRATION_EDGE_TYPES) {
      expect(t.registry).toEqual({ type: t.type, reverse: false });
    }
  });

  it('orders flow by the DATA, not by the stored direction (consumes/depends_on rank dst first)', () => {
    const order = Object.fromEntries(ORCHESTRATION_EDGE_TYPES.map((t) => [t.type, t.order]));
    expect(order).toMatchObject({
      produces: 'src-first', consumes: 'dst-first', depends_on: 'dst-first',
      assigned_to: 'none', relates_to: 'none',
    });
  });

  it('normalises spelling and folds aliases, reversing where the alias reads the other way', () => {
    expect(resolveEdgeType('Depends On')).toMatchObject({ type: 'depends_on', reversed: false, alias: null });
    expect(resolveEdgeType('dependsOn').type).toBe('depends_on');
    expect(resolveEdgeType('blocks')).toMatchObject({ type: 'depends_on', reversed: true, alias: 'blocks' });
    expect(resolveEdgeType('works_on')).toMatchObject({ type: 'assigned_to', reversed: true });
    expect(resolveEdgeType('uses_skill')).toMatchObject({ type: 'equips', reversed: false });
    expect(resolveEdgeType('feeds')).toMatchObject({ type: 'consumes', reversed: true });
    expect(resolveEdgeType('teleports')).toMatchObject({ def: null, type: 'teleports' });
    expect(resolveEdgeType(undefined)).toMatchObject({ def: null, type: '' });
  });
});

describe('reading nodes', () => {
  it('ref ⇔ reference; spec kept alongside ref ⇔ materialized', () => {
    expect(graphNodeRef({ id: 't1', spec: { kind: 'task' } })).toBeNull();
    expect(graphNodeRef({ id: 't1', ref: REF })).toBe(REF);
    expect(graphNodeRef({ id: REF })).toBe(REF); // legacy branch
    expect(graphNodeRef({ id: REF, spec: { kind: 'task' } })).toBeNull(); // spec is never overridden
    expect(graphNodeMaterialized({ id: 't1', ref: REF, spec: { kind: 'task' } })).toBe(true);
    expect(graphNodeMaterialized({ id: 't1', ref: REF })).toBe(false);
    expect(graphNodeKey({ key: 'k', id: 'i' }, 0)).toBe('k');
    expect(graphNodeKey({}, 3)).toBe('#3');
    expect(graphEdgeKey({ src: 'a', dst: 'b', type: 'produces' }, 2)).toBe('a:b:produces:2');
  });
});

describe('applyGraphLinks — the materialize write-back', () => {
  it('sets ref on named nodes, keeps spec and every other member, touches nothing else', () => {
    const nodes = [spec('t1', 'task', { hint: 'h' }), spec('d1', 'doc'), { key: 'legacy', spec: { kind: 'doc' } }];
    const out = applyGraphLinks(nodes, { t1: REF, legacy: REF2 });
    expect(out.unknownKeys).toEqual([]);
    expect(out.invalidRefs).toEqual([]);
    expect(out.nodes[0]).toEqual({ id: 't1', ref: REF, spec: { kind: 'task', title: 't1', hint: 'h' } });
    expect(out.nodes[1]).toBe(nodes[1]);
    expect(out.nodes[2]).toEqual({ key: 'legacy', ref: REF2, spec: { kind: 'doc' } });
    expect(graphNodeKey(out.nodes[2]!, 2)).toBe('legacy');
  });

  it('keeps a key-less node addressable by pinning its derived key as id', () => {
    const out = applyGraphLinks([{ spec: { kind: 'task' } }], { '#0': REF });
    expect(out.nodes[0]).toEqual({ id: '#0', ref: REF, spec: { kind: 'task' } });
  });

  it('names unknown keys and non-entity-id values instead of guessing', () => {
    const out = applyGraphLinks([spec('t1', 'task')], { nope: REF, t1: 'not-a-uuid' });
    expect(out.unknownKeys).toEqual(['nope']);
    expect(out.invalidRefs).toEqual(['t1']);
  });
});

describe('checkGraphCoherence', () => {
  const coherent = {
    nodes: [
      spec('t-research', 'task'), spec('t-api', 'task'), spec('d-spec', 'doc'),
      spec('tm-x', 'team_member'), spec('m-y', 'memory'),
    ],
    edges: [
      { src: 't-research', dst: 'd-spec', type: 'produces' },
      { src: 't-api', dst: 'd-spec', type: 'consumes' },
      { src: 't-api', dst: 't-research', type: 'depends_on' },
      { src: 't-research', dst: 'tm-x', type: 'assigned_to' },
      { src: 't-api', dst: 'tm-x', type: 'assigned_to' },
      { src: 't-api', dst: 'm-y', type: 'remembers' },
    ],
  };

  it('a coherent plan has no findings', () => {
    expect(checkGraphCoherence(coherent)).toEqual([]);
  });

  it('never throws on garbage — lean by law', () => {
    expect(checkGraphCoherence(null)).toEqual([]);
    expect(checkGraphCoherence({ nodes: 'x', edges: 7 })).toEqual([]);
    expect(() => checkGraphCoherence({ nodes: [null, 3, 'a'], edges: [null, { src: 1 }] })).not.toThrow();
  });

  it('reports every gap in a broken plan, errors first', () => {
    const findings = checkGraphCoherence({
      nodes: [
        spec('a', 'task'), spec('b', 'task'), spec('a', 'doc'),
        spec('d-in', 'doc'), spec('lonely', 'artifact'), { id: 'mystery', spec: { title: 'x' } },
        spec('w', 'widget'),
      ],
      edges: [
        { src: 'a', dst: 'b', type: 'depends_on' },
        { src: 'b', dst: 'a', type: 'depends_on' },
        { src: 'b', dst: 'ghost', type: 'produces' },
        { src: 'b', dst: 'd-in', type: 'consumes' },
        { src: 'd-in', dst: 'b', type: 'assigned_to' },
        { src: 'b', dst: 'b', type: 'relates_to' },
        { src: 'a', dst: 'w', type: 'teleports' },
        { src: 'w', dst: 'mystery', type: 'relates_to' },
      ],
    });
    const list = codes(findings);
    expect(list).toEqual(expect.arrayContaining([
      'duplicate_node_id:a',
      'dangling_edge:',
      'dependency_cycle:a,b',
      'untyped_spec:mystery',
      'unknown_node_kind:w',
      'endpoint_mismatch:d-in,b',
      'self_loop:b',
      'unknown_edge_type:a,w',
      'task_unassigned:a',
      'task_unassigned:b',
      'input_without_producer:d-in',
      'orphan_spec:lonely',
    ]));
    const sev = findings.map((f) => f.severity);
    expect(sev).toEqual([...sev].sort((x, y) => ['error', 'warning', 'info'].indexOf(x) - ['error', 'warning', 'info'].indexOf(y)));
    expect(checkGraphCoherence({ nodes: [spec('a', 'task')], edges: [] }).map((f) => f.code))
      .toEqual(['orphan_spec', 'task_unassigned']);
  });

  it('a cycle through data flow counts too (produce ← consume ← depends)', () => {
    const findings = checkGraphCoherence({
      nodes: [spec('t1', 'task'), spec('t2', 'task'), spec('d', 'doc')],
      edges: [
        { src: 't1', dst: 'd', type: 'produces' },
        { src: 't2', dst: 'd', type: 'consumes' },
        { src: 't1', dst: 't2', type: 'depends_on' },
      ],
    });
    const cycle = findings.find((f) => f.code === 'dependency_cycle');
    expect(cycle?.nodes).toEqual(['t1', 't2', 'd']);
    expect(cycle?.edges).toHaveLength(3);
  });

  it('nudges an alias toward the canonical sentence without calling it unknown', () => {
    const findings = checkGraphCoherence({
      nodes: [spec('t1', 'task'), spec('t2', 'task'), spec('tm', 'team_member')],
      edges: [
        { src: 't1', dst: 't2', type: 'blocks' },
        { src: 't1', dst: 'tm', type: 'assigned_to' },
        { src: 't2', dst: 'tm', type: 'assigned_to' },
      ],
    });
    expect(findings).toEqual([expect.objectContaining({
      code: 'aliased_edge_type', severity: 'info', message: '"blocks" is read as "t2" depends_on "t1"; write that instead.',
    })]);
  });

  it('judges references only when their kind is known, and never flags their plan gaps', () => {
    const content = { nodes: [{ id: 't', ref: REF }, spec('d', 'doc')], edges: [{ src: 't', dst: 'd', type: 'produces' }] };
    expect(checkGraphCoherence(content)).toEqual([]);
    const asDoc = checkGraphCoherence(content, { refKind: () => 'doc' });
    expect(asDoc.map((f) => f.code)).toEqual(['endpoint_mismatch']);
  });

  it('is deterministic and handles ~100 nodes well inside a read budget', () => {
    const nodes: unknown[] = [];
    const edges: unknown[] = [];
    for (let i = 0; i < 100; i += 1) {
      nodes.push(spec(`t${i}`, 'task'), spec(`d${i}`, 'doc'));
      edges.push({ src: `t${i}`, dst: `d${i}`, type: 'produces' });
      if (i > 0) edges.push({ src: `t${i}`, dst: `d${i - 1}`, type: 'consumes' });
      if (i > 1) edges.push({ src: `t${i}`, dst: `t${i - 2}`, type: 'depends_on' });
    }
    edges.push({ src: 't0', dst: 't99', type: 'depends_on' }); // one long cycle
    const content = { nodes, edges };
    const started = performance.now();
    const first = checkGraphCoherence(content);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(50);
    expect(checkGraphCoherence(content)).toEqual(first);
    expect(first.filter((f) => f.code === 'dependency_cycle')).toHaveLength(1);
    expect(first.filter((f) => f.code === 'task_unassigned')).toHaveLength(100);
  });

  it('survives a 2 000-deep chain without blowing the stack', () => {
    const nodes = Array.from({ length: 2000 }, (_, i) => spec(`t${i}`, 'task'));
    const edges = nodes.slice(1).map((_, i) => ({ src: `t${i + 1}`, dst: `t${i}`, type: 'depends_on' }));
    expect(() => checkGraphCoherence({ nodes, edges })).not.toThrow();
  });
});

describe('node mentions — one spelling for UI, prompt and transcript', () => {
  it('formats the composer link form and round-trips through both parsers, escapes included', () => {
    const link = blueprintNodeRef(REF, 't-api', 'Ship [v2] \\ API');
    expect(link).toBe(`[Ship \\[v2\\] \\\\ API](tm8://node/${REF}/t-api)`);
    expect(link.startsWith('[')).toBe(true);
    const href = link.slice(link.indexOf('](') + 2, -1);
    expect(href.startsWith(BLUEPRINT_NODE_URI)).toBe(true);
    expect(parseBlueprintNodeRef(href)).toEqual({ graphId: REF, nodeId: 't-api' });
    expect(parseNodeMentions(`look at ${link} and ${blueprintNodeRef(REF, 'd spec/1', '')} please`)).toEqual([
      { graphId: REF, nodeId: 't-api', title: 'Ship [v2] \\ API' },
      { graphId: REF, nodeId: 'd spec/1', title: 'd spec/1' },
    ]);
  });

  it('refuses what is not a node link', () => {
    expect(parseBlueprintNodeRef('tm8://file/abc')).toBeNull();
    expect(parseBlueprintNodeRef('tm8://node/only-graph')).toBeNull();
    expect(parseNodeMentions('[x](tm8://file/abc) [y](https://e.com)')).toEqual([]);
  });
});
