// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ExitedFallback } from './SessionFallback';

/**
 * SPEC D1 §9 scenario 3: a completed session's process crashes. The panel
 * still says Completed, adds ONE grey line about the process, and asks for
 * nothing — no attention, no Resume-to-recover.
 */
describe('Completed panel after the process crashes (scenario 3)', () => {
  const state = {
    kind: 'work_session',
    status: 'failed',
    outcome: 'completed',
    outcomeAt: new Date(Date.now() - 60_000).toISOString(),
    receiptMessageId: 'm-receipt',
    endedKind: 'crashed',
    endedReason: 'The agent process crashed.',
  };

  it('stays Completed with a single grey crash line', () => {
    const { getByTestId, getAllByTestId } = render(
      <ExitedFallback outcome="failed" sessionState={state} exitedAt={new Date().toISOString()} />,
    );
    expect(getByTestId('session-exited-fallback').getAttribute('data-outcome')).toBe('completed');
    expect(getByTestId('session-ended-title').textContent).toBe('Completed');
    const line = getAllByTestId('session-crash-after-completion');
    expect(line).toHaveLength(1);
    expect(line[0]!.className).toBe('term-fallback__meta');
    expect(line[0]!.textContent).toMatch(/after the work completed — nothing to do\.$/);
  });

  it('a completed session whose process closed cleanly has no crash line', () => {
    const { queryByTestId } = render(
      <ExitedFallback sessionState={{ ...state, status: 'exited', endedKind: 'exited_clean' }} />,
    );
    expect(queryByTestId('session-crash-after-completion')).toBeNull();
  });
});
