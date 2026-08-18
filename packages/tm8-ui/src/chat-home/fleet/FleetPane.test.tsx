// @vitest-environment jsdom
/**
 * THE FLEET PANE'S HONESTY RULES.
 *
 * Every test here pins a way the pane could lie about the fleet rather than a
 * way it could look wrong: a live dot with no verdict behind it, a row that
 * vanished because a read failed, a count that shrank silently at the cap.
 * Those are the failures that make an orchestration view worse than no view,
 * because a fleet you cannot trust is one you have to re-check by hand.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EntityDetail, EntityId } from '@tm8/contract';
import { FleetPane } from './FleetPane';
import type { ChatTurn, ChatTurnPart } from '../types';

const id = (n: number): string => `01a01400-00cc-7000-8000-${String(n).padStart(12, '0')}`;
const SESSION = id(1);
const TASK = id(2);
const DOC = id(3);

let seq = 0;
const call = (name: string, args: unknown, result?: unknown): ChatTurnPart[] => {
  const toolCallId = `tc-${(seq += 1)}`;
  const parts: ChatTurnPart[] = [
    { kind: 'tool_call', seq: (seq += 1), toolCallId, name, args, state: 'completed' },
  ];
  if (result !== undefined) {
    parts.push({ kind: 'tool_result', seq: (seq += 1), toolCallId, content: result });
  }
  return parts;
};

const turn = (parts: ChatTurnPart[]): ChatTurn => ({
  messageId: `msg-${(seq += 1)}` as EntityId,
  role: 'assistant',
  author: null,
  createdAt: '2026-08-18T12:00:00.000Z',
  body: '',
  parts,
});

const spawnTurn = turn(
  call(
    'mcp__tm8__tm8_delegate',
    { operation: 'execution.spawn', body: { spaceId: 's', taskIds: [TASK] } },
    { id: SESSION },
  ),
);

/** Only the fields the pane actually reads; cast once, here, rather than in
 *  every test. */
const detail = (over: Record<string, unknown>): EntityDetail =>
  ({
    id: SESSION,
    kind: 'work_session',
    title: 'a worker',
    state: {},
    badges: {},
    counters: {},
    ...over,
  }) as unknown as EntityDetail;

const readerFor = (byId: Record<string, EntityDetail>) =>
  vi.fn(async (entityId: EntityId) => {
    const found = byId[entityId];
    if (!found) throw new Error('not found');
    return found;
  });

describe('FleetPane — liveness is the seam’s verdict and nothing else', () => {
  it('a RUNNING record with no live verdict does not read as live', async () => {
    const read = readerFor({
      [SESSION]: detail({ id: SESSION, title: 'lane one', state: { kind: 'work_session', status: 'running' } }),
    });
    render(
      <FleetPane
        turns={[spawnTurn]}
        readEntity={read}
        // The node restarted: the record still says running, the seam says stale.
        livenessOf={() => 'stale'}
      />,
    );
    await screen.findByText('lane one');
    expect(screen.getByTestId('cockpit-fleet').textContent).not.toMatch(/\d+ live/);
  });

  it('a live verdict, and only a live verdict, is counted live', async () => {
    const read = readerFor({
      [SESSION]: detail({ id: SESSION, title: 'lane one', state: { kind: 'work_session', status: 'running' } }),
    });
    render(<FleetPane turns={[spawnTurn]} readEntity={read} livenessOf={() => 'live'} />);
    await screen.findByText('lane one');
    expect(screen.getByTestId('cockpit-fleet').textContent).toMatch(/1 live/);
  });

  it('no host verdict at all is neutral, never live', async () => {
    const read = readerFor({
      [SESSION]: detail({ id: SESSION, title: 'lane one', state: { kind: 'work_session', status: 'running' } }),
    });
    render(<FleetPane turns={[spawnTurn]} readEntity={read} />);
    await screen.findByText('lane one');
    expect(screen.getByTestId('cockpit-fleet').textContent).not.toMatch(/live/);
  });
});

describe('FleetPane — a fleet never shrinks quietly', () => {
  it('an unreadable ref stays on screen as an honest row', async () => {
    const read = readerFor({}); // every read rejects
    render(<FleetPane turns={[spawnTurn]} readEntity={read} />);
    await waitFor(() => expect(screen.getAllByTestId('fleet-row').length).toBeGreaterThan(0));
    const rows = screen.getAllByTestId('fleet-row');
    expect(rows.some((row) => row.dataset.read === 'failed')).toBe(true);
    expect(within(rows[0] as HTMLElement).queryByText('unreadable')).not.toBeNull();
  });

  it('with no reader at all the refs are still listed, as ids', () => {
    render(<FleetPane turns={[spawnTurn]} />);
    // The session and the task the spawn was handed — both present, unresolved.
    expect(screen.getAllByTestId('fleet-row').length).toBeGreaterThanOrEqual(2);
  });

  it('the draw cap is reported, not swallowed', () => {
    const many = turn(
      Array.from({ length: 70 }, (_, n) => call('tm8_read', { id: id(100 + n) })).flat(),
    );
    render(<FleetPane turns={[many]} />);
    expect(screen.getByTestId('fleet-overflow')).toBeTruthy();
  });
});

describe('FleetPane — sections follow the read, not the payload’s hint', () => {
  it('sessions and tasks separate once their reads settle', async () => {
    const read = readerFor({
      [SESSION]: detail({ id: SESSION, title: 'lane one', state: { kind: 'work_session', status: 'idle' } }),
      [TASK]: detail({ id: TASK, kind: 'task', title: 'ship the pane', state: { kind: 'task', workStatus: 'in_progress' } }),
    });
    render(<FleetPane turns={[spawnTurn]} readEntity={read} />);
    await screen.findByText('lane one');
    await screen.findByText('ship the pane');
    expect(screen.getByText('Sessions')).toBeTruthy();
    expect(screen.getByText('Tasks')).toBeTruthy();
  });

  it('one read per id, ever — a re-render does not re-read', async () => {
    const read = readerFor({
      [SESSION]: detail({ id: SESSION, title: 'lane one', state: { kind: 'work_session', status: 'idle' } }),
    });
    const { rerender } = render(<FleetPane turns={[spawnTurn]} readEntity={read} />);
    await screen.findByText('lane one');
    const after = read.mock.calls.length;
    rerender(<FleetPane turns={[spawnTurn]} readEntity={read} />);
    expect(read.mock.calls.length).toBe(after);
  });
});

describe('FleetPane — the Transcript link', () => {
  it('is offered for a session when the host can open one', async () => {
    const read = readerFor({
      [SESSION]: detail({ id: SESSION, title: 'lane one', state: { kind: 'work_session', status: 'running' } }),
    });
    const onOpenTranscript = vi.fn();
    render(<FleetPane turns={[spawnTurn]} readEntity={read} onOpenTranscript={onOpenTranscript} />);
    const link = await screen.findByRole('button', { name: 'Transcript' });
    link.click();
    expect(onOpenTranscript).toHaveBeenCalledWith(SESSION);
  });

  it('is absent — not dead — when the host has nowhere to send the viewer', async () => {
    const read = readerFor({
      [SESSION]: detail({ id: SESSION, title: 'lane one', state: { kind: 'work_session', status: 'running' } }),
    });
    render(<FleetPane turns={[spawnTurn]} readEntity={read} />);
    await screen.findByText('lane one');
    expect(screen.queryByRole('button', { name: 'Transcript' })).toBeNull();
  });
});

describe('FleetPane — the empty state says what the pane is for', () => {
  it('a thread that delegated nothing says so, and does not look broken', () => {
    render(<FleetPane turns={[turn(call('tm8_read', { note: 'no ids here' }))]} />);
    expect(screen.getByText(/has not delegated anything yet/)).toBeTruthy();
    expect(screen.queryAllByTestId('fleet-row')).toHaveLength(0);
  });

  it('a doc the thread merely read is listed, but not as a session', async () => {
    const read = readerFor({
      [DOC]: detail({ id: DOC, kind: 'doc', title: 'a note', state: { kind: 'doc' } }),
    });
    render(<FleetPane turns={[turn(call('tm8_read', { id: DOC }))]} readEntity={read} />);
    await screen.findByText('a note');
    expect(screen.getByText('Also referenced')).toBeTruthy();
    expect(screen.queryByText('Sessions')).toBeNull();
  });
});
