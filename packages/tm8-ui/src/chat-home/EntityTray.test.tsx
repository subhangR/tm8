// @vitest-environment jsdom
/**
 * THE ENTITY TRAY, post-ledger-panel (S4) — a tabs strip: the Chat tab that
 * is the way back, and the Graph stage tab. The chips left for the ledger
 * panel; the FLEET TAB IS ABSORBED by the panel's scope picker (ruling 11)
 * and must never come back — a sessions-scoped panel IS the fleet, and a tab
 * that opens the same list twice is redundant. The honesty rule survives its
 * third host: absent handlers ⇒ nothing renders, never a dead control.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { EntityTray } from './EntityTray';

describe('EntityTray', () => {
  it('renders nothing when no handler is wired — never a dead control', () => {
    const view = render(<EntityTray />);
    expect(view.queryByTestId('chat-entity-tray')).toBeNull();
  });

  it('the Chat tab is the way back: active with the stage empty, pulsing when the thread works off-stage', () => {
    const onShowChat = vi.fn();
    // Stage empty: chat tab active, no pulse.
    const idle = render(<EntityTray onShowChat={onShowChat} />);
    const chatTab = idle.getByText('Chat').closest('button')!;
    expect(chatTab.hasAttribute('data-active')).toBe(true);
    expect(idle.container.querySelector('.tch-tray__pulse')).toBeNull();
    idle.unmount();
    // Stage occupied + thread busy: chat tab inactive, pulses, click returns.
    const busy = render(
      <EntityTray onShowChat={onShowChat} activeEntityId="01900000-00dd-7000-8000-000000000007" chatBusy />,
    );
    const busyChat = busy.getByText('Chat').closest('button')!;
    expect(busyChat.hasAttribute('data-active')).toBe(false);
    expect(busy.container.querySelector('.tch-tray__pulse')).not.toBeNull();
    fireEvent.click(busyChat);
    expect(onShowChat).toHaveBeenCalledTimes(1);
  });

  it('the Graph tab renders only with a handler and swaps its stage', () => {
    const without = render(<EntityTray onShowChat={vi.fn()} />);
    expect(without.queryByText('Graph')).toBeNull();

    const onStage = vi.fn();
    const view = render(<EntityTray onStage={onStage} />);
    fireEvent.click(view.getByText('Graph'));
    expect(onStage).toHaveBeenLastCalledWith('graph');
  });

  it('there is NO Fleet tab — absorbed by the ledger panel scope picker (ruling 11)', () => {
    const view = render(<EntityTray onStage={vi.fn()} onShowChat={vi.fn()} />);
    expect(view.queryByText('Fleet')).toBeNull();
  });

  it('clicking the ACTIVE stage leaves it — a tab is a toggle, not a trap', () => {
    /* The stage occupies the transcript's berth, so a viewer who clicks Graph
       while already on Graph means "put the conversation back". */
    const onStage = vi.fn();
    const view = render(<EntityTray onStage={onStage} activeStage="graph" />);
    fireEvent.click(view.getByText('Graph'));
    expect(onStage).toHaveBeenCalledWith(null);
  });

  it('a stage occupying the berth keeps the Chat tab as the way back', () => {
    const view = render(
      <EntityTray onShowChat={vi.fn()} onStage={vi.fn()} activeStage="graph" />,
    );
    expect(view.getByText('Chat')).toBeTruthy();
  });
});
