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

  it('shows mine · all over roll-up roots, and the popover defaults to Mine', async () => {
    const fake = fakeSeam(rows());
    mount(fake);
    await waitFor(() => expect(screen.getByTestId('attention-top-counts').textContent).toBe('1 mine · 2 all'));
    fireEvent.click(screen.getByTestId('attention-top-segment'));
    const pop = screen.getByTestId('attention-top-popover');
    expect(within(pop).getByTestId('attention-filter-mine').getAttribute('aria-pressed')).toBe('true');
    expect(within(pop).getAllByTestId('attention-list-row').map((r) => r.dataset.root)).toEqual(['task-1']);
    fireEvent.click(within(pop).getByTestId('attention-filter-all'));
    expect(within(pop).getAllByTestId('attention-list-row').map((r) => r.dataset.root)).toEqual(['task-1', 'doc-1']);
  });

  it('Resolve from the popover settles live everywhere: row, chip, count; Undo brings it back', async () => {
    const fake = fakeSeam(rows());
    mount(fake);
    await waitFor(() => expect(screen.getByTestId('attention-top-counts').textContent).toBe('1 mine · 2 all'));
    expect(within(screen.getByTestId('tile-task-1')).queryByTestId('attention-chip')).not.toBeNull();
    // The session that raised the rolled-up request carries the F1 marker.
    expect(within(screen.getByTestId('tile-sess-1')).queryByTestId('attention-chip')).not.toBeNull();

    fireEvent.click(screen.getByTestId('attention-top-segment'));
    const pop = screen.getByTestId('attention-top-popover');
    fireEvent.click(within(pop).getByTestId('attention-resolve'));
    fireEvent.change(within(pop).getByTestId('attention-resolve-note'), { target: { value: 'exponential' } });
    await act(async () => { fireEvent.click(within(pop).getByTestId('attention-resolve-confirm')); });

    expect(screen.getByTestId('attention-top-counts').textContent).toBe('0 mine · 1 all');
    expect(within(screen.getByTestId('tile-task-1')).queryByTestId('attention-chip')).toBeNull();
    expect(within(screen.getByTestId('tile-sess-1')).queryByTestId('attention-chip')).toBeNull();
    expect(fake.resolveAttention).toHaveBeenLastCalledWith('task-1', expect.objectContaining({ resolutionNote: 'exponential' }));

    await act(async () => { fireEvent.click(screen.getByTestId('attention-toast-undo')); });
    await waitFor(() => expect(screen.getByTestId('attention-top-counts').textContent).toBe('1 mine · 2 all'));
  });

  it('Seen dims the row and never changes the count', async () => {
    const fake = fakeSeam(rows());
    mount(fake);
    await waitFor(() => expect(screen.getByTestId('attention-top-counts')).toBeTruthy());
    fireEvent.click(screen.getByTestId('attention-top-segment'));
    const pop = screen.getByTestId('attention-top-popover');
    await act(async () => { fireEvent.click(within(pop).getByTestId('attention-seen')); });
    const row = within(pop).getByTestId('attention-list-row');
    expect(row.className).toContain('att-list__row--seen');
    expect(screen.getByTestId('attention-top-counts').textContent).toBe('1 mine · 2 all');
  });

  it('Open navigates and closes the popover', async () => {
    const fake = fakeSeam(rows());
    const onOpen = vi.fn();
    mount(fake, onOpen);
    await waitFor(() => expect(screen.getByTestId('attention-top-counts')).toBeTruthy());
    fireEvent.click(screen.getByTestId('attention-top-segment'));
    fireEvent.click(within(screen.getByTestId('attention-top-popover')).getByTestId('attention-open'));
    expect(onOpen).toHaveBeenCalledWith('task-1');
    expect(screen.queryByTestId('attention-top-popover')).toBeNull();
  });

  it('says nothing needs you when the queue is empty', async () => {
    const fake = fakeSeam([]);
    mount(fake);
    await waitFor(() => expect(screen.getByTestId('attention-top-segment').textContent).toContain('nothing needs you'));
  });
});
