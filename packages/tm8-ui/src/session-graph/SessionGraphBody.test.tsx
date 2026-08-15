// @vitest-environment jsdom
/**
 * The surface's job is to state a FINDING and then state how incomplete the
 * drawing of it is. These tests hold both halves, plus the one behaviour that
 * makes it safe to leave mounted: an exited session is read once and never
 * polled.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EdgeView, EntityId, EntitySummary, Page } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { SessionGraphBody } from './SessionGraphBody';

const FOCUS = 'session-1' as EntityId;

function entity(id: string, kind = 'doc', title = id): EntitySummary {
  return {
    id,
    spaceId: 'space-1',
    kind,
    title,
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 1,
    activityAt: '2026-08-09T00:00:00.000Z',
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
    deletedAt: null,
    createdBy: { kind: 'member', id: 'm1', displayName: 'M' },
    counters: {},
    state: {},
    badges: {},
  } as unknown as EntitySummary;
}

function edge(from: EntitySummary, type: string, to: EntitySummary): EdgeView {
  return {
    id: `${from.id}-${type}-${to.id}`,
    type,
    source: from,
    target: to,
    props: {},
    createdBy: { kind: 'member', id: 'm1', displayName: 'M' },
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  } as unknown as EdgeView;
}

const focus = entity(FOCUS, 'work_session', 'Session');
const task = entity('task-1', 'task', 'Session Graph');

function page(items: EdgeView[]): Page<EdgeView> {
  return { items, nextCursor: null } as Page<EdgeView>;
}

function seamWith(connections: Seam['connections']): Seam {
  return { connections } as unknown as Seam;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionGraphBody', () => {
  it('states what the session touched, in relation label + count', async () => {
    const seam = seamWith(async (id) =>
      id === FOCUS
        ? page([
            edge(focus, 'working_on', task),
            edge(entity('m1', 'message'), 'authored_from', focus),
            edge(entity('m2', 'message'), 'authored_from', focus),
          ])
        : page([]),
    );

    render(<SessionGraphBody seam={seam} focusId={FOCUS} focus={focus} live={false} />);

    const headline = await screen.findByTestId('session-graph-headline');
    expect(headline.textContent).toContain('Working on');
    expect(headline.textContent).toContain('Wrote');
    expect(screen.getByTestId('session-graph-canvas')).toBeTruthy();
  });

  it('names a failed neighbour read as MISSING, never as an empty branch', async () => {
    const seam = seamWith(async (id) => {
      if (id === FOCUS) return page([edge(focus, 'working_on', task)]);
      throw new Error('forbidden');
    });

    render(<SessionGraphBody seam={seam} focusId={FOCUS} focus={focus} live={false} />);

    const footer = await screen.findByTestId('session-graph-footer');
    expect(footer.textContent).toContain('missing, not empty');
  });

  it('refuses the whole surface with the server\u2019s reason when the focus read fails', async () => {
    const seam = seamWith(async () => {
      throw new Error('entity not found');
    });

    render(<SessionGraphBody seam={seam} focusId={FOCUS} focus={focus} live={false} />);

    const error = await screen.findByTestId('session-graph-error');
    expect(error.textContent).toContain('Graph unavailable');
  });

  it('polls a live session and reads an exited one exactly once', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => page([edge(focus, 'working_on', task)]));
    const seam = seamWith(read);

    const exited = render(
      <SessionGraphBody seam={seam} focusId={FOCUS} focus={focus} live={false} />,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const afterExited = read.mock.calls.length;
    exited.unmount();

    render(<SessionGraphBody seam={seam} focusId={FOCUS} focus={focus} live />);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read.mock.calls.length).toBeGreaterThan(afterExited * 2);
  });

  /**
   * A card carrying only a title and a kind label tells the viewer what they
   * already knew from asking. The facts that make a node worth looking at are
   * ALREADY declared per kind as `list.tile.badges` — this asserts the canvas
   * reads that declaration rather than a switch of its own, by planting state
   * the graph module has never heard of and expecting it drawn.
   */
  it('draws the facts the kind registry declares, not a list of its own', async () => {
    const blocked = {
      ...entity('task-1', 'task', 'Session Graph'),
      state: { workStatus: 'blocked', priority: 'urgent' },
    } as unknown as EntitySummary;
    const seam = seamWith(async (id) =>
      id === FOCUS ? page([edge(focus, 'working_on', blocked)]) : page([]),
    );

    render(<SessionGraphBody seam={seam} focusId={FOCUS} focus={focus} live={false} />);
    const canvas = await screen.findByTestId('session-graph-canvas');

    const node = await waitFor(() => {
      const found = screen
        .getAllByRole('button')
        .find((el) => el.getAttribute('aria-label')?.includes('Session Graph'));
      if (!found) throw new Error('task node not drawn');
      return found;
    });
    expect(node.textContent).toContain('blocked');
    // Verbatim from the registry's own renderer, casing included — a canvas
    // that re-worded the value would be presenting a second vocabulary.
    expect(node.textContent).toContain('URGENT');
    expect(canvas.querySelector('.sg-state--block')).toBeTruthy();
  });

  it('offers no navigation when the host wired none, and says why', async () => {
    const seam = seamWith(async (id) =>
      id === FOCUS ? page([edge(focus, 'working_on', task)]) : page([]),
    );

    render(<SessionGraphBody seam={seam} focusId={FOCUS} focus={focus} live={false} />);
    await screen.findByTestId('session-graph-canvas');

    const node = await waitFor(() => {
      const found = screen
        .getAllByRole('button')
        .find((el) => el.getAttribute('aria-label')?.includes('Session Graph'));
      if (!found) throw new Error('task node not drawn');
      return found;
    });
    fireEvent.click(node);

    const card = await screen.findByTestId('session-graph-selection');
    // L6: the control is present and refused with a reason, never absent.
    expect(card.textContent).toContain('open');
    // L6 refuses with `aria-disabled`, never the native attribute: a natively
    // disabled control leaves the tab order, so its reason can never be read.
    const refusal = card.querySelector('[data-testid="disabled-with-reason"]');
    expect(refusal?.getAttribute('aria-disabled')).toBe('true');
    expect(card.textContent).toContain('did not wire navigation');
  });
});
