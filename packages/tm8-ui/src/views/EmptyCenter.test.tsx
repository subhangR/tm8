// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { SessionLiveness } from '../data/seam';
import type { SessionRow } from '../terminal';
import { EmptyCenter } from './EmptyCenter';

function row(id: string, recordedStatus: SessionRow['recordedStatus']): SessionRow {
  return { id, name: id, provider: 'codex', recordedStatus };
}

describe('EmptyCenter', () => {
  it('shows only bounded important terminal groups and leaves history in Sessions', () => {
    const rows = [
      row('stale-1', 'running'),
      row('failed-1', 'failed'),
      row('failed-hidden', 'failed'),
      row('live-1', 'running'),
      row('live-2', 'running'),
      row('live-3', 'running'),
      row('live-hidden', 'running'),
      row('starting-1', 'spawning'),
      row('starting-hidden', 'spawning'),
      row('completed-1', 'exited'),
      row('completed-2', 'exited'),
      row('completed-hidden', 'exited'),
      row('idle-history', 'idle'),
    ];
    const live = new Set(['live-1', 'live-2', 'live-3', 'live-hidden']);
    const verdicts: Record<string, SessionLiveness> = {
      'stale-1': 'stale',
    };
    const onFocusSession = vi.fn();
    const view = render(
      <EmptyCenter
        rows={rows}
        liveIds={[...live]}
        livenessOf={(id) => verdicts[id] ?? (live.has(id) ? 'live' : 'not-running')}
        onFocusSession={onFocusSession}
      />,
    );

    const attention = view.getByTestId('empty-session-group-attention');
    const running = view.getByTestId('empty-session-group-running');
    const starting = view.getByTestId('empty-session-group-starting');
    const completed = view.getByTestId('empty-session-group-completed');

    expect(attention.querySelectorAll('.shell-empty__row')).toHaveLength(2);
    expect(running.querySelectorAll('.shell-empty__row')).toHaveLength(3);
    expect(starting.querySelectorAll('.shell-empty__row')).toHaveLength(1);
    expect(completed.querySelectorAll('.shell-empty__row')).toHaveLength(2);
    expect(within(running).getByText('+1 more in Sessions')).toBeTruthy();
    expect(within(starting).getByText('+1 more in Sessions')).toBeTruthy();
    expect(within(completed).getByText('+1 more in Sessions')).toBeTruthy();
    expect(view.queryByText('idle-history')).toBeNull();
    expect(view.queryByText('live-hidden')).toBeNull();

    fireEvent.click(within(running).getByRole('button', { name: 'live-1, running, codex' }));
    expect(onFocusSession).toHaveBeenCalledWith('live-1');
  });

  it('states the useful empty case when only idle history exists', () => {
    const view = render(
      <EmptyCenter
        rows={[row('idle-history', 'idle')]}
        liveIds={[]}
        livenessOf={() => 'not-running'}
      />,
    );

    expect(view.getByText('No active or recent terminals.')).toBeTruthy();
    expect(view.queryByText('idle-history')).toBeNull();
  });

  it('first run: names what a session is and offers a live ＋ New task', () => {
    const create = vi.fn();
    const onStartTerminal = vi.fn();
    const view = render(
      <EmptyCenter
        rows={[]}
        liveIds={[]}
        livenessOf={() => 'not-running'}
        newTask={{ unavailable: null, create }}
        onStartTerminal={onStartTerminal}
      />,
    );

    // The concept sentence — the surface says what the thing IS.
    expect(view.getByText(/A session is a teammate working in a terminal/)).toBeTruthy();
    // The one next action is a REAL, clickable control (not refused).
    fireEvent.click(view.getByRole('button', { name: '＋ New task' }));
    expect(create).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole('button', { name: 'Start a terminal ▸' }));
    expect(onStartTerminal).toHaveBeenCalledTimes(1);
  });

  it('first run: refuses create WITH A REASON rather than a dead button', () => {
    const view = render(
      <EmptyCenter
        rows={[]}
        liveIds={[]}
        livenessOf={() => 'not-running'}
        newTask={{ unavailable: { cause: 'no executor', remedy: 'wire one' }, create: vi.fn() }}
      />,
    );
    // Refused controls are focusable and carry their reason — never a live
    // button that silently does nothing.
    expect(view.queryByRole('button', { name: '＋ New task' })).toBeNull();
    expect(view.getByTestId('empty-center-firstrun')).toBeTruthy();
  });

  it('first run: draws NO Start-a-terminal button when the host cannot start one', () => {
    // The component contract the host relies on: an absent `onStartTerminal`
    // means "this host cannot start a terminal", and the secondary must then
    // not render at all — the alternative is a live button with nothing behind
    // it. `useSessionStart.startTerminal` THROWS when the seam has no commands,
    // so a host that passes it unconditionally would draw exactly that button.
    const view = render(
      <EmptyCenter
        rows={[]}
        liveIds={[]}
        livenessOf={() => 'not-running'}
        newTask={{ unavailable: null, create: vi.fn() }}
      />,
    );
    expect(view.queryByRole('button', { name: 'Start a terminal ▸' })).toBeNull();
    // The primary is still live — absence of the secondary is not a dead surface.
    expect(view.getByRole('button', { name: '＋ New task' })).toBeTruthy();
  });
});

/**
 * THE WIRING GUARD — same shape and reason as `panel-primaries-wired.test.tsx`.
 *
 * The defect this pins is silent: `onStartTerminal={sessionStart.startTerminal}`
 * renders a button that LOOKS right and throws on click, because `startTerminal`
 * throws when the seam has no commands. It refuses honestly only if the host
 * gates it on `onAction`, which `useSessionStart` leaves undefined for EXACTLY
 * the set where `startTerminal` would throw. A component test cannot see this —
 * the wiring is only visible in the source of the one host that mounts the
 * surface, so this reads that source.
 */
describe('the empty centre is wired honestly at its mount site', () => {
  const workspaceViewSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'WorkspaceView.tsx'), 'utf8');

  it('every EmptyCenter mount gates onStartTerminal on the seam signal, never the raw handle', () => {
    const wirings = [...workspaceViewSrc.matchAll(/onStartTerminal=\{([^}]*)\}/g)];
    // A scan that matches nothing proves nothing — there is one mount today.
    expect(wirings.length).toBeGreaterThan(0);
    for (const [, expression] of wirings) {
      // `onAction` is the only availability signal `useSessionStart` exposes and
      // it is undefined precisely when a terminal cannot be started; the value
      // must consult it, so a revert to the bare `sessionStart.startTerminal`
      // fails here rather than in production on the first click.
      expect(expression, `onStartTerminal wired without gating on onAction: ${expression}`).toContain('onAction');
    }
  });
});
