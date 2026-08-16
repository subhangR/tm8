/**
 * The blueprint fold — pure, so every honesty rule is testable without a DOM:
 * lean parsing (R2), layout honored with first-seen-grid fallback, spec vs
 * reference told apart, dangling edges COUNTED never silently dropped, and
 * the mermaid arm carrying its source through untouched.
 */
import { describe, expect, it } from 'vitest';
import { CARD_H, CARD_W, GAP_X, GAP_Y, PAD } from '../chat-home/induced-layout';
import { blueprintView } from './blueprint-model';

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
    expect(view.lines).toHaveLength(2);
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
    expect(resolved.cards[0]!.title).toBe('Cygnus-bot');
    expect(resolved.cards[0]!.kind).toBe('team_member');
  });

  it('honors layout for the nodes that carry one and grids the rest by first-seen index', () => {
    const view = blueprintView(entityContent({ layout: { b: { x: 300, y: 40 } } }));
    const [a, b, c] = view.cards;
    // a (index 0) and c (index 2) fall back to the grid…
    expect([a!.x, a!.y]).toEqual([PAD, PAD]);
    expect([c!.x, c!.y]).toEqual([PAD + 2 * (CARD_W + GAP_X), PAD]);
    // …and b sits exactly where the row says, offset by the canvas padding.
    expect([b!.x, b!.y]).toEqual([PAD + 300, PAD + 40]);
    // The canvas grows to hold the placed card.
    expect(view.width).toBeGreaterThanOrEqual(PAD + 300 + CARD_W);
    expect(view.height).toBeGreaterThanOrEqual(PAD + 40 + CARD_H);
  });

  it('COUNTS an edge naming an unknown key instead of dropping it silently', () => {
    const view = blueprintView(
      entityContent({ edges: [{ src: 'b', dst: 'ghost', type: 'depends_on' }] }),
    );
    expect(view.lines).toHaveLength(0);
    expect(view.danglingEdgeCount).toBe(1);
  });

  it('humanises the relation type — the edge vocabulary as intent, not a raw token', () => {
    const view = blueprintView(entityContent());
    expect(view.lines[0]!.label.toLowerCase()).not.toContain('_');
    expect(view.lines[0]!.note).toBe('alpha owns backend');
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
