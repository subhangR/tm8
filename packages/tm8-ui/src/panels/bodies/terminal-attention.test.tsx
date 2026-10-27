// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AttentionProvider, useAttention } from '../../attention/attention-store';
import { fakeSeam, ME, req, SPACE } from '../../attention/fake-attention-seam.test-support';
import { fixtureDetails, sessionStale } from '../../fixtures';
import { TerminalBody } from './TerminalBody';

afterEach(cleanup);

it('keeps pending attention out of the terminal layout without settling its records', async () => {
  const fake = fakeSeam([
    req({ id: 'own', entityId: sessionStale.id, sourceWorkSessionId: sessionStale.id, reason: 'Choose an option' }),
    req({ id: 'elsewhere', entityId: 'task-1', sourceWorkSessionId: sessionStale.id, reason: 'Review the task' }),
  ]);
  function PendingCount() {
    return <output data-testid="pending-count">{useAttention().queue('all').length}</output>;
  }
  render(
    <AttentionProvider seam={fake.seam} spaceId={SPACE} viewerId={ME} delayMs={0}>
      <PendingCount />
      <TerminalBody detail={fixtureDetails[sessionStale.id]!} liveness="live" />
    </AttentionProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('pending-count').textContent).toBe('2'));
  expect(screen.queryByTestId('session-waiting-banner')).toBeNull();
  expect(screen.getByTestId('terminal-body').firstElementChild).toBe(screen.getByTestId('terminal-stage'));
  expect(screen.getByTestId('terminal-host-placeholder')).toBeTruthy();
  expect(fake.resolveAttention).not.toHaveBeenCalled();
  expect(fake.table.rows.map(r => r.status)).toEqual(['open', 'open']);
});
