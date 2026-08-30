// @vitest-environment jsdom
/**
 * The grouping CONTROL and the band frames, in a DOM.
 *
 * grouping.test.ts proves the partition is correct. This file proves the reader
 * can reach it: that the control offers the dimensions, that choosing one draws
 * the frames, that a header collapses its own band, and — the one that matters
 * most — that the toolbar ADMITS what collapsing hid. A band that swallows
 * twelve cards silently is the exact failure the accounting law exists to stop,
 * and the law is only enforced on screen if something prints the number.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { GraphView } from './GraphView';
import { GRAPH_FIXTURE_NOW, graphFixtureEdges, graphFixtureNodes } from '../fixtures';

/* jsdom implements no layout, so it ships no ResizeObserver; the canvas
   observes its viewport to fit. A no-op observer is the honest stub — it never
   fires, so the fit-on-resize path simply does not run, which is exactly the
   behavior of a viewport that never changes size. Nothing here asserts on
   geometry, which jsdom could not answer anyway (that is graph-dev.html's job). */
beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
});

function mount() {
  return render(
    <GraphView
      nodes={graphFixtureNodes}
      edges={graphFixtureEdges}
      now={GRAPH_FIXTURE_NOW}
      onSelect={vi.fn()}
      livenessOf={() => 'unknown'}
      window="all"
      onChooseWindow={vi.fn()}
    />,
  );
}

const openGroupMenu = (): void => {
  fireEvent.click(screen.getByRole('button', { name: /^Group ·/ }));
};

const chooseGroup = (label: string | RegExp): void => {
  openGroupMenu();
  const list = screen.getByRole('listbox', { name: 'Group the graph by' });
  fireEvent.click(within(list).getByRole('option', { name: new RegExp(label, 'i') }));
};

describe('the grouping control', () => {
  it('starts off, and says so on its face', () => {
    mount();
    expect(screen.getByRole('button', { name: /^Group · off/ })).toBeTruthy();
    expect(document.querySelectorAll('.gv-band')).toHaveLength(0);
  });

  it('offers the dimensions with a hint each, so the partition is legible before the click', () => {
    mount();
    openGroupMenu();
    const list = screen.getByRole('listbox', { name: 'Group the graph by' });
    const options = within(list).getAllByRole('option');
    expect(options.length).toBeGreaterThan(1);
    for (const opt of options) {
      expect(opt.querySelector('.gv-select__hint')?.textContent?.trim()).toBeTruthy();
    }
  });

  it('draws one frame per band, each with a label and a count', () => {
    mount();
    chooseGroup('Kind');
    const bands = document.querySelectorAll('.gv-band');
    expect(bands.length).toBeGreaterThan(1);
    for (const b of bands) {
      expect(b.querySelector('.gv-band__label')?.textContent?.trim()).toBeTruthy();
      expect(Number(b.querySelector('.gv-band__count')?.textContent)).toBeGreaterThan(0);
    }
    expect(screen.getByRole('button', { name: /^Group · Kind/ })).toBeTruthy();
  });

  it('going back to no grouping removes every frame', () => {
    mount();
    chooseGroup('Kind');
    expect(document.querySelectorAll('.gv-band').length).toBeGreaterThan(0);
    chooseGroup('No grouping');
    expect(document.querySelectorAll('.gv-band')).toHaveLength(0);
  });
});

describe('collapsing a band from its header', () => {
  it('collapses only its own band, and the toolbar states the number it hid', () => {
    mount();
    chooseGroup('Kind');
    const cards = (): number => document.querySelectorAll('.gv-node').length;
    const before = cards();
    const head = document.querySelector('.gv-band__head') as HTMLElement;
    const count = Number(head.querySelector('.gv-band__count')!.textContent);

    expect(head.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(head);

    const nowHead = document.querySelector('.gv-band__head') as HTMLElement;
    expect(nowHead.getAttribute('aria-expanded')).toBe('false');
    // THE HONESTY CHECK: the hidden nodes are named, with their remedy.
    expect(screen.getByText(new RegExp(`Collapsed band · ${count}`))).toBeTruthy();
    // And the band it belongs to is still on the canvas to be reopened.
    expect(document.querySelector('.gv-band--collapsed')).toBeTruthy();
    // Exactly that band's cards left the canvas — no more, no fewer. This is
    // the accounting law asserted where the reader actually experiences it.
    expect(before).toBeGreaterThan(0);
    expect(cards()).toBe(before - count);
  });

  it('reopens on a second click, and the admission disappears with it', () => {
    mount();
    chooseGroup('Kind');
    const head = () => document.querySelector('.gv-band__head') as HTMLElement;
    fireEvent.click(head());
    expect(screen.queryByText(/Collapsed band/)).toBeTruthy();
    fireEvent.click(head());
    expect(screen.queryByText(/Collapsed band/)).toBeNull();
    expect(document.querySelector('.gv-band--collapsed')).toBeNull();
  });

  it('switching dimension clears collapse — a band key means nothing in another partition', () => {
    mount();
    chooseGroup('Kind');
    fireEvent.click(document.querySelector('.gv-band__head') as HTMLElement);
    expect(screen.queryByText(/Collapsed band/)).toBeTruthy();
    chooseGroup('Signal');
    expect(screen.queryByText(/Collapsed band/)).toBeNull();
  });
});
