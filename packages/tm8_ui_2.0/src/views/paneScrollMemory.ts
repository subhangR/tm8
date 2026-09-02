/**
 * PANE SCROLL MEMORY — what makes "one pane, a trail of crumbs" a change of
 * mechanism rather than a loss.
 *
 * THE RULING (2026-08-31, delegated by the owner: "You take the call which fits
 * best"). A connection now ALWAYS opens in the entity pane, in place, pushing a
 * trail crumb. `openRight` / region C stops being a destination for that
 * gesture on Home. This SUPERSEDES R6's mechanism — not its reason.
 *
 * R6's reason was: do not lose your place when you follow a reference out of
 * something you are reading. That reason is still right, and the aside was
 * already failing it — the aside holds exactly ONE entity, so chip → chip → chip
 * evicts the first anyway and its guarantee expires on the second click. A
 * crumb trail survives arbitrary depth. But a crumb trail alone would be a
 * DOWNGRADE, because a transcript that comes back scrolled to the top has lost
 * the reader's place just as surely as evicting it did.
 *
 * So this module is the half that makes the ruling honest: the pane remembers
 * where each entity was scrolled to, and coming back — crumb, browser Back, or
 * Escape — puts it there.
 *
 * WHY A CAPTURE-PHASE LISTENER AND NOT A CLEANUP. The obvious shape is "save on
 * the way out, in an effect cleanup". It does not work: React has already
 * mutated the DOM by the time a cleanup runs, so the element the cleanup reads
 * is the INCOMING entity's, and what gets stored under the outgoing id is the
 * new pane's scrollTop — zero, every time. `scroll` does not bubble but it does
 * CAPTURE, so one listener on the host sees every descendant scroller and the
 * offset is recorded as it happens, while the id it belongs to is still current.
 *
 * VIEWER-LOCAL AND IN MEMORY, deliberately. Where you were in a transcript is a
 * property of this sitting, not a preference. Persisting it would restore a
 * position in a conversation that has since grown fifty turns — an offset that
 * no longer points at the thing it was pointing at, which is worse than the top.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/** id → the offset of the scroller inside the pane when we last saw it move. */
const offsets = new Map<string, number>();

/** Exported for tests and for a host that wants to reset between spaces. */
export function forgetPaneScroll(): void {
  offsets.clear();
}

export function rememberPaneScroll(key: string, offset: number): void {
  /* ZERO IS A REAL ANSWER and is stored like any other: a reader who scrolled
     back to the top of a transcript meant to be at the top, and "forget it
     because it is falsy" would send them somewhere they had deliberately left. */
  offsets.set(key, offset);
}

export function recallPaneScroll(key: string): number | undefined {
  return offsets.get(key);
}

/**
 * The scroller inside a pane, chosen by MEASUREMENT rather than by selector.
 *
 * A panel's scroll region is different per archetype — a transcript, a doc
 * body, a terminal — and a selector list would go stale the week after it was
 * written (the standing objection to selector-shaped rules in this package).
 * The scroller is simply the descendant that is actually scrollable and has the
 * most to scroll; if nothing is, there is nothing to remember.
 */
export function scrollerIn(host: HTMLElement | null): HTMLElement | null {
  if (!host) return null;
  let best: HTMLElement | null = null;
  let bestOverflow = 0;
  const walk = (el: HTMLElement) => {
    const overflow = el.scrollHeight - el.clientHeight;
    if (overflow > 8) {
      const style = el.ownerDocument.defaultView?.getComputedStyle(el);
      const y = style?.overflowY;
      if (y === 'auto' || y === 'scroll') {
        if (overflow > bestOverflow) {
          bestOverflow = overflow;
          best = el;
        }
      }
    }
    for (const child of el.children) {
      if (child instanceof HTMLElement) walk(child);
    }
  };
  walk(host);
  return best;
}

/**
 * Remember where `key`'s pane was scrolled to, and restore it when `key` comes
 * back.
 *
 * `key` is the entity currently occupying the pane, or `null` when nothing is.
 * A null key records nothing and restores nothing — the conversation's own
 * scroll is the chat surface's business, not this pane's.
 */
export function usePaneScrollMemory(
  host: RefObject<HTMLElement | null>,
  key: string | null,
): void {
  /* The key is read through a ref inside the listener so the listener is
     attached ONCE and always attributes an offset to the entity that was on
     screen when the scroll happened. Re-attaching per key would be equivalent
     here, but it would also mean a scroll landing in the gap between teardown
     and setup is simply lost. */
  const current = useRef(key);
  current.current = key;

  const onScroll = useCallback((event: Event) => {
    const id = current.current;
    if (!id) return;
    const target = event.target;
    if (target instanceof HTMLElement) rememberPaneScroll(id, target.scrollTop);
  }, []);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    node.addEventListener('scroll', onScroll, true);
    return () => node.removeEventListener('scroll', onScroll, true);
  }, [host, onScroll]);

  /* RESTORED IN A LAYOUT EFFECT, before the browser paints. An ordinary effect
     would paint one frame at the top and then jump, which reads as a flicker
     and, on a long transcript, as the screen losing your place and finding it
     again — the precise impression this exists to prevent. */
  useLayoutEffect(() => {
    if (!key) return;
    const remembered = recallPaneScroll(key);
    if (remembered === undefined) return;
    const node = host.current;
    if (!node) return;
    const scroller = scrollerIn(node);
    if (scroller) scroller.scrollTop = remembered;
  }, [host, key]);
}
