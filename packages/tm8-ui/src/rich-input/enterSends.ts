/**
 * WHETHER RETURN SENDS — one rule for every composer (audit A1).
 *
 * On a phone the Return key is the only newline the soft keyboard offers;
 * there is no Shift to hold. Send-on-Enter there makes a multi-line message
 * impossible to type, so on the phone shell's input (`(pointer: coarse) &&
 * width < 500`, the same cut as `mobile/shell-for.ts`) Return is a newline and
 * the Send button is the only way to send. Everywhere else — every desktop,
 * and a coarse tablet with its hardware keyboard — Enter sends as it always
 * has, and Shift+Enter is the newline.
 *
 * The rule reads the POINTER, not the per-device shell override: forcing the
 * desktop shell on a phone does not give it a Shift key.
 *
 * Pure, so it is proved without a DOM; `useEnterSends` is the live wrapper.
 */
import { useSyncExternalStore } from 'react';
import { shellFor, type PointerType } from '../mobile/shell-for';

export interface EnterSendsInput {
  readonly pointer: PointerType;
  readonly width: number;
}

export function enterSends(env: EnterSendsInput): boolean {
  return shellFor({ pointer: env.pointer, width: env.width }) === 'desktop';
}

/**
 * Is this keystroke a send? Plain Enter on a keyboard that sends; never with
 * Shift, and never inside an IME candidate window — Enter there commits the
 * candidate, and sending on it would post a half-typed word.
 */
export function isSendKey(
  event: { key: string; shiftKey: boolean; nativeEvent?: { isComposing?: boolean } },
  sends: boolean,
): boolean {
  return sends && event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing;
}

const COARSE_POINTER = '(pointer: coarse)';

function readSends(): boolean {
  if (typeof window === 'undefined') return true;
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia(COARSE_POINTER).matches;
  return enterSends({ pointer: coarse ? 'coarse' : 'fine', width: window.innerWidth });
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('resize', onChange);
  const query = typeof window.matchMedia === 'function' ? window.matchMedia(COARSE_POINTER) : null;
  query?.addEventListener?.('change', onChange);
  return () => {
    window.removeEventListener('resize', onChange);
    query?.removeEventListener?.('change', onChange);
  };
}

/** Live `enterSends` for this window: follows rotation, resize and pointer changes. */
export function useEnterSends(): boolean {
  return useSyncExternalStore(subscribe, readSends, () => true);
}
