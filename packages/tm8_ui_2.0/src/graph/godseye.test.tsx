// @vitest-environment jsdom
/**
 * THE GOD'S-EYE PASS — search that moves, liveness that comes from the verdict,
 * recency that is actually painted, and the legibility floor.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. `vitest` runs with `css: false` in this
 * package, so no test here — this one included — can observe a rendered pixel.
 * Every geometric claim in this change (the 7px labels, the 0.72 opening zoom,
 * the composited head/foot heights) was measured in Firefox by
 * `scripts/render-gate.mjs`, and the numbers live in GRAPH.md. What is asserted
 * below is of two kinds and both are honest about which:
 *
 *   · DOM/BEHAVIOUR — that search marks and moves rather than filtering, that
 *     the Building panel's counts come from the liveness VERDICT, that the
 *     controls exist and do what they say.
 *   · CSS-AS-SOURCE — that a rule is WRITTEN, read out of graph.css as text.
 *     A source assertion cannot prove a rule renders; it can prove a rule that
 *     was deleted is gone, which is what keeps this change from silently
 *     rotting.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { GRAPH_FIXTURE_NOW, graphFixtureEdges, graphFixtureNodes } from '../fixtures';
import { FIT_FLOOR, GraphView, LOD_FAR_BELOW } from './GraphView';
import { searchMatches } from './model';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
});

const css = readFileSync(join(process.cwd(), 'src/graph/graph.css'), 'utf8');

function mount(livenessOf: (id: string) => 'live' | 'stale' | 'not-running' | 'unknown') {
  return render(
    <GraphView
      nodes={graphFixtureNodes}
      edges={graphFixtureEdges}
      now={GRAPH_FIXTURE_NOW}
      onSelect={vi.fn()}
      livenessOf={livenessOf}
      window="all"
      onChooseWindow={vi.fn()}
    />,
  );
}

const dead = () => 'not-running' as const;
const canvasNodes = () => [...document.querySelectorAll('.gv-node')];
const field = () => screen.getByLabelText(/Find on the graph/i) as HTMLInputElement;

// ---------------------------------------------------------------------------
// (a) SEARCH
// ---------------------------------------------------------------------------

describe('finding a node moves the view to it and marks it', () => {
  it('never removes the neighbourhood — a graph with its neighbours gone is a card', () => {
    mount(dead);
    const before = canvasNodes().length;
    expect(before).toBeGreaterThan(2);
    const target = document.querySelector('.gv-node__title')!.textContent!;
    fireEvent.change(field(), { target: { value: target } });
    /* Misses recede; they do not go. The count may RISE — a hit is protected
       from folding and from the render cap, so a match that had folded onto a
       hub comes back as its own card. It must never fall, which is the claim
       that separates "search on a graph" from "filter on a list". The first
       version of this test pinned equality and failed for exactly that reason;
       equality was the wrong claim, not the wrong number. */
    expect(canvasNodes().length).toBeGreaterThanOrEqual(before);
    expect(document.querySelectorAll('.gv-node--unmatched').length).toBeGreaterThan(0);
  });

  it('marks exactly one card as the match the readout is counting', () => {
    mount(dead);
    const target = document.querySelector('.gv-node__title')!.textContent!;
    fireEvent.change(field(), { target: { value: target } });
    expect(document.querySelectorAll('.gv-node--match-current')).toHaveLength(1);
    expect(document.querySelectorAll('.gv-node--match').length).toBeGreaterThan(0);
    // A POSITION, not a bare total: "1 / 3" tells you which one you are on.
    expect(document.querySelector('.gv-search__count')!.textContent).toMatch(/^1 \/ \d/);
  });

  it('steps through the matches, and only offers steppers when there is more than one', () => {
    mount(dead);
    // A query no title can fail to contain: the empty-ish common letter. Chosen
    // off the DATA rather than hard-coded, so a fixture edit cannot silently
    // turn this into a one-match test that passes for the wrong reason.
    fireEvent.change(field(), { target: { value: 'a' } });
    const readout = () => document.querySelector('.gv-search__count')!.textContent!;
    const total = Number(readout().split('/')[1]!.trim().split(' ')[0]);
    expect(total).toBeGreaterThan(1);
    expect(screen.getByRole('button', { name: 'Next match' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(readout()).toMatch(/^2 \//);
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(readout()).toMatch(/^1 \//);
    // Wrapping: back past the first lands on the last, never on nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(readout()).toMatch(new RegExp(`^${total} /`));
  });

  it('says "no match" in words rather than showing a bare zero', () => {
    mount(dead);
    fireEvent.change(field(), { target: { value: 'zzzz-no-such-entity-zzzz' } });
    expect(document.querySelector('.gv-search__count')!.textContent).toMatch(/no match/i);
    expect(document.querySelectorAll('.gv-node--match-current')).toHaveLength(0);
  });

  it('takes `f` — the list panel`s key, not a second find grammar', () => {
    mount(dead);
    expect(document.querySelector('.gv-search__key')!.textContent).toBe('f');
    field().blur();
    fireEvent.keyDown(document, { key: 'f' });
    expect(document.activeElement).toBe(field());
  });

  it('matches the three registers a card actually shows: title, ref tail, kind word', () => {
    const node = graphFixtureNodes[0]!;
    // The mono ref drawn on every card — readable off the screen, so typeable.
    expect(searchMatches([node], node.id.slice(-4)).has(node.id)).toBe(true);
    // The registry's WORD, not the enum. No kind is named here: the resolver is
    // handed in, exactly as GraphView hands in `getKind`.
    const labelled = searchMatches([node], 'wombat noun', () => ['Wombat Noun', 'Wombat Nouns']);
    expect(labelled.has(node.id)).toBe(true);
    // And the guarantee that made this safe to widen: nothing matches nothing.
    expect(searchMatches([node], '   ').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (b) HOW IT IS BUILDING
// ---------------------------------------------------------------------------

describe('the Building panel says what is live and what was just touched', () => {
  it('counts live from the liveness VERDICT, never from a stored status field', () => {
    // The fixtures contain sessions RECORDED as running (`sessionStale`,
    // `sessionFailed` and friends). A verdict of not-running has to beat every
    // one of them, or something on this screen is reading a status column.
    mount(dead);
    expect(screen.getByText('nothing running')).toBeTruthy();
    expect(document.querySelectorAll('.gv-building__rowlive')).toHaveLength(0);

    document.body.innerHTML = '';
    mount(() => 'live');
    const drawn = canvasNodes().length;
    expect(screen.getByTitle(/running right now/i).textContent).toBe(`${drawn} live`);
  });

  it('offers only rows the canvas can travel to, newest first', () => {
    mount(dead);
    const rows = [...document.querySelectorAll<HTMLElement>('.gv-building__row')];
    expect(rows.length).toBeGreaterThan(0);

    const titles = rows.map((r) => r.querySelector('.gv-building__title')!.textContent);
    const drawn = canvasNodes().map((n) => n.querySelector('.gv-node__title')!.textContent);
    for (const t of titles) expect(drawn).toContain(t);

    // Newest first, read off the same `activityAt` the cards use.
    const at = titles.map(
      (t) => Date.parse(graphFixtureNodes.find((n) => n.title === t)!.activityAt),
    );
    expect([...at].sort((a, b) => b - a)).toEqual(at);
  });

  it('carries the recency bucket as data, so the register is per row and not per panel', () => {
    mount(dead);
    for (const row of document.querySelectorAll('.gv-building__row')) {
      expect(['fresh', 'warm', 'rest']).toContain(row.getAttribute('data-heat'));
    }
  });
});

describe('recency is painted at all, which it was not', () => {
  /* The three `.gv-node--fresh/warm/rest` border rules near the top of graph.css
     have been dead since the FLOW-CARD block restated `.gv-node`'s border at
     equal specificity and later in source. They are kept, inert and annotated,
     rather than deleted — the claim is superseded, not wrong-headed, and the
     comment names what superseded it. These assertions are about the LIVE
     rules. */
  it('tints the family stripe by heat, in an order where the newest claim wins', () => {
    const rest = css.indexOf('.cv2-root .gv-node {');
    const warm = css.indexOf('.cv2-root .gv-node--warm {');
    const fresh = css.indexOf('.cv2-root .gv-node--fresh {');
    expect(rest).toBeGreaterThan(-1);
    expect(warm).toBeGreaterThan(rest);
    expect(fresh).toBeGreaterThan(warm);
    for (const i of [rest, warm, fresh]) {
      expect(css.slice(i, css.indexOf('}', i))).toMatch(/border-left-color/);
    }
  });

  it('leaves the superseded rules annotated rather than silently present', () => {
    const note = css.indexOf('SUPERSEDED 2026-08-31');
    const inert = css.indexOf('.gv-node--fresh { border-color');
    expect(note).toBeGreaterThan(-1);
    expect(inert).toBeGreaterThan(note);
  });
});

// ---------------------------------------------------------------------------
// (c) LEGIBILITY — the defect the render gate reported as "crushed"
// ---------------------------------------------------------------------------

describe('the canvas never chooses a zoom its own labels cannot survive', () => {
  it('keeps the opening fit above the level of detail it would have to shed', () => {
    // The whole point of the pair: the view the reader is GIVEN is never in far
    // mode. Reaching far mode has to be something they asked for.
    expect(LOD_FAR_BELOW).toBeLessThan(FIT_FLOOR);
  });

  it('sheds the registers that cannot be read below the threshold, and no others', () => {
    const block = css.slice(css.indexOf(".cv2-root .gv-canvas[data-lod='far'] .gv-node__head"));
    const hidden = block.slice(0, block.indexOf('}'));
    for (const part of ['__head', '__body', '__foot', '__focus']) {
      expect(hidden).toContain(`.gv-node${part}`);
    }
    // The NAME survives every zoom. A card with no name is not an overview.
    expect(hidden).not.toContain('.gv-node__title');
  });

  it('carries the words it hid into the title, the way Minimap already does', () => {
    const view = readFileSync(join(process.cwd(), 'src/graph/GraphView.tsx'), 'utf8');
    expect(view).toMatch(/lod === 'far'[\s\S]{0,200}liveness === 'live' \? ' · live'/);
  });

  it('respects prefers-reduced-motion for everything it animates', () => {
    const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.gv-building__pulse');
    expect(reduced).toContain("[data-lod='far'] .gv-node[data-live='live']::after");
    expect(reduced).toMatch(/animation: none/);
  });
});
