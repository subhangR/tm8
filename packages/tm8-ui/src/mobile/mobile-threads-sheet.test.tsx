// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

import { MobileDrawer } from './MobileDrawer';
import { MobileThreadsSheet } from './MobileThreadsSheet';
import { MobileSurfaceProvider } from './surface';
import type { ChatThreadSummary } from '../chat-home/types';
import type { EntityId, EntityKind } from '@tm8/contract';
import { getKind } from '../domain';

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

/**
 * ── THE OTHER HALF OF THE MOVE ────────────────────────────────────────────
 *
 * The sheet above is where the conversations went; these are about what the
 * drawer keeps now that they are gone. They live beside the sheet's own tests
 * because the thing under test is the DOOR between the two — a drawer that
 * still listed threads and a sheet that listed them as well would pass every
 * test above and be the bug.
 */
const CREATE_KIND = 'task' as EntityKind;

function mountDrawer(over: Partial<Parameters<typeof MobileDrawer>[0]> = {}) {
  return render(
    <MobileSurfaceProvider sheetHost={document.body}>
      <MobileDrawer
        spaceLabel="tm8"
        activeTarget={null}
        navigateTo={NOOP}
        countsFor={() => undefined}
        onOpenChats={NOOP}
        onNewThread={NOOP}
        newEntityKind={CREATE_KIND}
        onNewEntity={NOOP}
        onDismiss={NOOP}
        {...over}
      />
    </MobileSurfaceProvider>,
  );
}

/** The Chats section's rows, in the order a reader meets them. */
function chatsRows(view: ReturnType<typeof render>): string[] {
  const heading = Array.from(view.baseElement.querySelectorAll('*')).find(
    (el) => el.children.length === 0 && el.textContent === 'Chats',
  );
  const section = heading?.closest('li, section, div');
  const list = section?.querySelector('ul') ?? heading?.parentElement?.querySelector('ul');
  return Array.from(list?.querySelectorAll('.mdrawer__row') ?? []).map(
    (row) => row.textContent ?? '',
  );
}

describe('MobileDrawer — the Chats section', () => {
  it('carries BOTH verbs and the door, and nothing that grows', () => {
    /*
     * THE WHOLE SHAPE, ASSERTED AS AN EXACT LIST rather than three presence
     * checks. Ruling 7 is a statement about what is NOT there, and a
     * presence check cannot see a fourth row creeping in beside the three.
     * Twelve conversations are handed to the shell's counter here precisely
     * so that a regression to the inline list would show up as twelve extra
     * entries rather than as a passing test.
     */
    const view = mountDrawer({ chatCount: 12 });
    expect(chatsRows(view)).toEqual(['New conversation', 'New task', 'Conversations12']);
  });

  it('the second verb takes its word from the registry, not from the drawer', () => {
    /* `palette.createLabel` is the same string `EntityCreateControl` renders.
       If the drawer ever spelled its own, this is the test that would still
       pass while the two shells drifted — so it asserts the REGISTRY'S word,
       fetched the way the control fetches it. */
    const view = mountDrawer();
    const label = getKind(CREATE_KIND).palette?.createLabel;
    expect(label).toBeTruthy();
    expect(view.getByTestId('mobile-drawer-new-entity').textContent).toBe(label);
  });

  it('the work verb fires the shell create and the drawer never creates', () => {
    const onNewEntity = vi.fn();
    const view = mountDrawer({ onNewEntity });
    fireEvent.click(view.getByTestId('mobile-drawer-new-entity'));
    expect(onNewEntity).toHaveBeenCalledTimes(1);
  });

  it('refuses the work verb in place rather than removing it', () => {
    /* R7: never hidden, never a live button that does nothing. The row is
       still there, still reachable by tab (`aria-disabled`, not `disabled`),
       and pressing it does not fire. */
    const onNewEntity = vi.fn();
    const view = mountDrawer({
      onNewEntity,
      newEntityUnavailable: { cause: 'This node cannot create', remedy: 'reconnect' },
    });
    const row = view.getByTestId('mobile-drawer-new-entity');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.hasAttribute('disabled')).toBe(false);
    fireEvent.click(row);
    expect(onNewEntity).not.toHaveBeenCalled();
  });

  it('the Conversations row opens the sheet AND dismisses the drawer', () => {
    /* BOTH, in that order, because either one alone is a broken door: opening
       the sheet under a drawer that stayed up leaves two navigation surfaces
       stacked, and dismissing without opening loses the press. */
    const calls: string[] = [];
    const view = mountDrawer({
      chatCount: 3,
      onOpenChats: () => calls.push('open'),
      onDismiss: () => calls.push('dismiss'),
    });
    fireEvent.click(view.getByTestId('mobile-drawer-chats'));
    expect(calls).toEqual(['open', 'dismiss']);
  });

  it('draws no count until the shell has one — absent is not zero', () => {
    const view = mountDrawer();
    expect(view.getByTestId('mobile-drawer-chats').textContent).toBe('Conversations');
    /* UNMOUNTED FIRST, because the drawer PORTALS into `sheetHost` — two live
       mounts put two of every row in the same body and `getByTestId` would
       fail on the duplicate rather than on the count. */
    view.unmount();
    /* A counted zero DOES draw: "no conversations" is a fact about the space. */
    const counted = mountDrawer({ chatCount: 0 });
    expect(counted.getByTestId('mobile-drawer-chats').textContent).toBe('Conversations0');
  });
});
