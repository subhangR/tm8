/**
 * The shell → Work keyboard hand-off (task 01a113aa).
 *
 * The keyboard controller only EMITS commands; GateApp's sink owns the window.
 * The Work-only ones (tabs, drafts, the browser, the tab's controls) need the
 * mounted Work view, which installs its handler here while it is on screen.
 *
 * NOT MOUNTED: a command that makes sense from anywhere (`n t`, `l t`) is
 * QUEUED and the caller navigates to Work; the view drains the queue when it
 * installs — after its persistence restore, because a draft dispatched into a
 * pristine store would stop the viewer's own tabs from coming back.
 */
import type { KeyCommand } from '../keyboard';

export interface WorkKey {
  command: KeyCommand;
  ref?: string | undefined;
}

/** `true` ⇒ the Work view acted on it. */
export type WorkKeyHandler = (key: WorkKey) => boolean;

let handler: WorkKeyHandler | null = null;
let pending: WorkKey | null = null;

/** Hand a command to the mounted Work view. `false` ⇒ no view, or it declined. */
export function runWorkKey(key: WorkKey): boolean {
  return handler ? handler(key) : false;
}

/** Whether a Work view is mounted to take commands right now. */
export function workKeysMounted(): boolean {
  return handler !== null;
}

/** Hold one command for the next Work view to mount; a later one replaces it. */
export function queueWorkKey(key: WorkKey): void {
  pending = key;
}

/** Install the mounted view's handler and run any queued command. Returns the uninstall. */
export function installWorkKeys(next: WorkKeyHandler): () => void {
  handler = next;
  const queued = pending;
  pending = null;
  if (queued) next(queued);
  return () => {
    if (handler === next) handler = null;
  };
}
