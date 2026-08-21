// @vitest-environment jsdom
/**
 * THE LEDGER PANEL — the sticky projection's own honesty rules (S4):
 * scope-general collapsed row, the liveness law on the pill (never `0 live`
 * before the verdicts settle), scope switching as a filter, one persistent
 * expand toggle, and handler gating (D1 — a host that wires no opener gets
 * nothing, which is exactly what the phone shell wires).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import type { EntityDetail, EntityId } from '@tm8/contract';
import { resetFleetEntityCache } from './fleet/use-fleet-entities';
import { LedgerPanel } from './LedgerPanel';
import type { ChatTurn, ChatTurnPart } from './types';

const id = (n: number): string => `01a00000-00aa-7000-8000-${String(n).padStart(12, '0')}`;
const TASK = id(1);
const CHILD = id(2);
const SESSION = id(3);

let seq = 0;
const call = (args: unknown, result: unknown, name = 'mcp__tm8__tm8_act'): ChatTurnPart[] => {
  const toolCallId = `tc-${(seq += 1)}`;
  return [
    { kind: 'tool_call', seq: (seq += 1), toolCallId, name, args, state: 'completed' },
    { kind: 'tool_result', seq: (seq += 1), toolCallId, content: result },
  ];
};
const turn = (parts: ChatTurnPart[]): ChatTurn => ({
  messageId: `msg-${(seq += 1)}` as EntityId,
  role: 'assistant',
  author: null,
  createdAt: '2026-08-21T12:00:00.000Z',
  body: '',
  parts,
});

const createTask = (taskId: string, title: string, parentId: string | null = null) =>
  call(
    { operation: 'entities.create', body: { kind: 'task', title, parentId } },
    { entity: { id: taskId, kind: 'task', title } },
  );

const spawnSession = (sessionId: string, title: string) =>
  call(
    { operation: 'execution.spawn', body: {} },
    { entity: { id: sessionId, kind: 'work_session', title } },
    'mcp__tm8__tm8_delegate',
  );

const THREAD = () => [turn([...createTask(TASK, 'Task 1'), ...createTask(CHILD, 'Task 1.1', TASK), ...spawnSession(SESSION, 'Worker')])];

function sessionDetail(status: string): EntityDetail {
  return {
    id: SESSION,
    kind: 'work_session',
    title: 'Worker',
    state: { kind: 'work_session', status },
    badges: {},
  } as unknown as EntityDetail;
}

describe('handler gating (D1)', () => {
  it('renders NOTHING without an opener — the phone shell wires none, so phones stay clear', () => {
    const view = render(<LedgerPanel turns={THREAD()} />);
    expect(view.queryByTestId('ledger-panel')).toBeNull();
  });

  it('renders nothing when the thread built nothing — zero-state honesty', () => {
    const view = render(<LedgerPanel turns={[turn([])]} onOpenEntity={vi.fn()} />);
    expect(view.queryByTestId('ledger-panel')).toBeNull();
  });
});

describe('the collapsed row is scope-general (ruling 9)', () => {
  it('defaults to the sessions scope, collapsed, saying `N sessions` before liveness settles', () => {
    resetFleetEntityCache();
    /* No readEntity and no livenessOf: nothing can settle, so the pill must
       say what is known — a count of sessions — and NEVER `0 live`. */
    const view = render(<LedgerPanel turns={THREAD()} onOpenEntity={vi.fn()} />);
    expect(view.getByTestId('ledger-panel-scope').textContent).toContain('sessions');
    expect(view.getByTestId('ledger-panel-summary').textContent).toBe('1 session');
    expect(view.getByTestId('ledger-panel-summary').textContent).not.toContain('live');
    expect(view.queryByTestId('ledger-panel-body')).toBeNull();
  });

  it('says `N live` only once every session read settled under a real verdict channel', async () => {
    resetFleetEntityCache();
    const readEntity = vi.fn().mockResolvedValue(sessionDetail('running'));
    /* idle is a LEGAL LIVE STATE and a running record with no live process is
       stale — the panel must not care which: it renders the seam's verdict. */
    const livenessOf = vi.fn().mockReturnValue('live');
    const view = render(
      <LedgerPanel turns={THREAD()} onOpenEntity={vi.fn()} readEntity={readEntity} livenessOf={livenessOf} />,
    );
    await waitFor(() =>
      expect(view.getByTestId('ledger-panel-summary').textContent).toBe('1 live'),
    );
  });

  it('scoped to an entity, the summary is that scope’s kind counts', async () => {
    resetFleetEntityCache();
    const view = render(<LedgerPanel turns={THREAD()} onOpenEntity={vi.fn()} />);
    fireEvent.click(view.getByTestId('ledger-panel-scope'));
    const option = await view.findByTestId('ledger-scope-entity');
    expect(option.textContent).toContain('Task 1');
    fireEvent.click(option);
    expect(view.getByTestId('ledger-panel-scope').textContent).toContain('Task 1');
    expect(view.getByTestId('ledger-panel-summary').textContent).toBe('1 task');
  });
});

describe('scope switching is a filter, not a refetch (ruling 6)', () => {
  it('changes what the body shows without any read being issued', async () => {
    resetFleetEntityCache();
    const readEntity = vi.fn().mockResolvedValue(sessionDetail('running'));
    const view = render(
      <LedgerPanel turns={THREAD()} onOpenEntity={vi.fn()} readEntity={readEntity} />,
    );
    await waitFor(() => expect(readEntity).toHaveBeenCalled());
    const readsBefore = readEntity.mock.calls.length;
    fireEvent.click(view.getByTestId('ledger-panel-scope'));
    fireEvent.click(await view.findByTestId('ledger-scope-entity'));
    // Choosing a scope expands the body onto the tree — from the same fold.
    const body = view.getByTestId('ledger-panel-body');
    expect(within(body).getByTestId('ledger-tree')).toBeTruthy();
    expect(readEntity.mock.calls.length).toBe(readsBefore);
  });
});

describe('the expand toggle is ONE persistent control (audit a6)', () => {
  it('flips aria-expanded in place and stays the focused element', () => {
    resetFleetEntityCache();
    const view = render(<LedgerPanel turns={THREAD()} onOpenEntity={vi.fn()} />);
    const toggle = view.getByTestId('ledger-panel-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBeTruthy();
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(view.getByTestId('ledger-panel-body')).toBeTruthy();
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByTestId('ledger-panel-body')).toBeNull();
  });
});

describe('sessions are view-only rows that open via the ONE generic opener (rulings 8, D3)', () => {
  it('a session row click fires onOpenEntity — routing to the terminal is the host’s job', async () => {
    resetFleetEntityCache();
    const onOpenEntity = vi.fn();
    const readEntity = vi.fn().mockResolvedValue(sessionDetail('running'));
    const view = render(
      <LedgerPanel turns={THREAD()} onOpenEntity={onOpenEntity} readEntity={readEntity} />,
    );
    fireEvent.click(view.getByTestId('ledger-panel-toggle'));
    const row = await view.findByTestId('ledger-panel-session');
    fireEvent.click(row);
    expect(onOpenEntity).toHaveBeenCalledWith(SESSION);
  });
});

describe('no tool name ever reaches the surface (R8)', () => {
  it('renders neither tool names nor operations anywhere', () => {
    resetFleetEntityCache();
    const view = render(<LedgerPanel turns={THREAD()} onOpenEntity={vi.fn()} />);
    fireEvent.click(view.getByTestId('ledger-panel-toggle'));
    expect(view.container.textContent).not.toMatch(/tm8_act|entities\.create|execution\.spawn/);
  });
});
