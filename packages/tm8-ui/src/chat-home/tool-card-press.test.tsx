// @vitest-environment jsdom
/**
 * WHAT A PRESS ON A TOOL CALL DOES — the two inert controls this file closes.
 *
 * A tool call in the transcript shows the most chip-shaped thing in the whole
 * chat: the mark, the tool name, the state. It was a `<header>`. Pressing it did
 * nothing, and nothing about it said so — the question that started this ("what
 * happens when that chip is pressed?") had the answer "nothing", which is not an
 * answer a control is allowed to have.
 *
 * The second inert control is subtler and worse, because it was introduced BY a
 * host rather than by the component: `EntityChip` renders an inert badge when it
 * has no `onOpen` and a real button when it does, so a host that cannot navigate
 * is supposed to pass nothing. `MobileShell` passed `() => undefined`. The prop
 * existed, the honest badge switched itself off, and every chip on a phone became
 * a live-looking button that swallowed the press. These cases pin both shapes:
 * a press that acts, and — where there is nothing to act on — no press at all.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { TurnParts } from './TurnParts';
import type { ChatTurnPart } from './types';

const TASK_ID = '019f0000-0000-7000-8000-000000000021';

function toolParts(result: unknown, args: unknown = { id: TASK_ID }): ChatTurnPart[] {
  return [
    { seq: 0, kind: 'tool_call', toolCallId: 't1', name: 'tm8_read', args, state: 'completed' },
    { seq: 1, kind: 'tool_result', toolCallId: 't1', content: result },
  ];
}

const detailsOf = (card: HTMLElement) => [...card.querySelectorAll('details')];

describe('the tool chip is the card’s disclosure', () => {
  it('opens both payloads on press and closes them on the next press', () => {
    const view = render(<TurnParts parts={toolParts({ ok: true })} />);
    const card = view.getByTestId('chat-tool-card');
    const chip = within(card).getByRole('button', { expanded: false });

    // Closed is the resting state: a transcript of open payload dumps is not a
    // transcript. The press is what asks for the detail.
    expect(detailsOf(card).map((d) => d.open)).toEqual([false, false]);

    fireEvent.click(chip);
    expect(detailsOf(card).map((d) => d.open)).toEqual([true, true]);
    expect(chip.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(chip);
    expect(detailsOf(card).map((d) => d.open)).toEqual([false, false]);
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });

  it('leaves each payload independently collapsible', async () => {
    /* The chip is a MASTER toggle, not a replacement for the two disclosures.
       Opening Input from its own summary must not drag Result open with it —
       the failure a single shared boolean would have shipped.

       The `waitFor` is load-bearing, not politeness: a native `toggle` is
       dispatched in a later task, and the state it feeds is what keeps a
       controlled `<details>` from being SHUT AGAIN by the next render. That
       round trip is the whole reason `onToggle` is wired, so it is asserted
       after it has had the chance to happen. */
    const view = render(<TurnParts parts={toolParts({ ok: true })} />);
    const card = view.getByTestId('chat-tool-card');
    const [input, result] = detailsOf(card);
    fireEvent.click(within(input as HTMLElement).getByText('Input'));

    await waitFor(() =>
      expect(within(card).getByRole('button').getAttribute('aria-expanded')).toBe('true'),
    );
    expect(input?.open).toBe(true);
    expect(result?.open).toBe(false);
  });

  it('still presses open when the call has no result yet', () => {
    const running: ChatTurnPart[] = [
      { seq: 0, kind: 'tool_call', toolCallId: 't1', name: 'tm8_read', args: {}, state: 'running' },
    ];
    const view = render(<TurnParts parts={running} />);
    const card = view.getByTestId('chat-tool-card');
    fireEvent.click(within(card).getByRole('button'));
    expect(detailsOf(card).map((d) => d.open)).toEqual([true]);
  });
});

describe('an entity chip is a button only where the press can land', () => {
  it('is a real button when the host can open entities', () => {
    const onOpenEntity = vi.fn();
    const view = render(
      <TurnParts
        parts={toolParts({ items: [{ id: TASK_ID, kind: 'task', title: 'Storage lane' }] })}
        onOpenEntity={onOpenEntity}
      />,
    );
    const chip = view.getByTestId('chat-entity-chip');
    expect(chip.tagName).toBe('BUTTON');
    fireEvent.click(chip);
    expect(onOpenEntity).toHaveBeenCalledWith(TASK_ID);
  });

  it('is an inert badge when the host cannot — no button, no dead press', () => {
    /* THE PHONE. `MobileShell` has no workspace to open an entity into, so it
       passes no handler at all. What must NOT happen is what a `() => undefined`
       produced: a BUTTON that consumes the press and does nothing. */
    const view = render(
      <TurnParts
        parts={toolParts({ items: [{ id: TASK_ID, kind: 'task', title: 'Storage lane' }] })}
      />,
    );
    const chip = view.getByTestId('chat-entity-chip');
    expect(chip.tagName).toBe('SPAN');
    expect(within(chip).getByText('Storage lane')).toBeTruthy();
    expect(view.queryByRole('button', { name: /Storage lane/ })).toBeNull();
  });
});
