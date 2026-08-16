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
  turnOf(measuredSeeds().flatMap((seed) => call('tm8_read', { id: seed.id }))),
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

  it('cards still open entities from fullscreen', () => {
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
    expect(opened).toEqual([T1]);
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
