// @vitest-environment jsdom
/**
 * The flying glyph, asserted STRUCTURALLY.
 *
 * jsdom has no layout — every `getBoundingClientRect` is zeros — so nothing
 * here can check where the glyph goes. That is `tile-flight.test.ts`'s job, and
 * it is a pure function precisely so the arc is testable without a browser.
 * What these tests hold is the wiring the geometry cannot: that a flight is
 * created for the right arrivals, refused for the wrong ones, aimed at the
 * rows the route resolved, and never at the cost of the wire sweep beneath it.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';

import { FIXTURE_SPACE_ID, fixtureSummaries } from '../../fixtures';
import { expandTree } from '../../kit/tree-disclosure.testkit';
import type { ActionContext, QueryFilter } from '../../domain';
import { EntityListPanel } from '../EntityListPanel';
import type { MessagePulse } from './useMessagePulses';
import { findAnchor } from './TileFlightLayer';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const sessions = fixtureSummaries.filter((row) => row.state.kind === 'work_session');
const [root, mid, leaf, aunt] = sessions;

const chain: readonly EntitySummary[] = [
  { ...root, parentId: null },
  { ...mid, parentId: root.id },
  { ...leaf, parentId: mid.id },
  { ...aunt, parentId: root.id },
];

const rowsFor = (_filter: QueryFilter): readonly EntitySummary[] => chain;

function panel(messagePulses: readonly MessagePulse[]) {
  return (
    <EntityListPanel kind="work_session" rowsFor={rowsFor} ctx={ctx} messagePulses={messagePulses} />
  );
}

/** The panel ships collapsed; `expandTree` is the viewer opening the subtrees. */
function renderTree(messagePulses: readonly MessagePulse[]) {
  const view = render(panel(messagePulses));
  expandTree(view.container);
  return view;
}

function message(key: string, fromId: string, toId: string): MessagePulse {
  return { key, kind: 'message', fromId, toId };
}

const flightsIn = (container: HTMLElement) => [...container.querySelectorAll('.lp__flight')];

describe('a message flying across the session tiles', () => {
  it('draws no layer at all when nothing is in flight', () => {
    const { container } = renderTree([]);
    expect(container.querySelector('.lp__flights')).toBeNull();
  });

  it('launches one glyph, aimed from the sender row at the recipient row', () => {
    const { container } = renderTree([message('m1', leaf.id, aunt.id)]);
    const flights = flightsIn(container);
    expect(flights).toHaveLength(1);
    expect(flights[0].getAttribute('data-flight-from')).toBe(leaf.id);
    expect(flights[0].getAttribute('data-flight-to')).toBe(aunt.id);
    expect(flights[0].getAttribute('data-flight-kind')).toBe('message');
  });

  /**
   * The whole complaint was that the arrival was not visible. A glyph that
   * renders with no sampled path is a glyph parked at the container's corner,
   * which is worse than the hairline it replaced — so the stops must be there.
   */
  it('carries a full sampled path and a duration, not a bare element', () => {
    const { container } = renderTree([message('m1', leaf.id, aunt.id)]);
    const style = (flightsIn(container)[0] as HTMLElement).style;
    for (let index = 0; index <= 6; index += 1) {
      expect(style.getPropertyValue(`--lp-flight-${index}x`)).toMatch(/px$/);
      expect(style.getPropertyValue(`--lp-flight-${index}y`)).toMatch(/px$/);
    }
    expect(style.getPropertyValue('--lp-flight-duration')).toMatch(/ms$/);
  });

  /**
   * The flight is an ADDITION. The sweep it flies over is what survives
   * `prefers-reduced-motion` and what tells the routing story, so a change that
   * traded one for the other would be a regression wearing an improvement.
   */
  it('does not replace the wire sweep it flies above', () => {
    const { container } = renderTree([message('m1', leaf.id, aunt.id)]);
    expect(container.querySelectorAll('.lp__children[data-pulse]').length).toBeGreaterThan(0);
    expect(container.querySelector('[data-pulse-row="from"]')).toBeTruthy();
    expect(container.querySelector('[data-pulse-row="to"]')).toBeTruthy();
    expect(flightsIn(container)).toHaveLength(1);
  });

  it('gives each kind its own glyph, so colour is never the only difference', () => {
    const { container, rerender } = renderTree([message('m1', leaf.id, aunt.id)]);
    const pathsOf = () => [...container.querySelectorAll('.lp__flight path')]
      .map((node) => node.getAttribute('d'));

    const bubble = pathsOf();
    expect(bubble).toHaveLength(1);

    rerender(panel([
      { key: 'd1', kind: 'delegation', fromId: root.id, toId: leaf.id, evidence: 'entity' },
    ]));
    const chevron = pathsOf();
    expect(container.querySelector('[data-flight-kind="delegation"]')).toBeTruthy();

    rerender(panel([
      { key: 'c1', kind: 'completion', fromId: leaf.id, toId: root.id, outcome: 'exited' },
    ]));
    const barred = pathsOf();
    expect(container.querySelector('[data-flight-kind="completion"]')).toBeTruthy();

    // Three kinds, three distinct drawings — not one mark in three colours.
    expect(new Set([bubble.join(), chevron.join(), barred.join()]).size).toBe(3);
  });

  it('marks a failed completion so its glyph can take the blocked colour', () => {
    const { container } = renderTree([
      { key: 'c1', kind: 'completion', fromId: leaf.id, toId: root.id, outcome: 'failed' },
    ]);
    expect(container.querySelector('[data-flight-outcome="failed"]')).toBeTruthy();
  });

  it('flies concurrent arrivals concurrently, each with its own key', () => {
    const { container } = renderTree([
      message('m1', leaf.id, aunt.id),
      message('m2', aunt.id, mid.id),
    ]);
    expect(flightsIn(container)).toHaveLength(2);
  });

  it('refuses a flight when an endpoint is not in this list', () => {
    const { container } = renderTree([message('m1', leaf.id, 'not-here')]);
    // The sender still glows — the arrival happened, and half of it is on screen.
    expect(container.querySelector('[data-pulse-row="from"]')).toBeTruthy();
    expect(flightsIn(container)).toHaveLength(0);
  });

  /**
   * Traffic INSIDE a subtree the viewer has closed. Both ends absorb onto the
   * one standing-in row, and a glyph orbiting a single tile would say less than
   * that row's own glow already does.
   */
  it('refuses a flight when both ends absorb onto the same row', () => {
    const { container, rerender } = renderTree([]);
    const rowOf = (id: string) => container.querySelector(`[data-session-node="${id}"]`);

    const midArrow = rowOf(mid.id)?.closest('.lp__branch')?.querySelector('.pn-st__arrow');
    fireEvent.click(midArrow as Element);
    expect(rowOf(leaf.id), 'leaf is hidden behind mid').toBeNull();

    // leaf -> mid, with leaf collapsed away: both ends resolve to `mid`.
    rerender(panel([message('m1', leaf.id, mid.id)]));
    expect(container.querySelector('[data-pulse-row]')).toBeTruthy();
    expect(flightsIn(container)).toHaveLength(0);
  });

  /**
   * THE LATE LAUNCH, REFUSED (found in review by GPT 5.6 Sol, PR #591).
   *
   * An arrival into a closed subtree has no two visible ends, so it does not
   * fly. If the viewer then OPENS that subtree while the 2200ms pulse is still
   * retained, both ends resolve and a flight would be born — for an event up
   * to two seconds old, triggered by a gesture that has nothing to do with it.
   * It would also be born LATE, and `tile-flight.ts`'s duration clamp only
   * guarantees a flight outlives its pulse when it starts AT arrival, so the
   * glyph could be deleted in open air between two tiles.
   */
  it('does not replay an old arrival when its subtree is expanded later', () => {
    const { container, rerender } = renderTree([]);
    const rowOf = (id: string) => container.querySelector(`[data-session-node="${id}"]`);

    const midArrow = rowOf(mid.id)?.closest('.lp__branch')?.querySelector('.pn-st__arrow');
    fireEvent.click(midArrow as Element);
    expect(rowOf(leaf.id), 'leaf is hidden behind mid').toBeNull();

    // Arrives while shut: both ends absorb onto `mid`, so nothing flies.
    rerender(panel([message('m1', leaf.id, mid.id)]));
    expect(flightsIn(container)).toHaveLength(0);

    // The viewer opens the subtree while that same pulse is still retained.
    fireEvent.click(
      rowOf(mid.id)?.closest('.lp__branch')?.querySelector('.pn-st__arrow') as Element,
    );
    expect(rowOf(leaf.id), 'leaf is visible again').toBeTruthy();

    // Both ends now resolve to distinct rows — and it still must not fly.
    expect(flightsIn(container)).toHaveLength(0);
    // The arrival is still reported, by the treatment that was carrying it all
    // along. Refusing the flight must not cost the report.
    expect(container.querySelector('[data-pulse-row]')).toBeTruthy();
  });

  /**
   * The other half of the rule, and the one an over-broad refusal breaks: a
   * flight ALREADY IN THE AIR when the tree changes shape must keep flying and
   * be re-measured, not killed. A refusal written as "have I seen this key
   * before" alone would delete every live flight the moment anything collapsed.
   */
  it('keeps a live flight airborne when a collapse merely re-aims it', () => {
    const { container, rerender } = renderTree([message('m1', leaf.id, aunt.id)]);
    expect(flightsIn(container)[0]?.getAttribute('data-flight-from')).toBe(leaf.id);

    const rowOf = (id: string) => container.querySelector(`[data-session-node="${id}"]`);
    // Collapse `mid`, hiding the SENDER mid-flight. Both ends are still
    // distinct rows, so the flight survives with a new takeoff point.
    fireEvent.click(
      rowOf(mid.id)?.closest('.lp__branch')?.querySelector('.pn-st__arrow') as Element,
    );
    rerender(panel([message('m1', leaf.id, aunt.id)]));

    const still = flightsIn(container);
    expect(still).toHaveLength(1);
    expect(still[0].getAttribute('data-flight-from')).toBe(mid.id);
  });

  /** The refusal must be narrow: an arrival into an OPEN tree still flies. */
  it('still flies an arrival that lands while both ends are already visible', () => {
    const { container, rerender } = renderTree([]);
    expect(flightsIn(container)).toHaveLength(0);
    rerender(panel([message('m1', leaf.id, aunt.id)]));
    expect(flightsIn(container)).toHaveLength(1);
  });

  /** A collapsed endpoint re-aims at its stand-in rather than dropping. */
  it('re-aims at the ancestor standing in for a collapsed endpoint', () => {
    const { container, rerender } = renderTree([]);
    const rowOf = (id: string) => container.querySelector(`[data-session-node="${id}"]`);

    const midArrow = rowOf(mid.id)?.closest('.lp__branch')?.querySelector('.pn-st__arrow');
    fireEvent.click(midArrow as Element);

    rerender(panel([message('m1', aunt.id, leaf.id)]));
    const flights = flightsIn(container);
    expect(flights).toHaveLength(1);
    expect(flights[0].getAttribute('data-flight-from')).toBe(aunt.id);
    expect(flights[0].getAttribute('data-flight-to')).toBe(mid.id);
    expect(rowOf(leaf.id), 'and the tree stayed closed').toBeNull();
  });

  /**
   * A row with its Connections relation open renders that relation's rows as
   * REAL tiles, so one id can be in the tree TWICE — once as its own row, once
   * as a nested copy inside another row's panel. An unqualified attribute match
   * takes whichever is first in document order, which can aim a flight at a
   * copy sitting inside an unrelated row.
   */
  it('aims at the tree row, never a nested copy of the same id in a related panel', () => {
    const host = document.createElement('div');
    // THE ORDER IS THE TEST. An EARLIER row has its relation open and lists a
    // session whose own row comes LATER, so the nested copy is first in
    // document order and a bare attribute match returns it. A fixture with the
    // real row first passes either way and proves nothing.
    host.innerHTML = `
      <div class="lp__branch">
        <div class="pn-st" data-session-node="earlier"></div>
        <div class="lp__related">
          <div class="pn-st" data-session-node="target" id="the-copy"></div>
        </div>
      </div>
      <div class="lp__branch">
        <div class="pn-st" data-session-node="target" id="the-row"></div>
      </div>
    `;
    expect(host.querySelectorAll('[data-session-node="target"]')).toHaveLength(2);
    // The arrangement really is the hostile one: unqualified finds the copy.
    expect(host.querySelector('[data-session-node="target"]')?.id).toBe('the-copy');
    expect(findAnchor(host, 'target')?.id).toBe('the-row');
    expect(findAnchor(host, 'absent')).toBeNull();
  });

  it('is registry data: a list that did not opt in never flies anything', () => {
    const { container } = render(
      <EntityListPanel
        kind="task"
        rowsFor={() => chain}
        ctx={ctx}
        messagePulses={[message('m1', leaf.id, aunt.id)]}
      />,
    );
    expect(container.querySelector('.lp__flights')).toBeNull();
  });
});
