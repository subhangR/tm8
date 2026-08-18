// @vitest-environment jsdom
/**
 * THE BLUEPRINT BLOCK — a graph row draws its canvas in the DETAIL PANEL, not
 * only in the Craft studio.
 *
 * What these cases pin is the reversal itself: before this block, a `graph`
 * was a picture on one screen and a fields list on every other, and which one
 * you got depended on where you were standing. The registry declaration is
 * pinned too, because the block renders only where the registry asks for it —
 * that declaration IS the wiring (§15.2: no kind literal does this job).
 *
 * jsdom loads no stylesheets, so nothing here claims geometry — presence,
 * structure and text only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { EntityDetail } from '@tm8/contract';
import { getKind } from '../../domain';
import { BlueprintBlock } from './BlueprintBlock';

afterEach(() => cleanup());

/**
 * A graph row, lean by law (R2): two referenced nodes, one spec, one edge —
 * plus an edge naming a key no node carries, which the canvas must COUNT
 * rather than drop (the no-silent-caps law).
 */
function graphDetail(content: unknown): EntityDetail {
  return {
    id: 'graph-1',
    kind: 'graph',
    title: 'Launch flow',
    content,
  } as unknown as EntityDetail;
}

/* The PINNED node shape: `id` is the row-local key and `spec` carries
   kind/title for a node that does not exist yet. A node is a reference only
   when it carries `ref` — entity-hood is never inferred from `id`. */
const BLUEPRINT = {
  kind: 'graph',
  graphType: 'entity',
  nodes: [
    { id: 'a', spec: { kind: 'task', title: 'Cut the release' } },
    { id: 'b', spec: { kind: 'task', title: 'Announce it' } },
  ],
  edges: [
    { src: 'a', dst: 'b', type: 'depends_on' },
    { src: 'a', dst: 'ghost', type: 'depends_on' },
  ],
};

describe('the blueprint block', () => {
  it('draws the row as a canvas, with the dangling edge counted', () => {
    const view = render(<BlueprintBlock detail={graphDetail(BLUEPRINT)} />);

    expect(view.getByTestId('panel-blueprint')).toBeTruthy();
    /* Both real nodes are drawn... */
    expect(view.getByText('Cut the release')).toBeTruthy();
    expect(view.getByText('Announce it')).toBeTruthy();
    /* ...and the edge pointing at nothing is SAID, not silently dropped. */
    expect(view.getByTestId('panel-blueprint-dangling').textContent).toContain('1 edge');
  });

  it('renders nothing for a type it cannot draw, so the block below can speak', () => {
    /* A `mermaid` row's body is its SOURCE (R3). An empty canvas over it would
       claim the row has no nodes; the truth is this renderer does not speak
       that type, and the fields block below already shows the source. */
    const view = render(
      <BlueprintBlock detail={graphDetail({ kind: 'graph', graphType: 'mermaid', source: 'graph TD;' })} />,
    );
    expect(view.queryByTestId('panel-blueprint')).toBeNull();
  });

  it('renders nothing for an empty blueprint rather than an empty frame', () => {
    const view = render(
      <BlueprintBlock detail={graphDetail({ kind: 'graph', graphType: 'entity', nodes: [], edges: [] })} />,
    );
    expect(view.queryByTestId('panel-blueprint')).toBeNull();
  });

  it('sizes its box from the FOLD, not from a constant', () => {
    /* A fixed height was wrong in both directions: measured in Chrome at the
       panel's 320px minimum, a 4-node graph drew 36px tall inside a 320px box
       — ~90% empty — while its titles rendered 4px against 23.1px body text.
       Both numbers now come from `view.bounds`, so the box cannot disagree
       with what is actually drawn. jsdom cannot measure the RESULT, but it can
       pin that the fold's own geometry is what reaches CSS. */
    const view = render(<BlueprintBlock detail={graphDetail(BLUEPRINT)} />);
    const box = view.getByTestId('panel-blueprint');

    const aspect = box.style.getPropertyValue('--pn-bp-aspect');
    const floor = box.style.getPropertyValue('--pn-bp-floor');
    /* Shaped `w / h` off the drawn bounds, and a floor in px — not empty, which
       is what a constant or a missing fold would leave behind. */
    expect(aspect).toMatch(/^\d+(\.\d+)? \/ \d+(\.\d+)?$/);
    expect(floor).toMatch(/^\d+px$/);

    /* The floor is a FRACTION of the drawn width — the point is that it is
       smaller than natural size but not arbitrarily small. */
    const drawnWidth = Number(aspect.split('/')[0]!.trim());
    const floorPx = Number(floor.replace('px', ''));
    expect(floorPx).toBeGreaterThan(0);
    expect(floorPx).toBeLessThan(drawnWidth);
  });

  it('is DECLARED by the graph kind, which is the whole wiring', () => {
    /* The block reaches the panel because the registry asks for it, and it is
       FIRST — the canvas is the row's body, the envelope fields sit under it.
       No component anywhere asks what kind it is holding. */
    const blocks = getKind('graph')?.panel.blocks ?? [];
    expect(blocks[0]?.block).toBe('blueprint');
  });
});
