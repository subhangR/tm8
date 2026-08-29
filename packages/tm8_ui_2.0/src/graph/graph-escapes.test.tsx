// @vitest-environment jsdom
/**
 * The empty-state ESCAPE LADDER and the unified lens vocabulary (2026-08-29
 * audit, findings 1–3).
 *
 *  1. The empty-lens escape must widen the TIME WINDOW along with the lens —
 *     switching lens alone landed the reader on a second empty state — and the
 *     terminal empty state must carry its own way out, so the ladder never
 *     dead-ends whatever combination of narrowers produced it.
 *  2. Banner, filter dock and empty states must name a lens with the SAME
 *     words, and the banner's instruction is itself the switch it names.
 *  3. The floating shelf must not swallow pointer events over the canvas —
 *     only its own interactive chips take the pointer.
 *
 * Kind literals stay in fixtures (§15.2): every entity here is a fixture
 * summary, structurally overridden (activityAt) where a test needs age.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';
import {
  GRAPH_FIXTURE_NOW,
  graphFixtureEdges,
  graphFixtureNodes,
  skillReview,
  spellDeploy,
  taskBlocked,
} from '../fixtures';
import { GraphView } from './GraphView';

/** A week before the fixture clock — outside every window except All time. */
const OLD = '2026-07-21T12:00:00.000Z';

// jsdom ships no ResizeObserver; the viewport-measure effect needs one. Same
// per-file stub-and-restore gate.test.tsx uses (worker globals are shared).
const priorRO = globalThis.ResizeObserver;
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
});
afterAll(() => {
  if (priorRO === undefined) delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  else globalThis.ResizeObserver = priorRO;
});

/** Fixture singletons with no interest signals: never a seed for Active Only. */
const quiet = (over: Partial<EntitySummary> = {}): EntitySummary[] => [
  { ...spellDeploy, ...over },
  { ...skillReview, ...over },
];

const renderView = (props: Partial<Parameters<typeof GraphView>[0]> = {}) =>
  render(
    <GraphView
      nodes={quiet()}
      edges={[]}
      now={GRAPH_FIXTURE_NOW}
      onSelect={() => {}}
      livenessOf={() => 'not-running'}
      {...props}
    />,
  );

describe('the empty-lens escape (audit 1)', () => {
  it('widens the window to all time along with the lens — no second dead-end', () => {
    // Everything is old AND nothing seeds the default Active Only lens: the
    // canvas opens on the empty-lens rung. Before the fix the escape switched
    // lens only, and the still-narrow window produced a second empty state.
    const view = renderView({ nodes: quiet({ activityAt: OLD }) });
    expect(view.getByText(/Nothing matches the Active Only lens/)).toBeTruthy();

    fireEvent.click(view.getByRole('button', { name: 'Switch to All Types, all time' }));

    // One click, real content: both fixture singletons are on the shelf.
    expect(view.getByRole('button', { name: /deploy-preview/ })).toBeTruthy();
    expect(view.getByRole('button', { name: /code-review/ })).toBeTruthy();
  });

  it('tells a read-backed host to re-query at the all-time window', () => {
    // The window is a READ (GraphViewProps.window docblock): when the host owns
    // it, the escape must call the chooser so the space is actually re-read.
    const onChooseWindow = vi.fn();
    const view = renderView({
      nodes: quiet({ activityAt: OLD }),
      window: '24h',
      onChooseWindow,
    });
    fireEvent.click(view.getByRole('button', { name: 'Switch to All Types, all time' }));
    expect(onChooseWindow).toHaveBeenCalledWith('all');
  });

  it('never dead-ends: the terminal empty state has its own escape', () => {
    // The one ladder that used to bottom out buttonless: My Nodes matches
    // nothing → empty-lens rung → its escape widens lens+window but not
    // My Nodes → terminal rung. That rung now resets every narrower.
    const view = renderView({
      nodes: graphFixtureNodes,
      edges: graphFixtureEdges,
      viewerId: 'viewer-owns-nothing',
      livenessOf: () => 'not-running',
    });
    // A drawn canvas first — the dock only exists over placed nodes.
    fireEvent.click(view.getByRole('button', { name: 'My Nodes' }));
    fireEvent.click(view.getByRole('button', { name: 'Switch to All Types, all time' }));

    const terminal = view.getByText('The graph draws itself as work happens.');
    expect(terminal).toBeTruthy();
    expect(view.getByText(/entities are loaded; none are in this view/)).toBeTruthy();

    fireEvent.click(view.getByRole('button', { name: 'Show the whole space' }));
    // My Nodes cleared, lens and window widest: the canvas is back.
    expect(view.container.querySelectorAll('.gv-node').length).toBeGreaterThan(0);
    expect(view.getByRole('button', { name: 'My Nodes' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps the truly-empty space honest — no escape button over nothing', () => {
    // Zero entities: the default lens finds no seeds (empty-lens rung), and the
    // escape lands on the terminal rung — where a reset button would be a
    // control that can show nothing, so none is drawn.
    const view = renderView({ nodes: [], edges: [] });
    fireEvent.click(view.getByRole('button', { name: 'Switch to All Types, all time' }));
    expect(view.getByText('The graph draws itself as work happens.')).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Show the whole space' })).toBeNull();
  });
});

describe('one lens vocabulary, and the banner instruction is the control (audit 2)', () => {
  it('banner names the lens with the dock\'s words and embeds the switch', () => {
    // A seed (blocked fixture task) plus an unreached singleton: outOfLens > 0,
    // so the honesty banner renders over a non-empty canvas.
    const view = renderView({ nodes: [taskBlocked, { ...spellDeploy }] });
    const banner = view.getByRole('status');

    // The sentence survives, with the dock's words for both lenses…
    expect(banner.textContent).toContain('Active Only shows');
    expect(banner.textContent).toContain('to see them.');
    expect(banner.textContent).not.toContain('Everything');

    // …and the instruction is an inline button that performs what it says.
    fireEvent.click(within(banner).getByRole('button', { name: 'Switch to All Types' }));
    expect(view.queryByRole('status')).toBeNull();
    expect(view.getByRole('button', { name: /deploy-preview/ })).toBeTruthy();
  });

  it('the dock offers the exact words the banner and empty states use', () => {
    const view = renderView({ nodes: graphFixtureNodes, edges: graphFixtureEdges });
    const dock = view.getByRole('group', { name: 'Filters' });
    expect(within(dock).getByRole('button', { name: 'All Types' })).toBeTruthy();
    expect(within(dock).getByRole('button', { name: 'Active Only' })).toBeTruthy();
  });
});

describe('the shelf does not occlude the canvas (audit 3)', () => {
  // jsdom loads no stylesheets, so the rule is pinned at its source: the
  // container ignores the pointer, its interactive children opt back in.
  it('graph.css makes the shelf click-through except on its own buttons', () => {
    // import.meta.url is an http: URL under the jsdom environment, so resolve
    // from the package root (vitest's cwd) the way hex-ban resolves its scan.
    const css = readFileSync(join(process.cwd(), 'src/graph/graph.css'), 'utf8');
    const shelfRule = css.match(/\.gv-shelf\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(shelfRule).toMatch(/pointer-events:\s*none/);
    expect(css).toMatch(/\.gv-shelf button\s*\{\s*pointer-events:\s*auto;?\s*\}/);
  });

  it('shelf chips remain real buttons — the opt-in selector reaches them', () => {
    const view = renderView(); // two quiet singletons → empty-lens rung first
    fireEvent.click(view.getByRole('button', { name: 'Switch to All Types, all time' }));
    const shelf = view.container.querySelector('.gv-shelf');
    expect(shelf).toBeTruthy();
    const chips = shelf!.querySelectorAll('.gv-shelf__chips > *');
    expect(chips.length).toBe(2);
    for (const chip of chips) expect(chip.tagName).toBe('BUTTON');
  });
});
