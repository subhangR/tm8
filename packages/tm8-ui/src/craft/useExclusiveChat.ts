/**
 * R2-D9: the design's chat and the active page's side column are EXCLUSIVE.
 * Opening either closes the other, so two chat columns never stand side by
 * side. Whichever just opened wins; a page arriving with its column already
 * open (or the first paint with both open) counts as the page opening.
 */
import { useEffect, useRef } from 'react';

export interface ExclusiveChatInput {
  /** The design chat column is showing. */
  designShown: boolean;
  /** The active page's side column is showing. */
  pageShown: boolean;
  /** The active page (its column state is per page). */
  pageId: string | null;
  hideDesign(): void;
  closePage(): void;
}

export function useExclusiveChat({ designShown, pageShown, pageId, hideDesign, closePage }: ExclusiveChatInput): void {
  const was = useRef<{ design: boolean; page: boolean; pageId: string | null } | null>(null);
  const hide = useRef(hideDesign);
  const close = useRef(closePage);
  hide.current = hideDesign;
  close.current = closePage;
  useEffect(() => {
    const before = was.current;
    was.current = { design: designShown, page: pageShown, pageId };
    if (!designShown || !pageShown) return;
    const designJustOpened = !!before && before.pageId === pageId && before.page && !before.design;
    if (designJustOpened) close.current();
    else hide.current();
  }, [designShown, pageShown, pageId]);
}
