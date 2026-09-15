// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

import { MobileThreadsSheet } from './MobileThreadsSheet';
import { MobileSurfaceProvider } from './surface';
import type { ChatThreadSummary } from '../chat-home/types';
import type { EntityId } from '@tm8/contract';

/**
 * WHAT THESE DO NOT CLAIM TO SEE. jsdom loads no stylesheets, so nothing here
 * asserts that the sheet is tall, that a row is 44px, or that the current
 * conversation reads as current — those are browser questions and belong in a
 * screenshot. What they see is the behaviour: what is in the DOM and what
 * fires.
 */

function mount(ui: ReactElement) {
  return render(<MobileSurfaceProvider sheetHost={document.body}>{ui}</MobileSurfaceProvider>);
}

function thread(n: number): ChatThreadSummary {
  return {
    rootId: `t${n}` as EntityId,
    anchorId: `a${n}` as EntityId,
    title: `Conversation ${n}`,
    preview: `preview ${n}`,
  } as ChatThreadSummary;
}

const NOOP = () => undefined;

describe('MobileThreadsSheet', () => {
  /**
   * OFF THE PHONE IT IS NOTHING — no provider ⇒ no `sheetHost` ⇒ `MobileSheet`
   * renders null. The desktop shell is in daily use, and this is what lets a
   * host mount it unconditionally.
   */
  it('renders nothing without a phone surface', () => {
    const view = render(
      <MobileThreadsSheet
        threads={[thread(1)]}
        selectedThreadId={null}
        onSelectThread={NOOP}
        onNewThread={NOOP}
        onDismiss={NOOP}
      />,
    );
    expect(view.container.textContent).toBe('');
  });

  it('lists every conversation the shell handed it, however many that is', () => {
    /* THE WHOLE POINT OF THE MOVE (task 01a0a5f2). The drawer could not hold a
       population that grows; this surface exists to. Twenty is not a cap —
       it is enough to show that nothing here truncates. */
    const many = Array.from({ length: 20 }, (_, i) => thread(i));
    const view = mount(
      <MobileThreadsSheet
        threads={many}
        selectedThreadId={null}
        onSelectThread={NOOP}
        onNewThread={NOOP}
        onDismiss={NOOP}
      />,
    );
    expect(view.getAllByText(/^Conversation \d+$/)).toHaveLength(20);
  });

  it('marks exactly the open conversation as current', () => {
    /* `aria-current` is the ONE source of the current-row look (the stylesheet
       keys off it), so a row that reads as current and does not announce
       itself as current is not a rendering this component has. */
    const view = mount(
      <MobileThreadsSheet
        threads={[thread(1), thread(2)]}
        selectedThreadId={'t2' as EntityId}
        onSelectThread={NOOP}
        onNewThread={NOOP}
        onDismiss={NOOP}
      />,
    );
    /* `baseElement`, not `container`: the sheet PORTALS into `sheetHost`, so
       it is never a descendant of the render container. */
    const current = view.baseElement.querySelectorAll('[aria-current]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain('Conversation 2');
  });

  it('reports the picked conversation by id', () => {
    const onSelectThread = vi.fn();
    const view = mount(
      <MobileThreadsSheet
        threads={[thread(1), thread(2)]}
        selectedThreadId={null}
        onSelectThread={onSelectThread}
        onNewThread={NOOP}
        onDismiss={NOOP}
      />,
    );
    fireEvent.click(view.getByText('Conversation 2'));
    expect(onSelectThread).toHaveBeenCalledWith('t2');
  });

  it('keeps the verb reachable without reading past the list', () => {
    /* ＋ New conversation is the first row, not the last. A viewer who opened
       this list to start something new must not have to scroll the
       conversations they are not looking for to find it. */
    const onNewThread = vi.fn();
    const view = mount(
      <MobileThreadsSheet
        threads={[thread(1)]}
        selectedThreadId={null}
        onSelectThread={NOOP}
        onNewThread={onNewThread}
        onDismiss={NOOP}
      />,
    );
    const rows = view.baseElement.querySelectorAll('.mthreads__row');
    expect(rows[0]?.textContent).toContain('New conversation');
    fireEvent.click(view.getByText('New conversation'));
    expect(onNewThread).toHaveBeenCalledTimes(1);
  });

  it('says so when there is nothing, rather than showing an empty sheet', () => {
    const view = mount(
      <MobileThreadsSheet
        threads={[]}
        selectedThreadId={null}
        onSelectThread={NOOP}
        onNewThread={NOOP}
        onDismiss={NOOP}
      />,
    );
    expect(view.getByText('No conversations on this space yet.')).toBeTruthy();
  });
});
