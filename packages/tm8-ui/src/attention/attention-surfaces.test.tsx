// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { AttentionProvider, useAttention } from './attention-store';
import type { AttentionApi } from './attention-store';
import { AttentionTopSegment } from './AttentionTopSegment';
import { AttentionUndoToast } from './AttentionUndoToast';
import { AttentionChipView, EntityAttentionChip, chipText } from './AttentionChipView';
import { chipFromRows } from './attention-selectors';
import { ME, SPACE, badge, fakeSeam, nextId, req, summary } from './fake-attention-seam.test-support';

afterEach(cleanup);

function mount(fake: ReturnType<typeof fakeSeam>, onOpen = vi.fn()) {
  const ref: { api: AttentionApi | null } = { api: null };
  function Probe() {
    ref.api = useAttention();
    return null;
  }
  render(
    <AttentionProvider seam={fake.seam} spaceId={SPACE} viewerId={ME} delayMs={0} newId={nextId}>
      <Probe />
      <AttentionTopSegment onOpenEntity={onOpen} />
      <div data-testid="tile-task-1"><EntityAttentionChip entity={summary('task-1', badge(2))} /></div>
      <div data-testid="tile-doc-1"><EntityAttentionChip entity={summary('doc-1', badge(1, 10))} /></div>
      <div data-testid="tile-sess-1"><EntityAttentionChip entity={summary('sess-1', null)} /></div>
      <AttentionUndoToast />
    </AttentionProvider>,
  );
  return ref;
}

/** `Personal/Team` as the two top-bar sections show them. */
function topCounts(): string {
  return `${screen.getByTestId('attention-top-mine-count').textContent}/${screen.getByTestId('attention-top-all-count').textContent}`;
}

const NOW = Date.parse('2026-09-26T13:00:00.000Z');

describe('the chip (chapter 4)', () => {
  it('reads <icon> <points> · ×n · age, coloured by level', () => {
    const chip = chipFromRows([
      req({ entityId: 't', level: 'high', points: 70, createdAt: '2026-09-26T10:00:00.000Z' }),
      req({ entityId: 't', level: 'normal', points: 40, createdAt: '2026-09-26T12:00:00.000Z' }),
    ])!;
    expect(chipText(chip, NOW)).toBe('110 · ×2 · 3h');
    render(<AttentionChipView chip={chip} now={NOW} />);
    const el = screen.getByTestId('attention-chip');
    expect(el.className).toContain('att-chip--wait');
    expect(el.textContent).toBe('!110 · ×2 · 3h');
  });

  it('is grey i for FYI and red for urgent; one request shows no ×', () => {
    const fyi = chipFromRows([req({ entityId: 't', level: 'fyi', points: 10, createdAt: '2026-09-26T12:00:00.000Z' })])!;
    const urgent = chipFromRows([req({ entityId: 't', level: 'urgent', points: 95 })])!;
    expect(fyi).toMatchObject({ icon: 'i', tone: 'fyi' });
    expect(chipText(fyi, NOW)).toBe('10 · 1h');
    expect(urgent).toMatchObject({ icon: '!', tone: 'block' });
  });

  it('renders nothing without a provider', () => {
    render(<EntityAttentionChip entity={summary('task-1', badge(1))} />);
    expect(screen.queryByTestId('attention-chip')).toBeNull();
  });
});

describe('the top bar (chapter 4, mock tab 2)', () => {
  const rows = () => [
    req({ id: 'r1', entityId: 'task-1', level: 'high', points: 70, assigneeId: ME as never, reason: 'Pick retry policy' }),
    req({ id: 'r2', entityId: 'sess-1', rootId: 'task-1' as EntityId, sourceWorkSessionId: 'sess-1' as EntityId, reason: 'Merge conflict' }),
    req({ id: 'r3', entityId: 'doc-1', level: 'fyi', points: 10, reason: 'Have a look' }),
  ];

  it('shows Personal and Team over roll-up roots; each section opens its own filter', async () => {
    const fake = fakeSeam(rows());
    mount(fake);
    await waitFor(() => expect(topCounts()).toBe('1/2'));
    fireEvent.click(screen.getByTestId('attention-top-mine'));
    const pop = screen.getByTestId('attention-top-popover');
    expect(within(pop).getByTestId('attention-filter-mine').getAttribute('aria-pressed')).toBe('true');
    expect(within(pop).getAllByTestId('attention-list-row').map((r) => r.dataset.root)).toEqual(['task-1']);
    fireEvent.click(within(pop).getByTestId('attention-filter-all'));
    expect(within(pop).getAllByTestId('attention-list-row').map((r) => r.dataset.root)).toEqual(['task-1', 'doc-1']);
    expect(screen.getByTestId('attention-top-mine').className).toContain('att-top__btn--glow');
    expect(screen.getByTestId('attention-top-mine').className).toContain('att-top__btn--wait');
    fireEvent.click(screen.getByTestId('attention-top-all'));
    const team = screen.getByTestId('attention-top-popover');
    expect(within(team).getByTestId('attention-filter-all').getAttribute('aria-pressed')).toBe('true');
    expect(within(team).getByTestId('attention-filter-mine').textContent).toBe('Personal · 1');
    expect(within(team).getByTestId('attention-filter-all').textContent).toBe('Team · 2');
  });

  it('Resolve from the popover settles live everywhere: row, chip, count; Undo brings it back', async () => {
    const fake = fakeSeam(rows());
    mount(fake);
    await waitFor(() => expect(topCounts()).toBe('1/2'));
    expect(within(screen.getByTestId('tile-task-1')).queryByTestId('attention-chip')).not.toBeNull();
    // The session that raised the rolled-up request carries the F1 marker.
    expect(within(screen.getByTestId('tile-sess-1')).queryByTestId('attention-chip')).not.toBeNull();

    fireEvent.click(screen.getByTestId('attention-top-mine'));
    const pop = screen.getByTestId('attention-top-popover');
    fireEvent.click(within(pop).getByTestId('attention-resolve'));
    fireEvent.change(within(pop).getByTestId('attention-resolve-note'), { target: { value: 'exponential' } });
    await act(async () => { fireEvent.click(within(pop).getByTestId('attention-resolve-confirm')); });

    expect(topCounts()).toBe('0/1');
    expect(within(screen.getByTestId('tile-task-1')).queryByTestId('attention-chip')).toBeNull();
    expect(within(screen.getByTestId('tile-sess-1')).queryByTestId('attention-chip')).toBeNull();
    expect(fake.resolveAttention).toHaveBeenLastCalledWith('task-1', expect.objectContaining({ resolutionNote: 'exponential' }));

    await act(async () => { fireEvent.click(screen.getByTestId('attention-toast-undo')); });
    await waitFor(() => expect(topCounts()).toBe('1/2'));
  });

  it('Seen dims the row and never changes the count', async () => {
    const fake = fakeSeam(rows());
    mount(fake);
    await waitFor(() => expect(topCounts()).toBe('1/2'));
    fireEvent.click(screen.getByTestId('attention-top-mine'));
    const pop = screen.getByTestId('attention-top-popover');
    await act(async () => { fireEvent.click(within(pop).getByTestId('attention-seen')); });
    const row = within(pop).getByTestId('attention-list-row');
    expect(row.className).toContain('att-list__row--seen');
    expect(topCounts()).toBe('1/2');
  });

  it('Open goes to the session that raised the request, and closes the popover', async () => {
    const fake = fakeSeam(rows());
    const onOpen = vi.fn();
    mount(fake, onOpen);
    await waitFor(() => expect(topCounts()).toBe('1/2'));
    fireEvent.click(screen.getByTestId('attention-top-mine'));
    fireEvent.click(within(screen.getByTestId('attention-top-popover')).getByTestId('attention-open'));
    // r1 was raised by no session: it opens where it is pinned.
    expect(onOpen).toHaveBeenLastCalledWith('task-1');
    expect(screen.queryByTestId('attention-top-popover')).toBeNull();
  });

  it('a session-raised request opens that session; a form signal opens the form', async () => {
    const fake = fakeSeam([
      req({ id: 'a1', entityId: 'task-2', sourceWorkSessionId: 'sess-9' as EntityId, assigneeId: ME as never, reason: 'Pick one' }),
      req({ id: 'f1', entityId: 'form-1', rootId: 'task-3' as EntityId, origin: 'system', sourceWorkSessionId: 'sess-8' as EntityId, reason: 'Answer the form' }),
    ]);
    const onOpen = vi.fn();
    mount(fake, onOpen);
    await waitFor(() => expect(topCounts()).toBe('1/2'));
    fireEvent.click(screen.getByTestId('attention-top-all'));
    const pop = screen.getByTestId('attention-top-popover');
    const rowOf = (root: string) => within(pop).getAllByTestId('attention-list-row').find((r) => r.dataset.root === root)!;
    fireEvent.click(within(rowOf('task-2')).getByTestId('attention-open'));
    expect(onOpen).toHaveBeenLastCalledWith('sess-9');
    fireEvent.click(screen.getByTestId('attention-top-all'));
    fireEvent.click(within(within(screen.getByTestId('attention-top-popover')).getAllByTestId('attention-list-row').find((r) => r.dataset.root === 'task-3')!).getByTestId('attention-open'));
    expect(onOpen).toHaveBeenLastCalledWith('form-1');
  });

  it('clicking a row\'s title opens it like Open does: the raising session, or the form', async () => {
    // Task 01a112b9: only the small Open button routed; a click on the item's
    // name did nothing, which read as "attention does not open when clicked".
    const fake = fakeSeam([
      req({ id: 'a1', entityId: 'task-2', sourceWorkSessionId: 'sess-9' as EntityId, assigneeId: ME as never, reason: 'Pick one' }),
      req({ id: 'f1', entityId: 'form-1', rootId: 'task-3' as EntityId, origin: 'system', sourceWorkSessionId: 'sess-8' as EntityId, reason: 'Answer the form' }),
    ]);
    const onOpen = vi.fn();
    mount(fake, onOpen);
    await waitFor(() => expect(topCounts()).toBe('1/2'));
    const titleOf = (root: string) => {
      fireEvent.click(screen.getByTestId('attention-top-all'));
      const pop = screen.getByTestId('attention-top-popover');
      const row = within(pop).getAllByTestId('attention-list-row').find((r) => r.dataset.root === root)!;
      return within(row).getByTestId('attention-open-title');
    };
    const title = titleOf('task-2');
    expect(title.tagName).toBe('BUTTON');
    fireEvent.click(title);
    expect(onOpen).toHaveBeenLastCalledWith('sess-9');
    expect(screen.queryByTestId('attention-top-popover')).toBeNull();
    fireEvent.click(titleOf('task-3'));
    expect(onOpen).toHaveBeenLastCalledWith('form-1');
  });

  it('shows Personal 0 and Team 0, not glowing, when the queue is empty', async () => {
    const fake = fakeSeam([]);
    mount(fake);
    await waitFor(() => expect(topCounts()).toBe('0/0'));
    expect(screen.getByTestId('attention-top-mine').className).not.toContain('att-top__btn--glow');
    expect(screen.getByTestId('attention-top-all').className).not.toContain('att-top__btn--glow');
  });

  it('a failed read says so; it is never the all-clear', async () => {
    const fake = fakeSeam([]);
    fake.attentionRequests.mockRejectedValue(new Error('forbidden'));
    mount(fake);
    await waitFor(() => expect(screen.getByTestId('attention-top-segment').textContent).toContain('attention unavailable'));
    expect(screen.queryByTestId('attention-top-mine-count')).toBeNull();
    fireEvent.click(screen.getByTestId('attention-top-failed'));
    expect(screen.getByTestId('attention-list-error')).toBeTruthy();
    expect(screen.queryByTestId('attention-list-empty')).toBeNull();
  });
});
