/**
 * The blueprint fold — pure, so every honesty rule is testable without a DOM:
 * lean parsing (R2), the stored layout honored as a pin, spec vs reference
 * told apart, dangling edges COUNTED never silently dropped, the mermaid arm
 * carrying its source through untouched — and the orchestration MEANING:
 * assignees docked not drawn, flow drawn in data order, lanes, lists and
 * findings pinned where the UI shows them.
 */
import { describe, expect, it } from 'vitest';
import { BLUEPRINT_ASSIGNEE_DOCK, BLUEPRINT_CARD_SIZE, PAD, blueprintView } from './blueprint-model';

const CARD_W = BLUEPRINT_CARD_SIZE['task']!.width;
const CARD_H = BLUEPRINT_CARD_SIZE['task']!.height;

const entityContent = (over: Record<string, unknown> = {}) => ({
  kind: 'graph',
  graphType: 'entity',
  nodes: [
    { key: 'a', id: '019f0000-0000-7000-8000-00000000aaaa' },
    { key: 'b', spec: { kind: 'task', title: 'Ship API', hint: 'REST, reuse auth' } },
    { key: 'c', spec: { kind: 'task', title: 'Ship UI' } },
  ],
  edges: [
    { src: 'b', dst: 'a', type: 'assigned_to', note: 'alpha owns backend' },
    { src: 'c', dst: 'b', type: 'depends_on' },
  ],
  layout: {},
  source: null,
  ...over,
});

describe('blueprintView — the entity-type fold', () => {
  it('folds nodes and edges from ONE content object — no reads, no caps', () => {
    const view = blueprintView(entityContent());
    expect(view.graphType).toBe('entity');
    expect(view.cards.map((c) => c.key)).toEqual(['a', 'b', 'c']);
    /* The assignment is not a line: it docks `a` on `b`. */
    expect(view.lines).toHaveLength(1);
    expect(view.cards[1]!.assignees.map((x) => x.key)).toEqual(['a']);
    expect(view.danglingEdgeCount).toBe(0);
  });

  it('tells specs and references apart — intent must never pass as fact', () => {
    const view = blueprintView(entityContent());
    const [ref, spec] = [view.cards[0]!, view.cards[1]!];
    expect(ref.isSpec).toBe(false);
    expect(ref.refId).toBe('019f0000-0000-7000-8000-00000000aaaa');
    expect(spec.isSpec).toBe(true);
    expect(spec.refId).toBeNull();
    expect(spec.kind).toBe('task');
    expect(spec.title).toBe('Ship API');
    expect(spec.hint).toBe('REST, reuse auth');
  });

  it('an unresolved reference shows its truncated id honestly, a resolved one its title', () => {
    const bare = blueprintView(entityContent());
    expect(bare.cards[0]!.title).toMatch(/^019f0000…?/);
    const resolved = blueprintView(
      entityContent(),
      new Map([['019f0000-0000-7000-8000-00000000aaaa', { kind: 'team_member', title: 'Cygnus-bot' }]]),
    );
    /* Resolved as a teammate whose only edge is its assignment: docked, not a card. */
    expect(resolved.cards.map((c) => c.key)).toEqual(['b', 'c']);
    expect(resolved.attached).toEqual([expect.objectContaining({ key: 'a', title: 'Cygnus-bot', kind: 'team_member', tasks: ['b'] })]);
    expect(resolved.cards[0]!.assignees[0]).toMatchObject({ title: 'Cygnus-bot', kind: 'team_member' });
  });

  it('honors a stored layout entry as a pin and lays the rest out as a flow', () => {
    const view = blueprintView(entityContent({ layout: { b: { x: 300, y: 40 } } }));
    const byKey = new Map(view.cards.map((c) => [c.key, c]));
    /* b sits exactly where the row says, offset by the canvas padding… */
    expect(byKey.get('b')).toMatchObject({ x: PAD + 300, y: PAD + 40, pinned: true });
    /* …and c depends on b, so the prerequisite b is drawn first in the flow. */
    expect(byKey.get('c')!.pinned).toBe(false);
    expect(byKey.get('b')!.rank).toBeLessThan(byKey.get('c')!.rank);
    expect(view.width).toBeGreaterThanOrEqual(PAD + 300 + CARD_W);
    expect(view.height).toBeGreaterThanOrEqual(PAD + 40 + CARD_H);
  });

  /**
   * THE BOUNDING BOX, which is a different question from the extent.
   *
   * `width`/`height` measure from a pinned 0,0 origin. That is what the canvas
   * used to fit to, and it is why a blueprint with one outlying card rendered
   * shrunk into the top-left corner while most of the pane stayed empty — and
   * why a card at a negative coordinate was not drawn small but not drawn AT
   * ALL. `bounds` answers what is actually drawn.
   */
  describe('bounds — what is actually drawn, not the extent from the origin', () => {
    it('starts at the top-left-most card, not at the origin', () => {
      const view = blueprintView(entityContent({ layout: { a: { x: -400, y: -200 } } }));
      /* The placed card lands at PAD-400 / PAD-200; the box opens PAD before it. */
      expect(view.bounds.minX).toBeLessThanOrEqual(PAD - 400);
      expect(view.bounds.minY).toBeLessThanOrEqual(PAD - 200);
      /* The pinned-origin extent cannot express this at all — which was the bug. */
      expect(view.bounds.minX).toBeLessThan(0);
    });

    it('spans every drawn card, however far out the row places it', () => {
      const view = blueprintView(entityContent({ layout: { b: { x: 1400, y: 640 } } }));
      const right = view.bounds.minX + view.bounds.width;
      const bottom = view.bounds.minY + view.bounds.height;
      expect(right).toBeGreaterThanOrEqual(PAD + 1400 + CARD_W);
      expect(bottom).toBeGreaterThanOrEqual(PAD + 640 + CARD_H);
    });

    it('contains every bow and label anchor, not just the card rectangles', () => {
      /* On the fallback grid a bow stays inside the union of the two cards it
         joins, so this asserts CONTAINMENT rather than that the curve escapes.
         The escape case is the irregular one — two connected cards placed far
         apart by `layout`, below — and the containment invariant is what makes
         the fit safe on both. */
      const view = blueprintView(entityContent({ layout: { a: { x: 900, y: 500 } } }));
      const right = view.bounds.minX + view.bounds.width;
      const bottom = view.bounds.minY + view.bounds.height;
      expect(view.lines.length).toBeGreaterThan(0);
      for (const line of view.lines) {
        for (const x of [line.x1, line.x2, line.cx, line.lx]) {
          expect(x).toBeGreaterThanOrEqual(view.bounds.minX);
          expect(x).toBeLessThanOrEqual(right);
        }
        for (const y of [line.y1, line.y2, line.cy, line.ly]) {
          expect(y).toBeGreaterThanOrEqual(view.bounds.minY);
          expect(y).toBeLessThanOrEqual(bottom);
        }
      }
    });

    it('answers a finite box for an empty blueprint rather than ±Infinity', () => {
      const view = blueprintView({ kind: 'graph', graphType: 'entity', nodes: [], edges: [] });
      expect(Number.isFinite(view.bounds.minX)).toBe(true);
      expect(Number.isFinite(view.bounds.minY)).toBe(true);
      expect(Number.isFinite(view.bounds.width)).toBe(true);
      expect(Number.isFinite(view.bounds.height)).toBe(true);
    });
  });

  it('COUNTS an edge naming an unknown key instead of dropping it silently', () => {
    const view = blueprintView(
      entityContent({ edges: [{ src: 'b', dst: 'ghost', type: 'depends_on' }] }),
    );
    expect(view.lines).toHaveLength(0);
    expect(view.danglingEdgeCount).toBe(1);
  });

  it('labels from the vocabulary, never a raw token, and keeps the note', () => {
    const view = blueprintView(entityContent({
      edges: [{ src: 'c', dst: 'b', type: 'depends_on', note: 'needs the API' }, { src: 'b', dst: 'c', type: 'feeds_into_x' }],
    }));
    expect(view.lines[0]!.label.toLowerCase()).not.toContain('_');
    expect(view.lines[0]!.note).toBe('needs the API');
    /* An unknown type still draws, humanised. */
    expect(view.lines[1]!).toMatchObject({ role: 'unknown', knownType: false, label: 'feeds into x' });
  });

  it('tolerates leanness: keyless nodes, empty content, junk members (R2)', () => {
    const empty = blueprintView({ kind: 'graph', graphType: 'entity' });
    expect(empty.cards).toHaveLength(0);
    expect(empty.lines).toHaveLength(0);

    const loose = blueprintView({
      kind: 'graph',
      graphType: 'entity',
      nodes: [{ spec: { kind: 'task', vibe: 'fast' } }, { id: '019f0000-0000-7000-8000-00000000bbbb' }],
      edges: 'not-an-array',
      extra: { future: true },
    });
    expect(loose.cards.map((c) => c.key)).toEqual(['#0', '019f0000-0000-7000-8000-00000000bbbb']);
    expect(loose.cards[0]!.title).toBe('Untitled');
  });

  /**
   * THE PIN (2026-08-16). These cases are transcribed from the shapes on the
   * first real blueprint row (01a00a8c-0cd5, v5): 11 of 11 nodes carried `id`
   * as a row-local slug, 0 carried `key`, 9 carried a `spec` alongside, and
   * the 2 references mirrored their uuid across id/ref/entityId. Reading `id`
   * as the entity id turned all 9 specs into references, so the canvas drew
   * "ref" cards and the host fetched slugs and printed "unavailable entity".
   */
  describe('the pinned node shape — a reference iff it carries `ref`', () => {
    it('a slug `id` beside a `spec` is a SPEC, not a broken reference', () => {
      const view = blueprintView({
        kind: 'graph',
        graphType: 'entity',
        nodes: [{
          id: 't-schema', kind: 'task', label: 'Pin the schema', title: 'Pin the schema',
          hint: 'writers guess', spec: { kind: 'task', title: 'Pin the schema', hint: 'writers guess' },
        }],
      });
      const card = view.cards[0]!;
      expect(card.isSpec).toBe(true);
      expect(card.refId).toBeNull();
      expect(card.key).toBe('t-schema');
      expect(card.title).toBe('Pin the schema');
      expect(card.kind).toBe('task');
    });

    it('`ref` names the entity while `id` stays the edge namespace', () => {
      const view = blueprintView({
        kind: 'graph',
        graphType: 'entity',
        nodes: [{ id: 'tm-graph', ref: '019fbf18-b652-7177-a464-cf2cbaa31ed4' }],
        edges: [{ src: 'tm-graph', dst: 'tm-graph', type: 'relates_to' }],
      });
      const card = view.cards[0]!;
      expect(card.isSpec).toBe(false);
      expect(card.refId).toBe('019fbf18-b652-7177-a464-cf2cbaa31ed4');
      /* The edge names the SLUG, so it must resolve — not dangle. */
      expect(card.key).toBe('tm-graph');
      expect(view.danglingEdgeCount).toBe(0);
    });

    it('honors the wild aliases: `entityId` for ref, `key` for id', () => {
      const view = blueprintView({
        kind: 'graph',
        graphType: 'entity',
        nodes: [{ id: 'a', entityId: '019fbf29-92b9-775f-9486-a99f6cff7b8a' }],
      });
      expect(view.cards[0]!.refId).toBe('019fbf29-92b9-775f-9486-a99f6cff7b8a');
      expect(view.cards[0]!.key).toBe('a');
    });

    it('LEGACY: a bare entity-id `id` with no ref and no spec is still a reference', () => {
      const view = blueprintView({
        kind: 'graph',
        graphType: 'entity',
        nodes: [{ id: '019f0000-0000-7000-8000-00000000aaaa' }],
      });
      expect(view.cards[0]!.isSpec).toBe(false);
      expect(view.cards[0]!.refId).toBe('019f0000-0000-7000-8000-00000000aaaa');
    });

    it('…but a spec is NEVER dragged back into a reference by that branch', () => {
      const view = blueprintView({
        kind: 'graph',
        graphType: 'entity',
        nodes: [{ id: '019f0000-0000-7000-8000-00000000aaaa', spec: { kind: 'task', title: 'Sketch' } }],
      });
      expect(view.cards[0]!.isSpec).toBe(true);
      expect(view.cards[0]!.refId).toBeNull();
      expect(view.cards[0]!.title).toBe('Sketch');
    });
  });

  it('carries a mermaid row through: type and source, cards empty', () => {
    const view = blueprintView({ kind: 'graph', graphType: 'mermaid', source: 'flowchart TD; a-->b' });
    expect(view.graphType).toBe('mermaid');
    expect(view.source).toBe('flowchart TD; a-->b');
    expect(view.cards).toHaveLength(0);
  });
});

/**
 * THE ORCHESTRATION VIEW — the plan from the craft prompt's own example,
 * written the way the vocabulary says (every edge reads `src <type> dst`).
 */
describe('blueprintView — the orchestration view model', () => {
  const REF = '019f0000-0000-7000-8000-00000000cccc';
  const plan = (over: Record<string, unknown> = {}) => ({
    kind: 'graph',
    graphType: 'entity',
    nodes: [
      { id: 't-research', spec: { kind: 'task', title: 'Research', phase: 'Discover' } },
      { id: 'd-spec', spec: { kind: 'doc', title: 'Spec' } },
      { id: 't-api', ref: REF, spec: { kind: 'task', title: 'Build API', phase: 'Build' } },
      { id: 'tm-ada', spec: { kind: 'team_member', title: 'Ada' } },
      { id: 'tm-bo', spec: { kind: 'team_member', title: 'Bo' } },
      { id: 'm-notes', spec: { kind: 'memory', title: 'Notes' } },
    ],
    edges: [
      { src: 't-research', dst: 'd-spec', type: 'produces' },
      { src: 't-api', dst: 'd-spec', type: 'consumes' },
      { src: 't-api', dst: 't-research', type: 'depends_on' },
      { src: 't-research', dst: 'tm-ada', type: 'assigned_to' },
      { src: 't-api', dst: 'tm-bo', type: 'assigned_to' },
      { src: 't-api', dst: 'm-notes', type: 'remembers' },
    ],
    layout: {},
    ...over,
  });

  it('docks assignees on their tasks instead of drawing them', () => {
    const view = blueprintView(plan());
    expect(view.cards.map((c) => c.key)).toEqual(['t-research', 'd-spec', 't-api', 'm-notes']);
    expect(view.attached.map((a) => [a.key, a.tasks])).toEqual([['tm-ada', ['t-research']], ['tm-bo', ['t-api']]]);
    expect(view.lines.some((l) => l.type === 'assigned_to')).toBe(false);
    expect(view.cards.find((c) => c.key === 't-api')!.assignees.map((a) => a.title)).toEqual(['Bo']);
  });

  it('draws flow in DATA order: research → spec → api, with labels that read along the arrow', () => {
    const view = blueprintView(plan());
    const rank = (k: string) => view.cards.find((c) => c.key === k)!.rank;
    expect(rank('t-research')).toBeLessThan(rank('d-spec'));
    expect(rank('d-spec')).toBeLessThan(rank('t-api'));
    const line = (type: string) => view.lines.find((l) => l.type === type)!;
    expect(line('produces')).toMatchObject({ role: 'flow', drawnReversed: false, label: 'produces', sentence: 't-research produces d-spec' });
    expect(line('consumes')).toMatchObject({ role: 'flow', drawnReversed: true, label: 'consumed by', sentence: 't-api consumes d-spec' });
    expect(line('depends_on')).toMatchObject({ role: 'dependency', drawnReversed: true, label: 'blocks' });
    expect(line('remembers')).toMatchObject({ role: 'context' });
    /* The arrow ends on the card the data flows INTO. */
    const consumes = line('consumes');
    const api = view.cards.find((c) => c.key === 't-api')!;
    const end = consumes.points[consumes.points.length - 1]!;
    expect(end.x).toBeCloseTo(api.x, 1);
    expect(consumes.path.startsWith('M ')).toBe(true);
  });

  it('marks a spec that now carries a ref as materialized, with the host\'s live status', () => {
    const view = blueprintView(plan(), new Map([[REF, { kind: 'task', title: 'Build API (real)', status: 'working', live: true }]]));
    const api = view.cards.find((c) => c.key === 't-api')!;
    expect(api).toMatchObject({ isSpec: false, materialized: true, title: 'Build API (real)', status: 'working', live: true });
    expect(view.cards.find((c) => c.key === 't-research')).toMatchObject({ isSpec: true, materialized: false, status: null });
  });

  it('lanes by assignee: outputs follow their producer, lanes in node order, bands clear of each other', () => {
    const view = blueprintView(plan(), undefined, { mode: 'swimlane' });
    expect(view.lanes.map((l) => [l.label, l.assignee?.key ?? null])).toEqual([['Ada', 'tm-ada'], ['Bo', 'tm-bo']]);
    const laneOf = (k: string) => view.cards.find((c) => c.key === k)!.lane;
    expect(laneOf('t-research')).toBe('tm-ada');
    expect(laneOf('d-spec')).toBe('tm-ada');
    expect(laneOf('t-api')).toBe('tm-bo');
    expect(laneOf('m-notes')).toBe('tm-bo');
    view.cards.forEach((card) => {
      const lane = view.lanes.find((l) => l.key === card.lane)!.box;
      expect(card.y).toBeGreaterThanOrEqual(lane.y);
      expect(card.y + card.height).toBeLessThanOrEqual(lane.y + lane.height);
    });
  });

  it('lanes by kind and by phase', () => {
    expect(blueprintView(plan(), undefined, { mode: 'swimlane', laneBy: 'kind' }).lanes.map((l) => l.label))
      .toEqual(['Tasks', 'Docs', 'Memories']);
    expect(blueprintView(plan(), undefined, { mode: 'swimlane', laneBy: 'phase' }).lanes.map((l) => l.label))
      .toEqual(['Discover', 'Build', 'No phase']);
  });

  it('hands list views the plan without a layout: per assignee, per stage, as rows', () => {
    const view = blueprintView(plan());
    expect(view.lists.byAssignee.map((g) => [g.assignee?.key ?? null, g.tasks])).toEqual([
      ['tm-ada', ['t-research']], ['tm-bo', ['t-api']],
    ]);
    expect(view.lists.stages.map((s) => s.keys)).toEqual([['t-research'], ['d-spec'], ['t-api'], ['m-notes']]);
    const api = view.lists.rows.find((r) => r.key === 't-api')!;
    expect(api).toMatchObject({
      assignees: ['tm-bo'], consumes: ['d-spec'], produces: [], dependsOn: ['t-research'], context: ['m-notes'],
    });
    expect(view.lists.rows.find((r) => r.key === 't-research')!.blocks).toEqual(['t-api']);
  });

  it('pins coherence findings on the nodes and edges they name', () => {
    const view = blueprintView(plan({
      edges: [
        { src: 't-api', dst: 'd-spec', type: 'consumes' },
        { src: 't-api', dst: 't-research', type: 'blocks' },
      ],
    }));
    expect(view.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['input_without_producer', 'task_unassigned', 'aliased_edge_type']));
    const spec = view.cards.find((c) => c.key === 'd-spec')!;
    expect(spec.severity).toBe('warning');
    expect(spec.findings.map((f) => f.code)).toContain('input_without_producer');
    const alias = view.lines.find((l) => l.sentence === 't-api blocks t-research')!;
    expect(alias.severity).toBe('info');
    /* `blocks` folds to depends_on reversed: t-api is the prerequisite, drawn first. */
    const rank = (k: string) => view.cards.find((c) => c.key === k)!.rank;
    expect(rank('t-api')).toBeLessThan(rank('t-research'));
  });

  it('parks an unconnected card after the flow, and is deterministic', () => {
    const content = plan({ nodes: [...plan().nodes, { id: 't-orphan', spec: { kind: 'task', title: 'Orphan' } }] });
    const view = blueprintView(content);
    const orphan = view.cards.find((c) => c.key === 't-orphan')!;
    expect(orphan.rank).toBe(-1);
    const flowBottom = Math.max(...view.cards.filter((c) => c.rank >= 0).map((c) => c.y + c.height));
    expect(orphan.y).toBeGreaterThan(flowBottom);
    expect(blueprintView(content)).toEqual(view);
  });

  it('flows top to bottom when asked', () => {
    const view = blueprintView(plan(), undefined, { direction: 'TB' });
    const card = (k: string) => view.cards.find((c) => c.key === k)!;
    expect(card('d-spec').y).toBeGreaterThan(card('t-research').y + card('t-research').height);
  });
});

describe('blueprintView — regressions from drawing it', () => {
  it('a swimlane band starts at its own content, not hundreds of pixels above it', () => {
    const view = blueprintView({
      kind: 'graph', graphType: 'entity',
      nodes: [
        { id: 'tm-res', spec: { kind: 'team_member', title: 'Researcher' } },
        { id: 'tm-wr', spec: { kind: 'team_member', title: 'Writer' } },
        { id: 't-research', spec: { kind: 'task', title: 'Research' } },
        { id: 't-copy', spec: { kind: 'task', title: 'Copy' } },
        { id: 'd-brief', spec: { kind: 'doc', title: 'Brief' } },
      ],
      edges: [
        { src: 't-research', dst: 'tm-res', type: 'assigned_to' },
        { src: 't-copy', dst: 'tm-wr', type: 'assigned_to' },
        { src: 't-research', dst: 'd-brief', type: 'produces' },
        { src: 't-copy', dst: 'd-brief', type: 'consumes' },
      ],
    }, undefined, { mode: 'swimlane' });
    expect(view.lanes.map((l) => l.key)).toEqual(['tm-res', 'tm-wr']);
    view.lanes.forEach((lane) => {
      const mine = view.cards.filter((c) => c.lane === lane.key);
      expect(mine.length).toBeGreaterThan(0);
      const top = Math.min(...mine.map((c) => c.y));
      const bottom = Math.max(...mine.map((c) => c.y + c.height));
      /* Header + a little air above, never a void. */
      expect(top - lane.box.y).toBeLessThan(60);
      expect(lane.box.y + lane.box.height - bottom).toBeLessThan(40);
    });
  });

  it('no edge label ever sits on a card (the typical harness row, plus a context link)', () => {
    const nodes = [
      { key: 'ui', spec: { kind: 'team_member', title: 'tm8 UI Builder' } },
      { key: 'ge', spec: { kind: 'team_member', title: 'Graph Engineer' } },
      ...['panes', 'picker', 'resize', 'fit', 'panel', 'verify'].map((k) => ({ key: k, spec: { kind: 'task', title: k } })),
    ];
    const edges = [
      { src: 'panes', dst: 'ui', type: 'assigned_to' },
      { src: 'picker', dst: 'panes', type: 'depends_on', note: 'the column has to go first' },
      { src: 'resize', dst: 'panes', type: 'depends_on' },
      { src: 'fit', dst: 'ge', type: 'assigned_to' },
      { src: 'panel', dst: 'picker', type: 'depends_on' },
      { src: 'verify', dst: 'fit', type: 'depends_on' },
      { src: 'verify', dst: 'panel', type: 'depends_on' },
      { src: 'verify', dst: 'resize', type: 'relates_to' },
      { src: 'verify', dst: 'picker', type: 'relates_to' },
    ];
    for (const mode of ['flow', 'swimlane'] as const) {
      for (const direction of ['LR', 'TB'] as const) {
        const view = blueprintView({ kind: 'graph', graphType: 'entity', nodes, edges }, undefined, { mode, direction });
        const labels = view.lines.map((l) => l.labelBox).filter((b) => b !== null);
        view.cards.forEach((card) => {
          const dock = card.assignees.length > 0 ? BLUEPRINT_ASSIGNEE_DOCK / 2 : 0;
          labels.forEach((b) => {
            const hit = b!.x < card.x + card.width && card.x < b!.x + b!.width
              && b!.y < card.y + card.height + dock && card.y < b!.y + b!.height;
            expect(hit, `${mode}/${direction}: a label sits on ${card.key}`).toBe(false);
          });
        });
      }
    }
  });
});

describe('the owner-chip dock', () => {
  it('reserves half the dock below every task with an owner, so the chip never touches the card below', () => {
    const nodes = [
      { id: 'tm', spec: { kind: 'team_member', title: 'Owner' } },
      ...['a', 'b', 'c', 'd'].map((k) => ({ id: k, spec: { kind: 'task', title: k } })),
    ];
    const edges = [
      ...['a', 'b', 'c', 'd'].map((k) => ({ src: k, dst: 'tm', type: 'assigned_to' })),
      { src: 'b', dst: 'a', type: 'depends_on' }, { src: 'c', dst: 'a', type: 'depends_on' }, { src: 'd', dst: 'a', type: 'depends_on' },
    ];
    const view = blueprintView({ kind: 'graph', graphType: 'entity', nodes, edges });
    const column = view.cards.filter((c) => c.rank === 1).sort((p, q) => p.y - q.y);
    expect(column.length).toBe(3);
    for (let i = 0; i + 1 < column.length; i += 1) {
      const chipBottom = column[i]!.y + column[i]!.height + BLUEPRINT_ASSIGNEE_DOCK / 2;
      expect(column[i + 1]!.y).toBeGreaterThan(chipBottom);
    }
  });
});
