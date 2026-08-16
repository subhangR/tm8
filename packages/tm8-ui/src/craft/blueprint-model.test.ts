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

  it('carries a mermaid row through: type and source, cards empty', () => {
    const view = blueprintView({ kind: 'graph', graphType: 'mermaid', source: 'flowchart TD; a-->b' });
    expect(view.graphType).toBe('mermaid');
    expect(view.source).toBe('flowchart TD; a-->b');
    expect(view.cards).toHaveLength(0);
  });
});
