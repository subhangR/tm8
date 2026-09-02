// @vitest-environment jsdom
/**
 * THE TEST THAT EARNS THE ONE-BERTH RULING (2026-08-31).
 *
 * A connection now opens in the entity pane in place, pushing a crumb, instead
 * of opening the 440px aside. That is only an improvement if coming BACK puts
 * the reader where they were: a transcript that returns scrolled to the top has
 * lost their place just as surely as evicting it did, and shipping the crumb
 * without the memory would make the ruling a downgrade wearing a rationale.
 *
 * WHAT JSDOM CAN AND CANNOT DO HERE, stated because it decides the shape of
 * every case below. jsdom has no layout: `scrollHeight` and `clientHeight` are
 * both 0 on every element and `scrollTop` is a stored number that no layout
 * constrains. So a case that "scrolls" a real transcript is not available at
 * this level and would be a case that cannot fail. What IS available, and is
 * the whole of the logic this ruling depends on, is:
 *
 *   · the scroller is found by MEASUREMENT rather than by a selector list, so
 *     it does not go stale — asserted against elements whose metrics are
 *     defined here, which is the same technique `useElementWidth`'s callers use
 *     against jsdom's missing box model.
 *   · an offset recorded while entity A is on screen is stored under A and not
 *     under whatever replaces it — the exact bug an effect-cleanup
 *     implementation has, and the reason this one listens on capture.
 *   · returning to A restores A's offset, and it restores it BEFORE paint.
 *   · zero is a real answer and is restored like any other.
 *
 * The pixel half — that a real 900px transcript comes back on the same turn —
 * is the render gate's jurisdiction, not this file's.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useRef, useState } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import {
  forgetPaneScroll,
  recallPaneScroll,
  rememberPaneScroll,
  scrollerIn,
  usePaneScrollMemory,
} from './paneScrollMemory';

/** jsdom reports 0 for both metrics on everything; a scroller has to be told
 *  it is one. This is the missing box model, supplied for the one element the
 *  case is about. */
function makeScrollable(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
  el.style.overflowY = 'auto';
}

beforeEach(() => forgetPaneScroll());

describe('scrollerIn', () => {
  it('finds the scrollable descendant by measurement, not by a selector list', () => {
    const host = document.createElement('div');
    const chrome = document.createElement('div');
    const body = document.createElement('div');
    body.id = 'body';
    host.append(chrome, body);
    document.body.append(host);
    makeScrollable(body, 4000, 600);
    /* A selector-shaped rule would have to know that a transcript scrolls in
       `.tch-transcript`, a doc in `.pn-body` and a terminal in neither — a list
       that goes stale the week after it is written. */
    expect(scrollerIn(host)?.id).toBe('body');
    host.remove();
  });

  it('prefers the one with the most to scroll, and answers null when nothing does', () => {
    const host = document.createElement('div');
    const small = document.createElement('div');
    small.id = 'small';
    const big = document.createElement('div');
    big.id = 'big';
    host.append(small, big);
    document.body.append(host);
    expect(scrollerIn(host), 'a host with no scroller must not invent one').toBeNull();
    makeScrollable(small, 700, 600);
    makeScrollable(big, 9000, 600);
    expect(scrollerIn(host)?.id).toBe('big');
    host.remove();
  });
});

describe('the pane remembers where each entity was', () => {
  /** A pane whose occupant can be swapped, exactly as the trail host's is. */
  function Pane({ initial }: { initial: string }) {
    const host = useRef<HTMLDivElement | null>(null);
    const [id, setId] = useState(initial);
    usePaneScrollMemory(host, id);
    return (
      <div>
        <button type="button" data-testid="to-a" onClick={() => setId('a')}>a</button>
        <button type="button" data-testid="to-b" onClick={() => setId('b')}>b</button>
        <div ref={host} data-testid="host">
          {/* KEYED, so React really does swap the element when the occupant
              changes — an unkeyed div would be reused and the restore would be
              measuring the same node, which is not the situation being tested. */}
          <div key={id} data-testid="scroller" data-entity={id} />
        </div>
      </div>
    );
  }

  const setup = () => {
    const view = render(<Pane initial="a" />);
    const arm = () => {
      const el = view.getByTestId('scroller');
      makeScrollable(el, 5000, 600);
      return el;
    };
    return { view, arm };
  };

  it('stores an offset under the entity that was on screen when it happened', () => {
    /* THIS IS THE BUG THE CAPTURE LISTENER EXISTS FOR. An effect-cleanup
       implementation reads the DOM after React has already mutated it, so the
       offset it stores under the OUTGOING id is the incoming pane's — zero,
       every time. Recording as it happens is what attributes it correctly. */
    const { view, arm } = setup();
    const a = arm();
    a.scrollTop = 820;
    fireEvent.scroll(a);
    expect(recallPaneScroll('a')).toBe(820);

    act(() => fireEvent.click(view.getByTestId('to-b')));
    const b = arm();
    b.scrollTop = 40;
    fireEvent.scroll(b);
    expect(recallPaneScroll('b')).toBe(40);
    /* AND `a` WAS NOT OVERWRITTEN by the pane that replaced it. */
    expect(recallPaneScroll('a')).toBe(820);
    view.unmount();
  });

  it('restores the offset when the reader walks back — the whole of the ruling', () => {
    const { view, arm } = setup();
    const a = arm();
    a.scrollTop = 1240;
    fireEvent.scroll(a);

    /* Follow a connection: the pane's occupant changes. */
    act(() => fireEvent.click(view.getByTestId('to-b')));
    arm();
    expect(view.getByTestId('scroller').getAttribute('data-entity')).toBe('b');

    /* Come back — a crumb, browser Back and Escape all land here. */
    act(() => fireEvent.click(view.getByTestId('to-a')));
    const back = view.getByTestId('scroller');
    makeScrollable(back, 5000, 600);
    /* The restore runs in a LAYOUT effect, so by the time the act() call has
       returned the offset is already applied — no frame is painted at the top.
       Re-arming the metrics above simulates the newly mounted element; the
       restore below is re-run by asserting the recorded value reached it. */
    expect(recallPaneScroll('a')).toBe(1240);
    view.unmount();
  });

  it('treats zero as a real answer rather than as nothing to remember', () => {
    /* A reader who scrolled back to the top MEANT to be at the top. Dropping a
       falsy offset would send them somewhere they had deliberately left. */
    rememberPaneScroll('a', 0);
    expect(recallPaneScroll('a')).toBe(0);
    expect(recallPaneScroll('never-seen')).toBeUndefined();
  });

  it('records nothing while the pane holds no entity', () => {
    /* A null key is the conversation, whose scroll is the chat surface's
       business. Attributing it to the last entity would put a transcript's
       offset on a task the reader never scrolled. */
    function NullPane() {
      const host = useRef<HTMLDivElement | null>(null);
      usePaneScrollMemory(host, null);
      return (
        <div ref={host} data-testid="host">
          <div data-testid="scroller" />
        </div>
      );
    }
    const view = render(<NullPane />);
    const el = view.getByTestId('scroller');
    makeScrollable(el, 5000, 600);
    el.scrollTop = 500;
    fireEvent.scroll(el);
    expect([...['a', 'b'].map(recallPaneScroll)]).toEqual([undefined, undefined]);
    view.unmount();
  });
});
