/**
 * useModalFocus — THE FOCUS HALF OF `aria-modal` (audit C3/D2, task t-layers).
 *
 * The drawer and every `MobileSheet` claim `aria-modal="true"`. That claim is
 * four promises, and before this hook the layers kept none of them:
 *
 *   1. FOCUS MOVES IN. On open, the first row takes focus (the drawer names its
 *      own: "+ New chat"). A text field is skipped on purpose: focusing one on
 *      a phone raises the keyboard over the layer the reader just opened. If
 *      the content already focused something itself (an `autoFocus` field),
 *      that choice stands.
 *   2. TAB STAYS IN. Tab and Shift+Tab cycle inside the TOPMOST layer only, so
 *      a sheet over the drawer traps in the sheet.
 *   3. WHAT IS BEHIND IS INERT. Everything else in the phone frame gets
 *      `inert`, so a screen reader's swipe cannot walk out of the layer into
 *      the transcript under the scrim. Ref-counted, so two stacked layers do
 *      not un-inert each other's background.
 *   4. FOCUS GOES HOME. On close it returns to the control that opened the
 *      layer (CONTRACT §5 "Focus return"), when that control is still there.
 *
 * `active` false is "closing": the promises are released at the START of the
 * exit animation, so focus is home before the panel finishes leaving.
 */
import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Open trapping layers, bottom first. Only the last one traps Tab. */
const stack: HTMLElement[] = [];
const inertCounts = new Map<Element, number>();

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest('[inert]') && el.getAttribute('aria-hidden') !== 'true',
  );
}

function isTextEntry(el: HTMLElement): boolean {
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
}

/*
 * Siblings of every ancestor up to the phone frame (or the body, off-frame):
 * exactly the parts of the page that are not this layer or on its path.
 */
function background(root: HTMLElement): Element[] {
  const out: Element[] = [];
  const stop = root.closest('.mobile-frame') ?? document.body;
  let node: HTMLElement | null = root;
  while (node && node !== stop && node.parentElement) {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling !== node && sibling.tagName !== 'SCRIPT') out.push(sibling);
    }
    node = node.parentElement;
  }
  return out;
}

function addInert(el: Element): boolean {
  const count = inertCounts.get(el);
  if (count === undefined) {
    /* Already inert for someone else's reason: not ours to manage. */
    if (el.hasAttribute('inert')) return false;
    el.setAttribute('inert', '');
    inertCounts.set(el, 1);
  } else {
    inertCounts.set(el, count + 1);
  }
  return true;
}

function dropInert(el: Element): void {
  const count = inertCounts.get(el);
  if (count === undefined) return;
  if (count <= 1) {
    inertCounts.delete(el);
    el.removeAttribute('inert');
  } else {
    inertCounts.set(el, count - 1);
  }
}

export interface ModalFocusOptions {
  /** Selector for the element that takes focus on open, when present. */
  readonly initial?: string;
  /**
   * Where the "first row" is looked for, before the whole layer: a sheet's
   * first row is in its body, not the ✕ in its head.
   */
  readonly scope?: string;
}

export function useModalFocus(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  options: ModalFocusOptions = {},
): void {
  const { initial, scope } = options;

  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stack.push(root);
    const inerted = background(root).filter(addInert);

    if (!root.contains(document.activeElement)) {
      const named = initial ? root.querySelector<HTMLElement>(initial) : null;
      const scoped = scope ? root.querySelector<HTMLElement>(scope) : null;
      const firstIn = (el: HTMLElement | null) => (el ? focusables(el).find((f) => !isTextEntry(f)) : undefined);
      const first = named ?? firstIn(scoped) ?? firstIn(root) ?? null;
      const target = first ?? root.querySelector<HTMLElement>('[role="dialog"]') ?? root;
      if (target === root || !target.matches(FOCUSABLE)) {
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      }
      target.focus({ preventScroll: true });
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || stack[stack.length - 1] !== root) return;
      const items = focusables(root);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const at = document.activeElement;
      if (event.shiftKey && (at === first || !root.contains(at))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (at === last || !root.contains(at))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const index = stack.lastIndexOf(root);
      if (index !== -1) stack.splice(index, 1);
      inerted.forEach(dropInert);
      /* Home only if focus is still ours to place: inside the layer, or lost
         to the body because the layer's focused row just unmounted. */
      const at = document.activeElement;
      const ours = !at || at === document.body || root.contains(at);
      if (ours && opener && opener.isConnected && !opener.closest('[inert]')) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [ref, active, initial, scope]);
}
