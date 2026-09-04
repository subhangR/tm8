// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';

import { FIXTURE_SPACE_ID, fixtureSummaries } from '../../fixtures';
import { getKind, type ActionContext, type QueryFilter } from '../../domain';
import { EntityListPanel } from '../EntityListPanel';
import type { MessagePulse } from './useMessagePulses';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

/**
 * A three-deep session chain built from real fixture rows, so the panel walks
 * the same shape it would in the app: root → mid → leaf, plus a sibling of mid.
 */
const sessions = fixtureSummaries.filter((row) => row.state.kind === 'work_session');
const [root, mid, leaf, aunt] = sessions;

const chain: readonly EntitySummary[] = [
  { ...root, parentId: null },
  { ...mid, parentId: root.id },
  { ...leaf, parentId: mid.id },
  { ...aunt, parentId: root.id },
];

const rowsFor = (_filter: QueryFilter): readonly EntitySummary[] => chain;

function renderTree(messagePulses: readonly MessagePulse[]) {
  return render(
    <EntityListPanel kind="work_session" rowsFor={rowsFor} ctx={ctx} messagePulses={messagePulses} />,
  );
}

function message(key: string, fromId: string, toId: string): MessagePulse {
  return { key, kind: 'message', fromId, toId };
}

/** The wire for a level is the `.lp__children` wrapper of the node that owns it. */
function litWires(container: HTMLElement): { direction: string | null; delay: string }[] {
  return [...container.querySelectorAll('.lp__children[data-pulse]')].map((el) => ({
    direction: el.getAttribute('data-pulse'),
    delay: (el as HTMLElement).style.getPropertyValue('--lp-pulse-delay'),
  }));
}

describe('session tree message pulse — rendered', () => {
  it('is registry DATA: sessions opt in', () => {
    expect(getKind('work_session').list.tree?.messagePulse).toBe(true);
    expect(getKind('task').list.tree?.messagePulse).toBeUndefined();
  });

  it('draws nothing at all when no message is in flight', () => {
    const { container } = renderTree([]);
    expect(litWires(container)).toEqual([]);
    expect(container.querySelector('[data-pulse-row]')).toBeNull();
  });

  it('lights the wires between sender and target, staggered along the route', () => {
    // leaf -> aunt: up through mid's wire and root's wire, then down root's —
    // root is shared, so it is lit once, at its earliest position.
    const { container } = renderTree([message('m1', leaf.id, aunt.id)]);
    const wires = litWires(container);
    expect(wires.length).toBeGreaterThan(0);
    expect(wires.map((w) => w.direction)).toContain('up');
    // Staggering is what makes it travel rather than flash: distinct delays.
    expect(new Set(wires.map((w) => w.delay)).size).toBe(wires.length);
    // DOM order is NOT travel order — an outer wrapper renders before the
    // inner one it contains but is reached later. The route is asserted by the
    // delays existing and starting at zero, not by document position.
    expect(wires.map((w) => w.delay)).toContain('0ms');
  });

  it('marks both endpoints, distinguishing the sender from the arrival', () => {
    const { container } = renderTree([message('m1', leaf.id, aunt.id)]);
    expect(container.querySelector('[data-pulse-row="from"]')).toBeTruthy();
    expect(container.querySelector('[data-pulse-row="to"]')).toBeTruthy();
  });

  it('carries a form selector for each pulse kind, not colour alone', () => {
    const { container, rerender } = renderTree([
      { key: 'd1', kind: 'delegation', fromId: root.id, toId: mid.id, evidence: 'entity' },
    ]);
    expect(container.querySelector('[data-pulse-kind="delegation"][data-pulse]')).toBeTruthy();

    rerender(
      <EntityListPanel
        kind="work_session"
        rowsFor={rowsFor}
        ctx={ctx}
        messagePulses={[
          { key: 'c1', kind: 'completion', fromId: mid.id, toId: root.id, outcome: 'exited' },
        ]}
      />,
    );
    expect(container.querySelector('[data-pulse-kind="completion"][data-pulse]')).toBeTruthy();

    rerender(
      <EntityListPanel
        kind="work_session"
        rowsFor={rowsFor}
        ctx={ctx}
        messagePulses={[message('m2', mid.id, root.id)]}
      />,
    );
    expect(container.querySelector('[data-pulse-kind="message"][data-pulse]')).toBeTruthy();
  });

  it('absorbs into the collapsed ancestor, and does not expand the tree to chase it', () => {
    const { container, rerender } = renderTree([]);

    const rowOf = (id: string) => container.querySelector(`[data-session-node="${id}"]`);
    expect(rowOf(leaf.id), 'leaf is visible before collapsing').toBeTruthy();

    // Collapse `mid`, hiding `leaf` behind it.
    const midArrow = rowOf(mid.id)?.closest('.lp__branch')?.querySelector('.pn-st__arrow');
    expect(midArrow, 'mid has a disclosure control').toBeTruthy();
    fireEvent.click(midArrow as Element);
    expect(rowOf(leaf.id), 'leaf is hidden after collapsing').toBeNull();

    // Now a message arrives FOR the hidden leaf.
    rerender(
      <EntityListPanel
        kind="work_session"
        rowsFor={rowsFor}
        ctx={ctx}
        messagePulses={[message('m1', aunt.id, leaf.id)]}
      />,
    );

    // `mid` stands in for it, and the tree stayed collapsed — the pulse must
    // never reveal a subtree the user chose to close.
    const arrival = container.querySelector('[data-pulse-row="to"]');
    expect(arrival).toBeTruthy();
    expect(arrival?.querySelector(`[data-session-node="${mid.id}"]`)).toBeTruthy();
    expect(rowOf(leaf.id), 'tree did not auto-expand').toBeNull();
  });

  it('ignores a pulse whose endpoints are not in this list', () => {
    const { container } = renderTree([message('m1', 'not-here', 'also-not-here')]);
    expect(litWires(container)).toEqual([]);
    expect(container.querySelector('[data-pulse-row]')).toBeNull();
  });
});
