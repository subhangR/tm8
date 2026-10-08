// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Seam } from '../data/seam';
import { fixtureSummaries, FIXTURE_SPACE_ID } from '../fixtures';
import { EntityListPanel } from '../panels/EntityListPanel';
import { EntitySeenProvider, useEntityListSelection } from './EntitySeen';

const doc = fixtureSummaries.find((s) => s.kind === 'doc')!;
afterEach(cleanup);

function Activation({ open }: { open: (id: string) => void }) {
  const select = useEntityListSelection(open);
  return <>
    <button onClick={() => select?.(doc.id)}>List row</button>
    <button onClick={() => open(doc.id)}>Detail link</button>
  </>;
}

function mount(markSeen = vi.fn(async () => undefined)) {
  const open = vi.fn();
  const refresh = vi.fn();
  const commands = { markSeen } as unknown as Seam['commands'];
  const view = render(<EntitySeenProvider commands={commands} refreshCounts={refresh}>
    <Activation open={open} />
  </EntitySeenProvider>);
  return { ...view, commands, open, refresh, markSeen };
}

describe('entity-list seen markers', () => {
  it('does not mark on mount, detail navigation, or tab restoration; persists only activation', async () => {
    const h = mount();
    expect(h.markSeen).not.toHaveBeenCalled();
    fireEvent.click(h.getByText('Detail link'));
    expect(h.markSeen).not.toHaveBeenCalled();
    fireEvent.click(h.getByText('List row'));
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    expect(h.markSeen).toHaveBeenCalledWith(doc.id);
    fireEvent.click(h.getByText('List row'));
    await act(async () => undefined);
    expect(h.markSeen).toHaveBeenCalledTimes(1);
    expect(h.open).toHaveBeenCalledTimes(3);
  });

  it('does not lose navigation or decrement counts on failure; retries the next click', async () => {
    const h = mount(vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined));
    fireEvent.click(h.getByText('List row'));
    await act(async () => undefined);
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.refresh).not.toHaveBeenCalled();
    fireEvent.click(h.getByText('List row'));
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    expect(h.markSeen).toHaveBeenCalledTimes(2);
  });

  it('deduplicates pending clicks and does not refresh a previous member/space after switching', async () => {
    let finish!: () => void;
    const mark = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const h = mount(mark);
    fireEvent.click(h.getByText('List row'));
    fireEvent.click(h.getByText('List row'));
    await act(async () => undefined);
    expect(mark).toHaveBeenCalledTimes(1);
    h.unmount();
    await act(async () => finish());
    expect(h.refresh).not.toHaveBeenCalled();
    const next = mount();
    fireEvent.click(next.getByText('List row'));
    await waitFor(() => expect(next.markSeen).toHaveBeenCalledTimes(1));
  });

  it('preserves an unsent draft while resetting seen markers for a new member or space', async () => {
    const markSeen = vi.fn(async () => undefined);
    const commands = { markSeen } as unknown as Seam['commands'];
    const refresh = vi.fn();
    const open = vi.fn();
    const shell = (scopeKey: string) => <EntitySeenProvider commands={commands} refreshCounts={refresh} scopeKey={scopeKey}>
      <input aria-label="Draft" defaultValue="" />
      <Activation open={open} />
    </EntitySeenProvider>;
    const view = render(shell('space:'));
    const draft = view.getByRole('textbox', { name: 'Draft' });
    fireEvent.change(draft, { target: { value: 'Unsent notes' } });
    fireEvent.click(view.getByText('List row'));
    await waitFor(() => expect(markSeen).toHaveBeenCalledTimes(1));

    for (const [index, scope] of ['space:member', 'other-space:member'].entries()) {
      view.rerender(shell(scope));
      expect(view.getByRole('textbox', { name: 'Draft' })).toBe(draft);
      expect((draft as HTMLInputElement).value).toBe('Unsent notes');
      fireEvent.click(view.getByText('List row'));
      await waitFor(() => expect(markSeen).toHaveBeenCalledTimes(index + 2));
    }
  });

  it('ignores a previous scope’s pending completion and allows the new scope to mark the same entity', async () => {
    const finishes: Array<() => void> = [];
    const markSeen = vi.fn(() => new Promise<void>((resolve) => { finishes.push(resolve); }));
    const commands = { markSeen } as unknown as Seam['commands'];
    const refresh = vi.fn();
    const open = vi.fn();
    const shell = (scopeKey: string) => <EntitySeenProvider commands={commands} refreshCounts={refresh} scopeKey={scopeKey}>
      <Activation open={open} />
    </EntitySeenProvider>;
    const view = render(shell('space:first-member'));
    fireEvent.click(view.getByText('List row'));
    await act(async () => undefined);
    view.rerender(shell('space:second-member'));
    fireEvent.click(view.getByText('List row'));
    await act(async () => undefined);
    expect(markSeen).toHaveBeenCalledTimes(2);
    await act(async () => finishes[0]!());
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => finishes[1]!());
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('wires the actual shared list panel, without marking rows while rendering', async () => {
    const markSeen = vi.fn(async () => undefined);
    const open = vi.fn();
    const view = render(<EntitySeenProvider commands={{ markSeen } as unknown as Seam['commands']} refreshCounts={vi.fn()}>
      <EntityListPanel kind="doc" mode="list" rowsFor={() => [doc]} ctx={{ spaceId: FIXTURE_SPACE_ID }} onSelect={open} />
    </EntitySeenProvider>);
    expect(markSeen).not.toHaveBeenCalled();
    fireEvent.click(view.getByText(doc.title));
    await waitFor(() => expect(markSeen).toHaveBeenCalledWith(doc.id));
    expect(open).toHaveBeenCalledWith(doc.id);
  });
});
