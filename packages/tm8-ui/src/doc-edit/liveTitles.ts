/**
 * TITLES BEING TYPED, BEFORE THEY ARE SAVED (Subhang, 2026-10-07: "tab
 * reflects the title").
 *
 * The tab strip reads an entity's title from the store, which only learns it
 * once autosave lands, a beat after the person stopped typing. `useDocSave`
 * publishes the draft title here as it changes and withdraws it once the save
 * settles (by then the store holds it), so the tab follows the keystrokes.
 */
import { useSyncExternalStore } from 'react';

const titles = new Map<string, string>();
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

export function setLiveTitle(id: string, title: string): void {
  if (titles.get(id) === title) return;
  titles.set(id, title);
  notify();
}

export function clearLiveTitle(id: string): void {
  if (titles.delete(id)) notify();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The title being typed for `id`, or undefined when nothing unsaved is. */
export function useLiveTitle(id: string | null): string | undefined {
  return useSyncExternalStore(subscribe, () => (id === null ? undefined : titles.get(id)));
}
