// @vitest-environment jsdom
/**
 * FULLSCREEN entity graph (plan 01a0094b step 4) — asserted through the
 * inline host, because the open state is the HOST'S route mapping, never
 * this component's own: Expand asks the host to navigate, Esc/scrim/✕ ask
 * it to navigate away, and closing returns focus to Expand.
 *
 * Pan is NOT asserted here: jsdom draws nothing, `getBoundingClientRect`
 * answers zeros, and the pan math divides by the canvas rect — a browser
 * capture is that behaviour's instrument. Zoom is pure viewBox arithmetic
 * and IS asserted.
 */
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { EdgeView, EntityId, Page } from '@tm8/contract';
import type { ConnectionsReader } from '../session-graph/load';
import { ChatEntityGraph } from './ChatEntityGraph';
import { MAX_ZOOM, perRowForViewport } from './ChatEntityGraphFullscreen';
import { CARD_W, GAP_X, PAD } from './induced-layout';
import { measuredConnections, measuredSeeds, T1 } from './induced-graph.fixture';
import type { ChatTurn, ChatTurnPart } from './types';

afterEach(cleanup);

let seq = 0;
const call = (name: string, args: unknown): ChatTurnPart[] => [
  { kind: 'tool_call', seq: (seq += 1), toolCallId: `tc-${(seq += 1)}`, name, args, state: 'completed' },
];
const turnOf = (parts: ChatTurnPart[]): ChatTurn => ({
  messageId: `msg-${(seq += 1)}` as EntityId,
  role: 'assistant',
  author: null,
  createdAt: '2026-08-16T10:00:00.000Z',
  body: '',
  parts,
});
const measuredTurns = (): ChatTurn[] => [
  turnOf(
    measuredSeeds().flatMap((seed) =>
      call(seed.id === T1 ? 'tm8_update_entity' : 'tm8_read', { id: seed.id }),
    ),
  ),
];
const reader = (): ConnectionsReader => {
  const pages = measuredConnections();
  return (id) => {
    const page = pages.get(id);
    if (!page || page.state !== 'loaded') return Promise.reject(new Error('403'));
    return Promise.resolve({
      items: page.edges as EdgeView[],
      nextCursor: page.pageCapped ? 'more' : null,
    } as unknown as Page<EdgeView>);
  };
};

function renderHost(expanded: boolean, onExpandedChange: (open: boolean) => void) {
  return render(
    <ChatEntityGraph
      turns={measuredTurns()}
      connections={reader()}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
    />,
  );
}

describe('the Expand trigger', () => {
  it('renders beside the toggle only when the host wired the route, and asks to open', () => {
    const asks: boolean[] = [];
    renderHost(false, (open) => asks.push(open));
    fireEvent.click(screen.getByTitle('Open the graph fullscreen'));
    expect(asks).toEqual([true]);
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();
    // A host with no routing (every existing caller): no button, no dialog.
    render(<ChatEntityGraph turns={measuredTurns()} connections={reader()} />);
    expect(screen.queryByTitle('Open the graph fullscreen')).toBeNull();
  });
});

describe('the fullscreen dialog', () => {
  it('is a modal dialog named by the caption, holding focus, drawing every card', () => {
    renderHost(true, () => {});
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toMatch(/^Entity graph — 10 entities/);
    expect(document.activeElement).toBe(dialog);
    const canvas = screen.getByTestId('ceg-full-canvas');
    expect(canvas.querySelectorAll('.ceg-cell')).toHaveLength(10);
  });

  it('Esc, the close button and a scrim click each ask the HOST to navigate away', () => {
    const asks: boolean[] = [];
    const { unmount } = renderHost(true, (open) => asks.push(open));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByLabelText('Close fullscreen graph'));
    const scrim = screen.getByTestId('chat-entity-graph-fullscreen');
    fireEvent.mouseDown(scrim);
    fireEvent.mouseUp(scrim);
    expect(asks).toEqual([false, false, false]);
    // The dialog itself never closed — the host owns the state (D2).
    expect(screen.getByRole('dialog')).toBeDefined();
    unmount();
  });

  it('closing returns focus to Expand', () => {
    const { rerender } = renderHost(true, () => {});
    rerender(
      <ChatEntityGraph
        turns={measuredTurns()}
        connections={reader()}
        expanded={false}
        onExpandedChange={() => {}}
      />,
    );
    expect(document.activeElement).toBe(screen.getByTitle('Open the graph fullscreen'));
  });
});

describe('zoom (a pure viewBox transform)', () => {
  const viewBoxOf = () =>
    screen
      .getByTestId('ceg-full-canvas')
      .querySelector('svg')!
      .getAttribute('viewBox')!
      .split(' ')
      .map(Number);

  it('starts at Fit — the whole placement — and zooms in by shrinking the window', () => {
    renderHost(true, () => {});
    const [, , w0, h0] = viewBoxOf();
    fireEvent.click(screen.getByLabelText('Zoom in'));
    const [, , w1, h1] = viewBoxOf();
    expect(w1!).toBeLessThan(w0!);
    expect(h1!).toBeLessThan(h0!);
    expect(screen.getByText('125%')).toBeDefined();
    fireEvent.click(screen.getByText('Fit'));
    expect(viewBoxOf()).toEqual([0, 0, w0, h0]);
    expect(screen.getByText('100%')).toBeDefined();
  });

  it('the keyboard zooms too, and the range clamps at 25%–400%', () => {
    renderHost(true, () => {});
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: '+' });
    expect(screen.getByText('125%')).toBeDefined();
    for (let i = 0; i < 20; i += 1) fireEvent.keyDown(dialog, { key: '+' });
    expect(screen.getByText(`${MAX_ZOOM * 100}%`)).toBeDefined();
    for (let i = 0; i < 40; i += 1) fireEvent.keyDown(dialog, { key: '-' });
    expect(screen.getByText('25%')).toBeDefined();
  });

  it('a fullscreen card click SELECTS (step 6) — opening moved to the detail panel', () => {
    const opened: string[] = [];
    cleanup();
    render(
      <ChatEntityGraph
        turns={measuredTurns()}
        connections={reader()}
        expanded
        onExpandedChange={() => {}}
        onOpenEntity={(id) => opened.push(id)}
      />,
    );
    const canvas = screen.getByTestId('ceg-full-canvas');
    const card = [...canvas.querySelectorAll('.ceg-cell[role="button"]')][7]!;
    fireEvent.click(card);
    expect(opened).toEqual([]);
    expect(card.getAttribute('aria-pressed')).toBe('true');
    // A second click deselects.
    fireEvent.click(card);
    expect(card.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('perRowForViewport', () => {
  it('derives columns from width, clamped 4–12 (D3/D4)', () => {
    const pitch = CARD_W + GAP_X;
    expect(perRowForViewport(0)).toBe(4);
    expect(perRowForViewport(2 * PAD + 6 * pitch + 10)).toBe(6);
    expect(perRowForViewport(100000)).toBe(12);
  });
});

/** Stateful host: the route reduced to two useState cells, so chip edits
 *  round-trip through the encoded `gf` string exactly as the URL would. */
function Harness({ onOpen }: { onOpen?: (id: string) => void }) {
  const [expanded, setExpanded] = useState(true);
  const [gf, setGf] = useState<string | null>(null);
  return (
    <ChatEntityGraph
      turns={measuredTurns()}
      connections={reader()}
      expanded={expanded}
      onExpandedChange={setExpanded}
      graphFilters={gf}
      onGraphFiltersChange={setGf}
      {...(onOpen ? { onOpenEntity: onOpen as (id: EntityId) => void } : {})}
    />
  );
}

const fullCanvas = () => screen.getByTestId('ceg-full-canvas');
const fullCards = () => [...fullCanvas().querySelectorAll('.ceg-cell')];

describe('the filter rail (step 5)', () => {
  it('a kind chip reduces the drawn set THROUGH the encoded gf round-trip, and the summary counts the loss', async () => {
    render(<Harness />);
    const chip = await screen.findByLabelText(/^Tasks 3$/);
    fireEvent.click(chip);
    expect(fullCards()).toHaveLength(3);
    expect(screen.getByTestId('ceg-full-summary').textContent).toBe(
      'Showing 3 of 10 drawn · 0 relations · 7 hidden by filter',
    );
    // Reset restores everything and clears the param.
    fireEvent.click(screen.getByText('Reset'));
    expect(fullCards()).toHaveLength(10);
  });

  it('search DIMS matches out of the noise, never removing a card', async () => {
    render(<Harness />);
    await screen.findByLabelText(/^Tasks 3$/);
    fireEvent.change(screen.getByLabelText('Search entities'), {
      target: { value: 'deployment' },
    });
    expect(fullCards()).toHaveLength(10);
    expect(fullCanvas().querySelectorAll('.ceg-cell--dim')).toHaveLength(9);
    const lit = fullCanvas().querySelector('.ceg-cell:not(.ceg-cell--dim)');
    expect(lit!.getAttribute('aria-label')).toContain('deployment');
  });

  it('relation-type chips strip relations, honestly labelled as scoped to edges read', async () => {
    render(<Harness />);
    const chip = await screen.findByLabelText(/^Working on 3$/);
    expect(screen.getByText('Relations (among edges read)')).toBeDefined();
    fireEvent.click(chip);
    expect(screen.getByTestId('ceg-full-summary').textContent).toBe(
      'Showing 10 of 10 drawn · 3 relations',
    );
    expect(fullCards()).toHaveLength(10);
  });
});

describe('selection and neighbourhood focus (step 6)', () => {
  const cardNamed = (fragment: string) =>
    fullCards().find((cell) => cell.getAttribute('aria-label')!.includes(fragment))!;

  it('click selects, dims outside the 1-hop hood, and opens the detail panel', async () => {
    const opened: string[] = [];
    render(<Harness onOpen={(id) => opened.push(id)} />);
    await screen.findByLabelText(/^Tasks 3$/);
    fireEvent.click(cardNamed('Task: Fix THis'));
    const detail = screen.getByTestId('ceg-full-detail');
    expect(detail.textContent).toContain('Fix THis');
    expect(detail.textContent).toContain('edited');
    // T1's hood: M1 (assigned_to), S1 (working_on), S4 (relates_to) + itself.
    expect(fullCanvas().querySelectorAll('.ceg-cell--dim')).toHaveLength(6);
    expect(detail.querySelectorAll('li').length).toBeGreaterThanOrEqual(3);
    // Selecting did NOT open; the detail panel's explicit button does.
    expect(opened).toEqual([]);
    fireEvent.click(screen.getByText('Open entity'));
    expect(opened).toEqual([T1]);
  });

  it('Esc clears the selection FIRST and closes only from an unselected state', async () => {
    render(<Harness />);
    await screen.findByLabelText(/^Tasks 3$/);
    fireEvent.click(cardNamed('Task: Fix THis'));
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByTestId('ceg-full-detail')).toBeNull();
    expect(screen.getByRole('dialog')).toBeDefined();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a selection the filters remove is no selection', async () => {
    render(<Harness />);
    const chip = await screen.findByLabelText(/^Tasks 3$/);
    fireEvent.click(cardNamed('Task: Fix THis'));
    expect(screen.getByTestId('ceg-full-detail')).toBeDefined();
    // Filter to sessions only: T1 vanishes, and so must the panel.
    fireEvent.click(chip);
    fireEvent.click(screen.getByLabelText(/^Sessions 4/));
    fireEvent.click(chip); // un-check tasks again
    expect(screen.queryByTestId('ceg-full-detail')).toBeNull();
  });
});

describe('the inline echo (step 5: read-only, counts stay honest)', () => {
  it('echoes the loss under the inline strip when the URL carries filters', async () => {
    render(
      <ChatEntityGraph
        turns={measuredTurns()}
        connections={reader()}
        graphFilters="k:task"
      />,
    );
    await screen.findByTestId('ceg-filter-echo');
    // Kinds resolve from the edge payloads, so the echo settles with them.
    expect(screen.getByTestId('ceg-filter-echo').textContent).toBe(
      'Filtered: showing 3 of 10 · 7 hidden · 14 relations hidden',
    );
    expect(document.querySelectorAll('.ceg .ceg__canvas .ceg-cell')).toHaveLength(3);
    // Read-only: the inline strip offers no filter controls.
    expect(screen.queryByLabelText(/^Tasks/)).toBeNull();
  });
});
