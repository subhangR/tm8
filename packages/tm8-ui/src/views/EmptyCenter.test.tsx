// @vitest-environment jsdom
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
});
