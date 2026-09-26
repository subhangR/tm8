import { useCallback, useLayoutEffect, useRef, useState, type UIEvent } from 'react';

/**
 * ── THE TRANSCRIPT FOLLOWS THE END, UNLESS THE READER LEFT IT ──────────────
 *
 * Moved here from `ChatHomeScreen` (lane 2 owns transcript scroll). The two
 * rules it inherited are unchanged and still pinned by
 * `phone-chat-defects.test.tsx` / `phone-chat-open.test.tsx`:
 *
 *   - a reader AT the end stays pinned there while the conversation grows;
 *   - a reader who scrolled up to read back is NEVER yanked down.
 *
 * What was missing is the second half of the second rule. A reader who
 * scrolled up during a long turn had no way to know anything had arrived
 * below them, and no way back except dragging the whole thread. So the hook
 * now also RENDERS one fact — "the reader is away from the end" — and counts
 * the MESSAGES that arrived since they left, which is what the dock's
 * `Jump to latest · N new` button says. Messages, not steps (advisor D16.4):
 * steps land every few seconds, and a number that climbs by itself reads as a
 * notification rather than a position.
 *
 * STILL MOSTLY REFS. Scroll position is not rendered: putting it in state
 * would re-render the whole transcript on every `scroll` event, the one place
 * a long thread feels that cost. The only state is `leftAt`, and it changes
 * exactly twice per excursion — when the reader leaves the end and when they
 * come back — so a scroll that does not cross the threshold writes nothing.
 */

/**
 * How close to the end still counts as "at the end" (advisor D5: 40px). A
 * tolerance, not a guess: a phone's momentum scroll and the browser's
 * sub-pixel rounding both land a few pixels short of the exact maximum, and an
 * exact comparison would read a reader who IS at the bottom as one who left.
 */
export const NEAR_BOTTOM_PX = 40;

/**
 * How long after a Jump the scroll events of its own smooth scroll are not
 * read as the reader leaving. A smooth scroll passes through every position
 * between here and the end; without this, its first frame would re-arm the
 * pill it was pressed to dismiss.
 */
const JUMP_SETTLE_MS = 1000;

export interface TranscriptFollowInput {
  /** The open conversation. A change is a new box of content: land on its end. */
  threadKey: string | null;
  /**
   * The rendered content. Every frame merge mints a new `detail`, so this is
   * the signal that the end MAY have moved; the height guard decides whether
   * it did.
   */
  content: unknown;
  /** The dock's shape (live row phase, …). It sits under the last turn, so a
   *  row appearing or changing size moves the end too. */
  tail: unknown;
  /** Messages on screen — `detail.turns.length`. What `unseen` counts. */
  itemCount: number;
}

export interface TranscriptFollow {
  /** Attach to the scrolling transcript element. */
  ref: (element: HTMLDivElement | null) => void;
  onScroll: (event: UIEvent<HTMLDivElement>) => void;
  /** The reader has scrolled away from the end. */
  away: boolean;
  /** Messages that arrived since the reader left the end; 0 while following. */
  unseen: number;
  /** Back to the end (smoothly unless reduced motion), following again, with
   *  focus kept in the transcript. */
  jumpToLatest: () => void;
}

export function useTranscriptFollow({
  threadKey,
  content,
  tail,
  itemCount,
}: TranscriptFollowInput): TranscriptFollow {
  const elementRef = useRef<HTMLDivElement | null>(null);
  /** THE READER'S INTENT, not a position — read synchronously by the layout
   *  effect below, which is why it is a ref and not the `leftAt` state. */
  const stickRef = useRef(true);
  /**
   * THE HEIGHT THE TRANSCRIPT WAS LAST FOLLOWED TO — what keeps the follow
   * effect from being a scroll SOURCE as well as a scroll sink. Most stream
   * frames append inside a line that has not wrapped yet and move nothing; a
   * write for each of them fed `MobileFrame`'s keyboard-inset measurement a
   * scroll nobody asked for, which on iOS closed a loop that read as jitter.
   *
   * `-1` is NOT FOLLOWING: set while the reader is away and on every thread
   * switch, so the next opt-in re-anchors even at a height this box has been
   * to before.
   */
  const followedHeightRef = useRef(-1);
  /** The message count when the reader left the end; `null` while following. */
  const [leftAt, setLeftAt] = useState<number | null>(null);
  /** Until when a Jump's own smooth scroll is still travelling. */
  const jumpUntilRef = useRef(0);
  const itemCountRef = useRef(itemCount);
  useLayoutEffect(() => {
    itemCountRef.current = itemCount;
  }, [itemCount]);

  const ref = useCallback((element: HTMLDivElement | null) => {
    elementRef.current = element;
  }, []);

  /* Opening a conversation is not growth — it always lands on the newest
     turn, whatever the reader was doing in the thread they just left. */
  useLayoutEffect(() => {
    stickRef.current = true;
    followedHeightRef.current = -1;
    setLeftAt(null);
  }, [threadKey]);

  /*
   * STICK TO THE END, BUT ONLY WHEN THE END MOVED. `useLayoutEffect` so the
   * correction lands in the same frame as the content that caused it; a
   * passive effect paints the un-scrolled frame first and the transcript
   * visibly jumps on every streamed block.
   *
   * While the reader is away the followed height is DROPPED rather than
   * remembered, so the moment they come back within `NEAR_BOTTOM_PX` the next
   * frame re-anchors them even if the height never moved.
   */
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    if (!stickRef.current) {
      followedHeightRef.current = -1;
      return;
    }
    const height = element.scrollHeight;
    if (height === followedHeightRef.current) return;
    followedHeightRef.current = height;
    element.scrollTop = height;
  }, [content, tail]);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const atEnd =
      element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_BOTTOM_PX;
    // A Jump's smooth scroll in flight is not the reader leaving.
    if (!atEnd && Date.now() < jumpUntilRef.current) return;
    stickRef.current = atEnd;
    /* Two writes per excursion, not one per scroll event: `null → n` when the
       reader leaves, `n → null` when they return. Everything between returns
       the current value and React bails out. */
    setLeftAt((current) => (atEnd ? null : (current ?? itemCountRef.current)));
  }, []);

  const jumpToLatest = useCallback(() => {
    const element = elementRef.current;
    if (!element) return;
    stickRef.current = true;
    const height = element.scrollHeight;
    followedHeightRef.current = height;
    if (smoothScrollAllowed() && typeof element.scrollTo === 'function') {
      jumpUntilRef.current = Date.now() + JUMP_SETTLE_MS;
      element.scrollTo({ top: height, behavior: 'smooth' });
    } else {
      element.scrollTop = height;
    }
    setLeftAt(null);
    /* The button that was pressed unmounts with `away`. Without this, focus
       falls to <body> and a keyboard reader is thrown back to the top of the
       page; the transcript is where they asked to be. */
    element.focus({ preventScroll: true });
  }, []);

  return {
    ref,
    onScroll,
    away: leftAt !== null,
    unseen: leftAt === null ? 0 : Math.max(0, itemCount - leftAt),
    jumpToLatest,
  };
}

/**
 * Smooth only when the reader has said nothing about motion. Reduced motion
 * jumps instantly (D5), and so does an environment with no `matchMedia` at
 * all (jsdom) — an instant jump is the one that is always correct.
 */
function smoothScrollAllowed(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
}
