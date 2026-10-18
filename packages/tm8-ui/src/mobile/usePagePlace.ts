/**
 * EACH STACK ENTRY KEEPS ITS SCROLL POSITION AND ITS COMPOSER DRAFT
 * (CONTRACT §5 ruling 5, owner 2026-10-18).
 *
 * A pushed page unmounts the one under it — the phone shows one surface, and a
 * hidden page would keep polling behind the one being read — so where the
 * reader was cannot live in the DOM. It lives on the stack entry
 * (`stores/phoneHistory.ts`), written as the reader scrolls and types and read
 * back when Back returns to that entry.
 *
 * GENERIC ON PURPOSE. Every phone page scrolls in its own element (the list,
 * the reader, the transcript, the generic page), and every composer is a
 * textarea. Recording "which element, by its place in the content tree, was
 * scrolled how far / held what text" covers all of them without each screen
 * learning about the stack. A page whose structure changed while it was away
 * simply finds nothing at the old path and starts at the top — the honest
 * fallback, never a wrong scroll.
 *
 * Restores are retried for about a second, because a page that comes back
 * re-reads its rows and is shorter than the offset until they land; a touch or
 * wheel from the reader cancels the retry, so it never fights a finger.
 */
import { useEffect, useLayoutEffect } from 'react';
import {
  phoneHistory,
  saveTopPlace,
  topEntry,
  type EntryPlace,
  type SavedDraft,
  type SavedScroll,
} from '../stores/phoneHistory';

const RETRY_FRAMES = 60;

function pathOf(root: Element, el: Element): number[] | null {
  const path: number[] = [];
  let node: Element | null = el;
  while (node && node !== root) {
    const parent: Element | null = node.parentElement;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.children, node));
    node = parent;
  }
  return node === root ? path : null;
}

function atPath(root: Element, path: readonly number[]): Element | null {
  let node: Element | null = root;
  for (const i of path) {
    node = node?.children[i] ?? null;
    if (!node) return null;
  }
  return node;
}

/** Where the reader is inside `root`, right now. */
export function readPlace(root: Element): EntryPlace {
  const scrolls: SavedScroll[] = [];
  const drafts: SavedDraft[] = [];
  if (root.scrollTop > 0) scrolls.push({ path: [], top: root.scrollTop });
  for (const el of root.querySelectorAll('*')) {
    if (el.scrollTop > 0) {
      const path = pathOf(root, el);
      if (path) scrolls.push({ path, top: el.scrollTop });
    }
    if (el instanceof HTMLTextAreaElement && el.value !== '') {
      const path = pathOf(root, el);
      if (path) drafts.push({ path, value: el.value });
    }
  }
  return { scrolls, drafts };
}

/** Put a controlled textarea's text back the way React hears it: a native set + input. */
function restoreDraft(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Apply as much of `place` as the DOM can take now. Returns true when nothing
 * is left to retry.
 */
export function applyPlace(root: Element, place: EntryPlace, pendingDrafts: Set<number>): boolean {
  let done = true;
  for (const s of place.scrolls) {
    const el = atPath(root, s.path);
    if (!el) {
      done = false;
      continue;
    }
    if (el.scrollHeight - el.clientHeight < s.top) done = false;
    if (Math.abs(el.scrollTop - s.top) > 1) el.scrollTop = s.top;
  }
  place.drafts.forEach((d, i) => {
    if (!pendingDrafts.has(i)) return;
    const el = atPath(root, d.path);
    if (el instanceof HTMLTextAreaElement) {
      if (el.value === '') restoreDraft(el, d.value);
      pendingDrafts.delete(i);
    } else {
      done = false;
    }
  });
  return done;
}

/**
 * Record the top entry's place from `root` as the reader moves, and put it
 * back when the top entry changes to one that has a place.
 */
export function usePagePlace(root: Element | null, topSeq: number | null): void {
  /* Record: scroll and input, coalesced to one read per frame. */
  useEffect(() => {
    if (!root) return;
    let frame = 0;
    const record = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        saveTopPlace(readPlace(root));
      });
    };
    root.addEventListener('scroll', record, { capture: true, passive: true });
    root.addEventListener('input', record, { capture: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      root.removeEventListener('scroll', record, { capture: true });
      root.removeEventListener('input', record, { capture: true });
    };
  }, [root]);

  /* Restore, once per arrival on an entry that remembers somewhere. */
  useLayoutEffect(() => {
    if (!root || topSeq === null) return;
    const entry = topEntry(phoneHistory.getState());
    const place = entry?.seq === topSeq ? entry.place : null;
    if (!place || (place.scrolls.length === 0 && place.drafts.length === 0)) return;
    const pending = new Set(place.drafts.map((_, i) => i));
    if (applyPlace(root, place, pending)) return;
    let frames = 0;
    let frame = requestAnimationFrame(function retry() {
      frames += 1;
      if (applyPlace(root, place, pending) || frames >= RETRY_FRAMES) return;
      frame = requestAnimationFrame(retry);
    });
    const stop = () => cancelAnimationFrame(frame);
    root.addEventListener('touchstart', stop, { passive: true, once: true });
    root.addEventListener('wheel', stop, { passive: true, once: true });
    return () => {
      stop();
      root.removeEventListener('touchstart', stop);
      root.removeEventListener('wheel', stop);
    };
  }, [root, topSeq]);
}
