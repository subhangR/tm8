// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { AttentionProvider } from './attention-store';
import { AttentionTopSegment } from './AttentionTopSegment';
import { AttentionUndoToast } from './AttentionUndoToast';
import { EntityAttentionControl } from './EntityAttentionControl';
import { fakeSeam, ME, req, SPACE, summary } from './fake-attention-seam.test-support';
import { EntityDetailPanel } from '../panels/EntityDetailPanel';
import { fixtureDetails, sessionStale, docLayoutSpec } from '../fixtures';

afterEach(cleanup);
const session = sessionStale.id;
const panelProps = {
  ctx: { spaceId: SPACE },
  reasons: { presenceHollow: 'No viewers', versionHistory: 'Unavailable', provenanceHollow: 'Unavailable', shareUnavailable: 'Unavailable', withdrawUnavailable: 'Unavailable' },
};

function mount(failResolve = false) {
  const fake = fakeSeam([
    req({ id: 'local', entityId: session, sourceWorkSessionId: session, reason: 'Local request' }),
    req({ id: 'rolled', entityId: 'form-a', rootId: 'task-a' as EntityId, sourceWorkSessionId: session, reason: 'Rolled up to A' }),
    req({ id: 'raised', entityId: 'task-b', sourceWorkSessionId: session, reason: 'Raised on B' }),
    req({ id: 'sibling', entityId: 'child-a', rootId: 'task-a' as EntityId, status: 'acknowledged', reason: 'Legacy sibling on A' }),
    req({ id: 'unrelated', entityId: 'unrelated', reason: 'Unrelated request' }),
  ], { v2: true });
  fake.resolveAttention.mockImplementation(async id => {
    if (failResolve) throw new Error('node unreachable');
    for (const row of fake.table.rows) if ((row.rootId ?? row.entityId) === id) row.status = 'resolved';
    return { request: null, entity: summary(id, null), affectedCount: 1 };
  });
  function Panel() {
    const [slot, setSlot] = useState<HTMLDivElement | null>(null);
    return <div className="cv2-root">
      <AttentionTopSegment onOpenEntity={() => {}} />
      <EntityDetailPanel {...panelProps} detail={fixtureDetails[session]!} liveness="live"
        embeddedChrome={{ kindSlot: slot, verbsSlot: null, commonVerbsSlot: null, statsSlot: null, menuSlot: null, dangerSlot: null }} />
      <div role="toolbar" aria-label="Entity actions" ref={setSlot} />
      <AttentionUndoToast />
    </div>;
  }
  render(<AttentionProvider seam={fake.seam} spaceId={SPACE} viewerId={ME} delayMs={0}><Panel /></AttentionProvider>);
  return fake;
}

it('lists local, rolled-up, raised-elsewhere and legacy requests only through the right strip, resolving their actual roots', async () => {
  const fake = mount();
  const trigger = await screen.findByRole('button', { name: 'Attention: 4 pending requests' });
  expect(within(screen.getByRole('toolbar', { name: 'Entity actions' })).getByTestId('entity-attention-control')).toBe(trigger);
  expect(screen.queryByTestId('attention-block')).toBeNull();
  expect(document.querySelector('.att-block-dock')).toBeNull();
  expect(screen.queryByTestId('session-waiting-banner')).toBeNull();
  expect(screen.getByTestId('terminal-body').firstElementChild).toBe(screen.getByTestId('terminal-stage'));
  expect(fake.table.rows.every(row => row.status !== 'resolved')).toBe(true);
  fireEvent.click(trigger);
  const pop = screen.getByRole('dialog', { name: 'Session attention' });
  expect(within(pop).getAllByTestId('attention-block-row')).toHaveLength(4);
  expect(within(pop).queryByText('Unrelated request')).toBeNull();
  expect(pop.querySelector('[data-attention-root="task-a"]')?.textContent).toContain('Title task-a');
  expect(pop.querySelector('[data-attention-root="task-a"]')?.textContent).toContain('2 requests waiting');
  for (const root of ['task-a', 'task-b', session]) {
    const group = pop.querySelector(`[data-attention-root="${root}"]`)! as HTMLElement;
    fireEvent.change(within(group).getByTestId('attention-block-note'), { target: { value: `Handled ${root}` } });
    await act(async () => { fireEvent.click(within(group).getByTestId('attention-block-resolve')); });
    expect(fake.resolveAttention).toHaveBeenLastCalledWith(root, expect.objectContaining({ resolutionNote: `Handled ${root}` }));
  }
  await waitFor(() => expect(screen.queryByTestId('entity-attention-control')).toBeNull());
  expect(fake.table.rows.filter(row => row.status === 'resolved')).toHaveLength(4);
  expect(fake.table.rows.find(row => row.id === 'unrelated')?.status).toBe('open');
  expect(screen.getByTestId('attention-top-all-count').textContent).toBe('1');
});

it('retains failed requests and restores keyboard focus when closing the strip popover', async () => {
  mount(true);
  const trigger = await screen.findByRole('button', { name: 'Attention: 4 pending requests' });
  fireEvent.click(trigger);
  const pop = screen.getByTestId('entity-attention-popover');
  await act(async () => { fireEvent.click(within(pop).getAllByTestId('attention-block-resolve')[0]!); });
  expect(await screen.findByRole('button', { name: 'Attention: 4 pending requests' })).toBeTruthy();
  expect(screen.getByTestId('entity-attention-popover').textContent).toContain('Local request');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByTestId('entity-attention-popover')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});


it('keeps a nonterminal detail attention block in its existing dock', async () => {
  const detail = fixtureDetails[docLayoutSpec.id]!;
  const fake = fakeSeam([req({ entityId: detail.id, reason: 'Document attention unchanged' })]);
  render(<AttentionProvider seam={fake.seam} spaceId={SPACE} delayMs={0}>
    <EntityDetailPanel {...panelProps} detail={detail} />
  </AttentionProvider>);
  const block = await screen.findByTestId('attention-block');
  expect(block.closest('.att-block-dock')).not.toBeNull();
  expect(block.textContent).toContain('Document attention unchanged');
  expect(screen.queryByTestId('entity-attention-control')).toBeNull();
});

it('discovers requests pinned on the session when they count on a different root, regardless of who raised them', async () => {
  const fake = fakeSeam([
    req({ entityId: session, rootId: 'task-a' as EntityId, sourceWorkSessionId: 'other-session' as EntityId, reason: 'Pinned here, counted on A' }),
  ]);
  render(<AttentionProvider seam={fake.seam} spaceId={SPACE} delayMs={0}>
    <EntityAttentionControl entityId={session} />
  </AttentionProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Attention: 1 pending request' }));
  expect(screen.getAllByTestId('attention-block-row')).toHaveLength(1);
  expect(screen.getByTestId('attention-block').closest('[data-attention-root]')?.getAttribute('data-attention-root')).toBe('task-a');
  expect(screen.getByText('Pinned here, counted on A')).toBeTruthy();
});
