/**
 * R2-D9: the craft's chat and the active page's side column are EXCLUSIVE.
 * Opening either closes the other, so two chat columns never stand side by
 * side. Whichever just opened wins; a page arriving with its column already
 * open (or the first paint with both open) counts as the page opening.
 */
import { useEffect, useRef } from 'react';

export interface ExclusiveChatInput {
  /** The craft chat column is showing. */
  craftShown: boolean;
  /** The active page's side column is showing. */
  pageShown: boolean;
  /** The active page (its column state is per page). */
  pageId: string | null;
  hideCraft(): void;
  closePage(): void;
}

export function useExclusiveChat({ craftShown, pageShown, pageId, hideCraft, closePage }: ExclusiveChatInput): void {
  const was = useRef<{ craft: boolean; page: boolean; pageId: string | null } | null>(null);
  const hide = useRef(hideCraft);
  const close = useRef(closePage);
  hide.current = hideCraft;
  close.current = closePage;
  useEffect(() => {
    const before = was.current;
    was.current = { craft: craftShown, page: pageShown, pageId };
    if (!craftShown || !pageShown) return;
    const craftJustOpened = !!before && before.pageId === pageId && before.page && !before.craft;
    if (craftJustOpened) close.current();
    else hide.current();
  }, [craftShown, pageShown, pageId]);
}
