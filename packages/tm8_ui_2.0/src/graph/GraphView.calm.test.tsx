// @vitest-environment jsdom
/**
 * Calm-pass contracts for the graph chrome.
 *
 * Geometry itself closes in Firefox, but these DOM/CSS pins protect the two
 * structural decisions that make that geometry reliable: floating controls
 * are positioned inside the viewport (below any honesty copy), and contextual
 * band frames never become stacking contexts. The remaining assertions encode
 * the house width law: names persist while optional counts yield.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import {
  GRAPH_FIXTURE_NOW,
  graphFixtureEdges,
  graphFixtureNodes,
} from '../fixtures';
import { GraphView } from './GraphView';

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

const css = readFileSync(join(process.cwd(), 'src/graph/graph.css'), 'utf8');
const rule = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's'))?.[1] ?? '';
};

const mountHonestCanvas = () =>
  render(
    <GraphView
      nodes={graphFixtureNodes}
      edges={graphFixtureEdges}
      now={GRAPH_FIXTURE_NOW}
      onSelect={() => {}}
      livenessOf={() => 'not-running'}
    />,
  );

describe('calm graph chrome', () => {
  it('anchors a closed-at-rest Legend inside the viewport below honesty copy', () => {
    const view = mountHonestCanvas();
    const root = view.container.querySelector('.gv-root');
    const banner = screen.getByRole('status');
    const viewport = view.container.querySelector('.gv-viewport');
    const legend = view.container.querySelector('details.gv-legend') as HTMLDetailsElement;

    expect(banner.parentElement).toBe(root);
    expect(viewport?.parentElement).toBe(root);
    expect(legend.closest('.gv-viewport')).toBe(viewport);
    expect(legend.open).toBe(false);

    fireEvent.click(within(legend).getByText('Legend'));
    expect(legend.open).toBe(true);

    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true });
    legend.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
  });

  it('omits redundant filter totals until the filter changes', () => {
    mountHonestCanvas();
    expect(screen.getByText(/^Nodes · \d+/)).toBeTruthy();
    const trigger = screen.getByRole('button', { name: 'Entities' });
    expect(trigger.textContent).not.toMatch(/\d+\/\d+/);

    fireEvent.click(trigger);
    const options = within(screen.getByRole('listbox', { name: 'Entities filter' }))
      .getAllByRole('checkbox');
    fireEvent.click(options[0]);

    expect(trigger.querySelector('.gv-select__name')?.textContent).toBe('Entities');
    expect(trigger.querySelector('.gv-select__state')?.textContent).toMatch(/\d+\/\d+/);
  });
});

describe('calm graph CSS invariants', () => {
  it('keeps the contextual band frame out of a stacking context', () => {
    expect(rule('.gv-band')).not.toMatch(/z-index/);
    expect(rule('.gv-band__head')).toMatch(/z-index:\s*2/);
  });

  it('lets optional counts contract before their names', () => {
    expect(rule('.gv-select__name,\n.gv-select__chevron')).toMatch(/flex:\s*none/);
    expect(rule('.gv-select__state')).toMatch(/min-width:\s*0/);
    expect(rule('.gv-select__state')).toMatch(/overflow:\s*hidden/);
    expect(rule('.gv-band__label')).not.toMatch(/text-overflow/);
    expect(rule('.gv-band__count')).toMatch(/min-width:\s*0/);
    // NEVER CLIP A NUMBER BARE. The count is the child elected to yield, so it
    // is the one that can truncate — and a bare clip turns 128 into 12, a wrong
    // number wearing a right one's clothes. The ellipsis is what makes the
    // truncation legible AS truncation.
    expect(rule('.gv-band__count')).toMatch(/text-overflow:\s*ellipsis/);
    // BOTH HALVES OF THE LAW. A yielding count is only half of it: the child
    // that cannot shrink needs a ceiling, or it overflows its own trigger the
    // moment a label stops being a short fixed literal. `rule` matches the
    // standalone .gv-select__name block, not the grouped flex: none selector
    // above it, because that one is followed by a comma rather than a brace.
    expect(rule('.gv-select__name')).toMatch(/max-width/);
    expect(rule('.gv-select__name')).toMatch(/text-overflow:\s*ellipsis/);
  });
});
