// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AttentionRequest, EntityId } from '@tm8/contract';
import { AttentionProvider } from './attention-store';
import { AttentionList, shortHandle } from './AttentionList';
import { AttentionTopSegment } from './AttentionTopSegment';
import { AttentionHeaderButton } from './AttentionSheet';
import { EntityAttentionControl } from './EntityAttentionControl';
import { AttentionUndoToast } from './AttentionUndoToast';
import { badge, fakeSeam, ME, req, SPACE } from './fake-attention-seam.test-support';

afterEach(cleanup);

function mount(rows: AttentionRequest[], configure?: (fake: ReturnType<typeof fakeSeam>) => void) {
  const fake = fakeSeam(rows);
  configure?.(fake);
  const onOpen = vi.fn();
  const view = render(<AttentionProvider seam={fake.seam} spaceId={SPACE} viewerId={ME} delayMs={0}>
    <AttentionList filter="all" onOpen={onOpen} />
    <AttentionTopSegment onOpenEntity={onOpen} />
    <AttentionHeaderButton expanded={false} onOpen={() => {}} />
    <EntityAttentionControl entityId="session-fyi" />
    <AttentionUndoToast />
  </AttentionProvider>);
  return { fake, onOpen, view };
}

it('explains seen urgent priority and opens the same older request that supplies the reason, action and requester', async () => {
  const urgent = req({ id: 'urgent', entityId: 'task-urgent', level: 'urgent', seenByMe: true, points: 95,
    sourceWorkSessionId: 'session-older' as EntityId, actionType: 'approve', reason: 'Approve recovery',
    requestedBy: { id: 'operator' as EntityId, kind: 'member', displayName: 'Recovery operator', avatar: null, isAgent: true },
    createdAt: '2026-09-25T09:00:00.000Z' });
  const { onOpen } = mount([
    req({ entityId: 'task-normal', level: 'normal', points: 500, reason: 'Normal unseen action' }),
    urgent,
    req({ entityId: 'task-urgent', level: 'normal', sourceWorkSessionId: 'session-newer' as EntityId,
      actionType: 'review', reason: 'Newer less important reason' }),
  ]);
  await waitFor(() => expect(screen.getAllByTestId('attention-list-row')).toHaveLength(2));
  const [first] = screen.getAllByTestId('attention-list-row');
  expect(first!.dataset.root).toBe('task-urgent');
  expect(within(first!).getByTestId('attention-row-priority').textContent).toBe('Urgent priority · 2 actionable · 0 FYI');
  expect(first!.querySelector('.att-list__reason')!.textContent).toBe('Approve recovery');
  expect(within(first!).getByTestId('attention-chip').getAttribute('aria-label')).toContain('Approve recovery');
  expect(first!.querySelector('.att-list__type')!.textContent).toBe('approve');
  expect(first!.querySelector('.att-list__facts')!.textContent).toContain(`via session ${shortHandle('session-older')} · Recovery operator`);
  expect(screen.getByTestId('attention-priority-explanation').textContent).toContain('Urgent, high, then normal');
  fireEvent.click(within(first!).getByTestId('attention-open-title'));
  expect(onOpen).toHaveBeenCalledWith('session-older', expect.objectContaining({ primary: expect.objectContaining({ id: 'urgent' }) }));
});

it('finds urgent actions after a FYI-only first page and counts the full pending inventory', async () => {
  const fyi = req({ entityId: 'fyi-only', level: 'fyi', reason: 'Build information' });
  const urgent = req({ entityId: 'urgent-later-page', level: 'urgent', reason: 'Restore deployment' });
  const { fake } = mount([], fake => {
    fake.attentionRequests.mockImplementation(async input => {
      if (input.status !== 'open') return { items: [], nextCursor: null };
      return input.cursor
        ? { items: [urgent], nextCursor: null }
        : { items: [fyi], nextCursor: 'next-page' as never };
    });
  });
  const row = await screen.findByTestId('attention-list-row');
  expect(row.dataset.root).toBe('urgent-later-page');
  expect(screen.getByTestId('attention-top-all-count').textContent).toBe('1');
  expect(screen.getByTestId('attention-scope-fyi').textContent).toBe('FYI · 1');
  expect(fake.attentionRequests).toHaveBeenCalledWith(expect.objectContaining({ status: 'open', cursor: 'next-page', limit: 100 }));
});

it('does not present a partially read queue as complete when a later page fails', async () => {
  const { fake } = mount([], fake => {
    fake.attentionRequests.mockImplementation(async input => {
      if (input.status !== 'open') return { items: [], nextCursor: null };
      if (input.cursor) throw new Error('Later page unavailable');
      return { items: [req({ entityId: 'first-page' })], nextCursor: 'next-page' as never };
    });
  });
  expect(await screen.findByTestId('attention-list-error')).toBeTruthy();
  expect(screen.queryByTestId('attention-list-row')).toBeNull();
  expect(screen.queryByTestId('attention-list-empty')).toBeNull();
  expect(screen.queryByTestId('attention-top-all-count')).toBeNull();
  expect(fake.attentionRequests.mock.calls.some(([input]) => input.cursor === 'next-page')).toBe(true);
});

it('fails visibly when pagination repeats a cursor instead of hanging or reporting an all-clear', async () => {
  const { fake } = mount([], fake => {
    fake.attentionRequests.mockImplementation(async input => input.status === 'open'
      ? { items: [], nextCursor: 'repeat' as never }
      : { items: [], nextCursor: null });
  });
  expect(await screen.findByTestId('attention-list-error')).toBeTruthy();
  expect(screen.queryByTestId('attention-list-empty')).toBeNull();
  expect(fake.attentionRequests.mock.calls.filter(([input]) => input.status === 'open')).toHaveLength(2);
});

it('stops following pages when the queue is unmounted before a response returns', async () => {
  let release!: (page: { items: AttentionRequest[]; nextCursor: null }) => void;
  const pending = new Promise<{ items: AttentionRequest[]; nextCursor: null }>(resolve => { release = resolve; });
  const { fake, view } = mount([], fake => {
    fake.attentionRequests.mockImplementation(async input => input.status === 'open' ? pending : { items: [], nextCursor: null });
  });
  view.unmount();
  await act(async () => {
    release({ items: [req({ entityId: 'old-space-request' })], nextCursor: 'old-page' as never });
    await pending;
  });
  expect(fake.attentionRequests.mock.calls.some(([input]) => input.cursor != null)).toBe(false);
});

it('refreshes the headline and rank when urgency and reason change without changing the pending count', async () => {
  const { fake } = mount([
    req({ entityId: 'changed', level: 'normal', reason: 'Routine review' }),
    req({ entityId: 'other', level: 'high', reason: 'Existing high priority' }),
  ]);
  await waitFor(() => expect(screen.getAllByTestId('attention-list-row')[0]!.dataset.root).toBe('other'));
  fake.table.rows[0]!.level = 'urgent';
  fake.table.rows[0]!.reason = 'Escalated recovery';
  fake.upsert('changed', { ...badge(1), maxLevel: 'urgent' } as never);
  await waitFor(() => {
    const [first] = screen.getAllByTestId('attention-list-row');
    expect(first!.dataset.root).toBe('changed');
    expect(first!.querySelector('.att-list__reason')!.textContent).toBe('Escalated recovery');
    expect(within(first!).getByTestId('attention-row-priority').textContent).toContain('Urgent priority');
  });
});

it('marks retained counts stale after a failed refresh and allows a visible retry without hiding the last loaded work', async () => {
  const { fake } = mount([req({ entityId: 'task', reason: 'Last loaded request' })]);
  await screen.findByTestId('attention-list-row');
  fake.attentionRequests.mockRejectedValueOnce(new Error('Refresh unavailable'));
  fake.upsert('task', badge(1));
  const stale = await screen.findByTestId('attention-list-stale');
  expect(stale.textContent).toContain('Showing the last loaded work items');
  expect(screen.getByTestId('attention-list-row').textContent).toContain('Last loaded request');
  expect(screen.getByTestId('attention-top-all-count').textContent).toBe('1?');
  expect(screen.getByTestId('attention-phone-button').getAttribute('aria-label')).toContain('refresh failed');

  fireEvent.click(within(stale).getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByTestId('attention-list-stale')).toBeNull());
  expect(screen.getByTestId('attention-top-all-count').textContent).toBe('1');
  expect(screen.getByTestId('attention-list-row').textContent).toContain('Last loaded request');
});

it('uses the primary system form as both source and Open target even when its recorded session differs', async () => {
  const { onOpen } = mount([
    req({ id: 'form', entityId: 'form-1234', rootId: 'task' as EntityId, level: 'urgent', origin: 'system',
      sourceWorkSessionId: 'session-9876' as EntityId, reason: 'Answer the deployment form', actionType: 'review',
      createdAt: '2026-09-25T09:00:00.000Z' }),
    req({ entityId: 'task', sourceWorkSessionId: 'session-newest' as EntityId, reason: 'Other question' }),
  ]);
  const row = await screen.findByTestId('attention-list-row');
  expect(row.querySelector('.att-list__facts')!.textContent).toContain(`via ${shortHandle('form-1234')}`);
  expect(row.querySelector('.att-list__facts')!.textContent).not.toContain(shortHandle('session-9876'));
  fireEvent.click(within(row).getByTestId('attention-open'));
  expect(onOpen).toHaveBeenCalledWith('form-1234', expect.objectContaining({ primary: expect.objectContaining({ id: 'form' }) }));
});

it('keeps pure FYI out of action counts while preserving the explicit FYI view, phone affordance and session inventory', async () => {
  const { onOpen } = mount([
    req({ entityId: 'task-fyi', level: 'fyi', assigneeId: ME as EntityId,
      sourceWorkSessionId: 'session-fyi' as EntityId, reason: 'Build finished' }),
  ]);
  await waitFor(() => expect(screen.getByTestId('attention-top-all-count').textContent).toBe('0'));
  expect(screen.getByTestId('attention-top-mine-count').textContent).toBe('0');
  expect(screen.getByTestId('attention-top-mine').className).not.toContain('att-top__btn--glow');
  expect(screen.queryByTestId('attention-list-row')).toBeNull();
  expect(screen.getByTestId('attention-list-empty').textContent).toContain('Informational requests are available in FYI');
  expect(screen.getByTestId('attention-scope-fyi').textContent).toBe('FYI · 1');
  expect(screen.getByTestId('attention-phone-button').getAttribute('aria-label')).toBe('FYI: 1 informational work item');
  expect(screen.getByTestId('attention-phone-button').className).toContain('att-phone-btn--muted');
  expect(await screen.findByRole('button', { name: 'Attention: 1 pending request' })).toBeTruthy();
  fireEvent.click(screen.getByTestId('attention-scope-fyi'));
  const row = screen.getByTestId('attention-list-row');
  expect(row.querySelector('.att-list__reason')!.textContent).toBe('Build finished');
  fireEvent.click(within(row).getByTestId('attention-open'));
  expect(onOpen).toHaveBeenCalledWith('session-fyi', expect.objectContaining({ primary: expect.objectContaining({ reason: 'Build finished' }) }));
});

it('states and resolves the complete root scope, including FYI, and Undo restores both views', async () => {
  const { fake } = mount([
    req({ entityId: 'task', assigneeId: ME as EntityId, level: 'high', reason: 'Approve release' }),
    req({ entityId: 'task', level: 'fyi', reason: 'Build report' }),
  ]);
  const row = await screen.findByTestId('attention-list-row');
  expect(within(row).getByTestId('attention-row-priority').textContent).toBe('High priority · 1 actionable · 1 FYI');
  fireEvent.click(within(row).getByTestId('attention-resolve'));
  expect(within(row).getByTestId('attention-resolve-scope').textContent).toContain('Resolves all 2 pending requests');
  await act(async () => { fireEvent.click(within(row).getByTestId('attention-resolve-confirm')); });
  expect(fake.table.rows.map(r => r.status)).toEqual(['resolved', 'resolved']);
  expect(screen.queryByTestId('attention-list-row')).toBeNull();
  await act(async () => { fireEvent.click(screen.getByTestId('attention-toast-undo')); });
  await waitFor(() => expect(screen.getByTestId('attention-top-all-count').textContent).toBe('1'));
  fireEvent.click(screen.getByTestId('attention-scope-fyi'));
  expect(screen.getByTestId('attention-list-row').querySelector('.att-list__reason')!.textContent).toBe('Build report');
});
