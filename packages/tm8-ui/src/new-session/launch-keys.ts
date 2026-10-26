import { LAUNCH_KEYS, type LaunchKeyAction } from '../keyboard';

/**
 * THE LAUNCH CARD'S OWN KEYS (user ruling, task 01a1156f): "Esc, then a letter".
 *
 * The card opens with the cursor in the prompt, so a plain letter there is
 * typing. Esc leaves the prompt FOR THE CARD (not for the page), and from the
 * card one letter reaches each control; `i` goes back into the prompt. The
 * letters come from the keyboard contract's `LAUNCH_KEYS`, which also writes
 * the help overlay's Launch rows — one table, two readers.
 */

const ACTION_OF_KEY: ReadonlyMap<string, LaunchKeyAction> = new Map(
  (Object.entries(LAUNCH_KEYS) as [LaunchKeyAction, string][]).map(([action, key]) => [key, action]),
);

/** The card action a plain key names, or null. Case-sensitive: Shift+M is not `m`. */
export function launchActionFor(key: string): LaunchKeyAction | null {
  return ACTION_OF_KEY.get(key) ?? null;
}

/** A field the user types into — where letters are text and Esc means "leave". */
export function isTextField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable;
}

/** The hint line under the card while it holds focus, in the controls' visual order. */
export const LAUNCH_HINTS: readonly { key: string; label: string }[] = [
  { key: LAUNCH_KEYS.workdir, label: 'directory' },
  { key: LAUNCH_KEYS.worktree, label: 'branch' },
  { key: LAUNCH_KEYS.options, label: 'more' },
  { key: LAUNCH_KEYS.model, label: 'model' },
  { key: LAUNCH_KEYS.effort, label: 'effort' },
  { key: LAUNCH_KEYS.permission, label: 'permission' },
  { key: LAUNCH_KEYS.teammate, label: 'teammate' },
  { key: LAUNCH_KEYS.prompt, label: 'prompt' },
  { key: '⏎', label: 'launch' },
];

/**
 * Move focus through an open menu's options, wrapping. Every button counts,
 * refused ones included: they stay focusable so their reason (the `title`) is
 * reachable, exactly as with the pointer. From outside the menu, ↓ lands on the
 * first option and ↑ on the last.
 */
export function moveMenuFocus(menu: HTMLElement, direction: 1 | -1): void {
  const items = Array.from(menu.querySelectorAll<HTMLElement>('button'));
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = at === -1
    ? (direction === 1 ? 0 : items.length - 1)
    : (at + direction + items.length) % items.length;
  items[next]?.focus();
}

/** Where focus goes when a menu opens from the keyboard: the current choice, else the first option. */
export function focusMenuChoice(menu: HTMLElement): void {
  const target =
    menu.querySelector<HTMLElement>('button[aria-checked="true"]') ?? menu.querySelector<HTMLElement>('button');
  target?.focus();
}
