// @vitest-environment jsdom
/**
 * THE ENTITY TRAY — created-first ordering, honest overflow, and honest
 * absence (no entities ⇒ no row, no Graph door without a handler).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { EntityTray, TRAY_VISIBLE_LIMIT } from './EntityTray';
import type { ChatTurn, ChatTurnPart } from './types';

const id = (n: number): string => `01900000-00dd-7000-8000-${String(n).padStart(12, '0')}`;

let seq = 0;
const call = (name: string, args: unknown, result?: unknown): ChatTurnPart[] => {
  const toolCallId = `tc-${(seq += 1)}`;
  const parts: ChatTurnPart[] = [
    { kind: 'tool_call', seq: (seq += 1), toolCallId, name, args, state: 'completed' },
  ];
  if (result !== undefined) {
    parts.push({ kind: 'tool_result', seq: (seq += 1), toolCallId, content: result });
  }
  return parts;
};

const turn = (parts: ChatTurnPart[]): ChatTurn => ({
  messageId: `msg-${(seq += 1)}` as EntityId,
  role: 'assistant',
  author: null,
  createdAt: '2026-08-18T10:00:00.000Z',
  body: '',
  parts,
});

describe('EntityTray', () => {
  it('renders nothing for a thread with no entities', () => {
    const view = render(<EntityTray turns={[turn([])]} />);
    expect(view.queryByTestId('chat-entity-tray')).toBeNull();
  });

  it('write-touched entities lead; a read-only reference follows', () => {
    const READ = id(1);
    const WRITTEN = id(2);
    const view = render(
      <EntityTray
        turns={[turn([
          ...call('tm8_read_entity', { id: READ }, { id: READ, kind: 'doc', title: 'Read me' }),
          ...call('tm8_create_entity', { id: WRITTEN }, { id: WRITTEN, kind: 'task', title: 'Made me' }),
        ])]}
      />,
    );
    const chips = view.getAllByTestId('chat-entity-chip');
    expect(chips.map((c) => c.getAttribute('title'))).toEqual([WRITTEN, READ]);
  });

  it('caps the row and counts the rest; +N expands in place', () => {
    const many = turn(
      Array.from({ length: TRAY_VISIBLE_LIMIT + 3 }, (_, i) =>
        call('tm8_read_entity', { id: id(10 + i) }, { id: id(10 + i), kind: 'task', title: `T${i}` }),
      ).flat(),
    );
    const view = render(<EntityTray turns={[many]} />);
    expect(view.getAllByTestId('chat-entity-chip')).toHaveLength(TRAY_VISIBLE_LIMIT);
    fireEvent.click(view.getByText('+3 more'));
    expect(view.getAllByTestId('chat-entity-chip')).toHaveLength(TRAY_VISIBLE_LIMIT + 3);
  });

  it('the Chat tab is the way back: first, active with the stage empty, pulsing when the thread works off-stage', () => {
    const HAS = id(7);
    const turns = [turn(call('tm8_read_entity', { id: HAS }, { id: HAS, kind: 'task', title: 'X' }))];
    const onShowChat = vi.fn();
    // Stage empty: chat tab active, no pulse.
    const idle = render(<EntityTray turns={turns} onShowChat={onShowChat} />);
    const chatTab = idle.getByText('Chat').closest('button')!;
    expect(chatTab.hasAttribute('data-active')).toBe(true);
    expect(idle.container.querySelector('.tch-tray__pulse')).toBeNull();
    idle.unmount();
    // Stage occupied + thread busy: entity tab active, chat tab pulses, click returns.
    const busy = render(
      <EntityTray turns={turns} onShowChat={onShowChat} activeEntityId={HAS} chatBusy />,
    );
    const busyChat = busy.getByText('Chat').closest('button')!;
    expect(busyChat.hasAttribute('data-active')).toBe(false);
    expect(busy.container.querySelector('.tch-tray__pulse')).not.toBeNull();
    expect(busy.container.querySelector('.tch-tray__tab[data-active]')).not.toBeNull();
    fireEvent.click(busyChat);
    expect(onShowChat).toHaveBeenCalledTimes(1);
  });

  it('with the stage occupied and no seeds, the tray still offers the way back', () => {
    const view = render(<EntityTray turns={[turn([])]} onShowChat={vi.fn()} activeEntityId={id(9)} />);
    expect(view.getByText('Chat')).toBeTruthy();
  });

  it('the Graph door renders only with a handler, and fires it', () => {
    const HAS = id(1);
    const turns = [turn(call('tm8_read_entity', { id: HAS }, { id: HAS, kind: 'task', title: 'X' }))];
    const without = render(<EntityTray turns={turns} />);
    expect(without.queryByText('Graph')).toBeNull();
    const onOpenGraph = vi.fn();
    const view = render(<EntityTray turns={turns} onOpenGraph={onOpenGraph} />);
    fireEvent.click(view.getByText('Graph'));
    expect(onOpenGraph).toHaveBeenCalledTimes(1);
  });
});
