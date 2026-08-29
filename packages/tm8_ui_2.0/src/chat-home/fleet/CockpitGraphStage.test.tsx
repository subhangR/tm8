// @vitest-environment jsdom
/**
 * THE COCKPIT GRAPH TAB'S HONESTY RULES.
 *
 * The graph's whole value is that it draws only relations the graph really
 * holds. So what is pinned here is the difference between the three ways a
 * relation can be absent — not read, read and none, not looked at — because a
 * picture that collapses them into one is a picture that lies while looking
 * complete.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityDetail, EntityId } from '@tm8/contract';
import { CockpitGraphStage } from './CockpitGraphStage';
import { resetFleetEntityCache } from './use-fleet-entities';
import type { ChatTurn, ChatTurnPart } from '../types';

const id = (n: number): string => `01a01400-00cc-7000-8000-${String(n).padStart(12, '0')}`;
const A = id(1);
const B = id(2);

let seq = 0;
const call = (name: string, args: unknown): ChatTurnPart[] => [
  { kind: 'tool_call', seq: (seq += 1), toolCallId: `tc-${seq}`, name, args, state: 'completed' },
];

const turn = (parts: ChatTurnPart[]): ChatTurn => ({
  messageId: `msg-${(seq += 1)}` as EntityId,
  role: 'assistant',
  author: null,
  createdAt: '2026-08-18T12:00:00.000Z',
  body: '',
  parts,
});

const namesBoth = turn([...call('tm8_read', { id: A }), ...call('tm8_read', { id: B })]);

beforeEach(() => resetFleetEntityCache());

/** An `entities.connections` page carrying one real edge between A and B. */
const edgeAB = {
  items: [
    {
      id: 'e1',
      type: 'relates_to',
      source: { id: A, kind: 'task', title: 'the task' },
      target: { id: B, kind: 'doc', title: 'the doc' },
    },
  ],
  nextCursor: null,
} as never;

describe('CockpitGraphStage — it draws only what the graph returned', () => {
  it('with no connections reader, nothing claims to be isolated', async () => {
    render(<CockpitGraphStage turns={[namesBoth]} />);
    await screen.findByTestId('cockpit-graph');
    const text = screen.getByTestId('cockpit-graph').textContent ?? '';
    // "unread relations" is the honest report; "related to nothing else" would
    // be a claim we never checked.
    expect(text).toMatch(/unread relations/);
    expect(text).not.toMatch(/related to nothing else/);
  });

  it('a settled read with no matching edge IS isolated — an answer, not a failure', async () => {
    const connections = vi.fn(async () => ({ items: [], nextCursor: null }) as never);
    render(<CockpitGraphStage turns={[namesBoth]} connections={connections} />);
    await waitFor(() =>
      expect(screen.getByTestId('cockpit-graph').textContent).toMatch(/related to nothing else/),
    );
    expect(screen.getByTestId('cockpit-graph').textContent).not.toMatch(/unread relations/);
  });

  it('a failed read is NOT isolated — its edges are simply unknown', async () => {
    const connections = vi.fn(async () => {
      throw new Error('403');
    });
    render(<CockpitGraphStage turns={[namesBoth]} connections={connections as never} />);
    await waitFor(() =>
      expect(screen.getByTestId('cockpit-graph').textContent).toMatch(/unread relations/),
    );
    expect(screen.getByTestId('cockpit-graph').textContent).not.toMatch(/related to nothing else/);
  });

  it('an edge between two named entities is drawn', async () => {
    const connections = vi.fn(async () => edgeAB);
    render(<CockpitGraphStage turns={[namesBoth]} connections={connections} />);
    await screen.findByText('the task');
    await screen.findByText('the doc');
  });
});

describe('CockpitGraphStage — the cap is reported, per kind', () => {
  it('says how many it did not draw rather than shrinking the picture', () => {
    const many = turn(
      Array.from({ length: 140 }, (_, n) => call('tm8_read', { id: id(200 + n) })).flat(),
    );
    render(<CockpitGraphStage turns={[many]} />);
    expect(screen.getByTestId('cgs-overflow')).toBeTruthy();
  });
});

describe('CockpitGraphStage — the empty state is not an error', () => {
  it('a conversation that named nothing says what would appear here', () => {
    render(<CockpitGraphStage turns={[turn(call('tm8_read', { note: 'nothing' }))]} />);
    expect(screen.getByText(/has not named any entities yet/)).toBeTruthy();
  });
});

describe('CockpitGraphStage — it shares the fleet’s per-id read', () => {
  it('reads each named entity at most once', async () => {
    const detail = (entityId: string): EntityDetail =>
      ({ id: entityId, kind: 'doc', title: `doc ${entityId.slice(-1)}`, state: {}, badges: {}, counters: {} }) as unknown as EntityDetail;
    const readEntity = vi.fn(async (entityId: EntityId) => detail(entityId));
    const { rerender } = render(<CockpitGraphStage turns={[namesBoth]} readEntity={readEntity} />);
    await waitFor(() => expect(readEntity.mock.calls.length).toBe(2));
    rerender(<CockpitGraphStage turns={[namesBoth]} readEntity={readEntity} />);
    expect(readEntity.mock.calls.length).toBe(2);
  });
});
