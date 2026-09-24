/**
 * THE STUDIO'S PURE HALF — navigation, patch diffs and presentation, read off
 * REAL folds (`blueprintView`, Foundations' view model) rather than hand-made
 * view objects, so a change in the model's shape reds these instead of
 * leaving them green against a fixture nobody draws.
 */
import { describe, expect, it } from 'vitest';
import { ORCHESTRATION_EDGE_TYPES } from '@tm8/contract';
import { blueprintView } from './blueprint-model';
import { drawnEnds, findCards, neighbourhood, pathMidpoint, readingOrder, stepSelection } from './canvas-nav';
import { diffBlueprintViews, isEmptyDiff, summarizeDiff } from './blueprint-diff';
import { availableViews, initials, legendRows, resolveView, statusTone, wrapText } from './presentation';

const PLAN = {
  graphType: 'entity',
  nodes: [
    { id: 'tm-a', spec: { kind: 'team_member', title: 'Ada Writer' } },
    { id: 't-research', spec: { kind: 'task', title: 'Research pricing' } },
    { id: 'd-brief', spec: { kind: 'doc', title: 'Pricing brief' } },
    { id: 't-copy', spec: { kind: 'task', title: 'Write the copy' } },
    { id: 't-ship', spec: { kind: 'task', title: 'Ship it' } },
  ],
  edges: [
    { src: 't-copy', dst: 'tm-a', type: 'assigned_to' },
    { src: 't-research', dst: 'd-brief', type: 'produces' },
    { src: 't-copy', dst: 'd-brief', type: 'consumes' },
    { src: 't-ship', dst: 't-copy', type: 'depends_on' },
  ],
};

describe('canvas navigation', () => {
  const view = blueprintView(PLAN);

  it('reads consumes and depends_on along the DRAWN arrow, produces as stored', () => {
    const consumes = view.lines.find((line) => line.type === 'consumes')!;
    expect(drawnEnds(consumes)).toEqual({ from: 'd-brief', to: 't-copy' });
    const depends = view.lines.find((line) => line.type === 'depends_on')!;
    expect(drawnEnds(depends)).toEqual({ from: 't-copy', to: 't-ship' });
    const produces = view.lines.find((line) => line.type === 'produces')!;
    expect(drawnEnds(produces)).toEqual({ from: 't-research', to: 'd-brief' });
  });

  it('a node’s neighbourhood is its drawn lines, their far ends, and its docked assignees', () => {
    const hood = neighbourhood(view, 't-copy');
    expect([...hood.nodes].sort()).toEqual(['d-brief', 't-copy', 't-ship', 'tm-a']);
    expect(hood.incoming.map((line) => line.type)).toEqual(['consumes']);
    expect(hood.outgoing.map((line) => line.type)).toEqual(['depends_on']);
    /* The attached teammate's neighbourhood is the tasks it is docked on. */
    expect([...neighbourhood(view, 'tm-a').nodes].sort()).toEqual(['t-copy', 'tm-a']);
  });

  it('arrow keys move geometrically, starting from the first card in reading order', () => {
    const first = readingOrder(view)[0]!.key;
    expect(stepSelection(view, null, 'right')).toBe(first);
    /* → from the brief lands on the task that consumes it, one stage right. */
    expect(stepSelection(view, 'd-brief', 'right')).toBe('t-copy');
    expect(stepSelection(view, 't-copy', 'left')).toBe('d-brief');
    /* Nothing further right of the last stage: stay put, never jump away. */
    expect(stepSelection(view, 't-ship', 'right')).toBe('t-ship');
  });

  it('find matches titles, kinds and assignees, in reading order', () => {
    expect(findCards(view, 'pricing')).toEqual(['t-research', 'd-brief']);
    expect(findCards(view, 'ada')).toEqual(['t-copy']);
    expect(findCards(view, '  ')).toEqual([]);
  });

  it('puts a floating label at the middle of the path by LENGTH, not by point count', () => {
    const mid = pathMidpoint([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 10 }])!;
    expect(mid.x).toBeCloseTo(55);
    expect(mid.y).toBeCloseTo(0);
    expect(pathMidpoint([])).toBeNull();
  });
});

describe('the patch diff', () => {
  it('names what a patch added, changed and removed — and nothing when nothing changed', () => {
    const before = blueprintView(PLAN);
    expect(isEmptyDiff(diffBlueprintViews(before, blueprintView(PLAN)))).toBe(true);

    const after = blueprintView({
      ...PLAN,
      nodes: [
        ...PLAN.nodes.filter((node) => node.id !== 't-ship').map((node) =>
          node.id === 'd-brief' ? { ...node, spec: { ...node.spec, title: 'Pricing brief v2' } } : node),
        { id: 'm-voice', spec: { kind: 'memory', title: 'Brand voice' } },
      ],
      edges: [...PLAN.edges.filter((edge) => edge.src !== 't-ship'), { src: 't-copy', dst: 'm-voice', type: 'remembers' }],
    });
    const diff = diffBlueprintViews(before, after);
    expect(diff.added).toEqual(['m-voice']);
    expect(diff.changed).toEqual(['d-brief']);
    expect(diff.removed).toEqual([{ key: 't-ship', title: 'Ship it' }]);
    expect(diff.marked.has('m-voice') && diff.marked.has('d-brief')).toBe(true);
    expect(summarizeDiff(diff)).toBe('+1 node · 1 changed · −1 node · +1 edge · −1 edge');
  });

  it('docking a teammate on a task marks the task as changed', () => {
    const bare = blueprintView({ ...PLAN, edges: PLAN.edges.filter((edge) => edge.type !== 'assigned_to') });
    const diff = diffBlueprintViews(bare, blueprintView(PLAN));
    expect(diff.changed).toContain('t-copy');
  });
});

describe('presentation', () => {
  it('offers Lanes only when someone is assigned, and falls back to Flow', () => {
    const assigned = blueprintView(PLAN);
    expect(availableViews(assigned).map((v) => v.id)).toEqual(['flow', 'lanes', 'outline', 'table']);
    const nobody = blueprintView({ ...PLAN, edges: PLAN.edges.filter((edge) => edge.type !== 'assigned_to') });
    expect(availableViews(nobody).map((v) => v.id)).not.toContain('lanes');
    expect(resolveView('lanes', nobody)).toBe('flow');
  });

  it('the legend speaks the vocabulary: every non-assignment canonical type, in the words its arrow reads', () => {
    const words = legendRows().flatMap((row) => row.labels);
    for (const type of ORCHESTRATION_EDGE_TYPES) {
      if (type.role === 'assignment' || type.type === 'relates_to') continue;
      expect(words).toContain(type.order === 'dst-first' ? type.inverseLabel : type.label);
    }
    expect(legendRows().map((row) => row.role)).toEqual(['flow', 'dependency', 'context']);
  });

  it('maps statuses to tones, tolerantly', () => {
    expect(statusTone('working')).toBe('run');
    expect(statusTone('open', true)).toBe('run');
    expect(statusTone('blocked')).toBe('block');
    expect(statusTone('in_review')).toBe('wait');
    expect(statusTone('done')).toBe('done');
    expect(statusTone('something_new')).toBe('idle');
    expect(statusTone(null)).toBe('none');
  });

  it('wraps titles on words, ellipsising only what does not fit', () => {
    expect(wrapText('Write the pricing page copy', 16, 2)).toEqual(['Write the', 'pricing page…']);
    expect(wrapText('Short', 16, 2)).toEqual(['Short']);
    /* A word longer than the line is hard-cut, and the ellipsis stays inside the width. */
    expect(wrapText('Supercalifragilistic', 8, 1)).toEqual(['Superca…']);
    expect(initials('Research Scout')).toBe('RS');
    expect(initials('forge')).toBe('FO');
  });
});
