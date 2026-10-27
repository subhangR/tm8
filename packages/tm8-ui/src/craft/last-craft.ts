/**
 * THE LAST CRAFT (Subhang 2026-10-18): Craft on the rail reopens the craft —
 * and its page — you were last in, per space, per device. Nothing remembered
 * (or the craft is gone) ⇒ the full-screen Crafts home.
 *
 * Kept in localStorage keyed by node AND space, like the open-craft tabs
 * (`craft-open-tabs.ts`). Visiting the bare home clears it: the rail lands
 * where you left Craft, home included.
 */
import type { EntityId } from '@tm8/contract';

const KEY_PREFIX = 'tm8.craft-last.v1';

export interface LastCraft {
  craftId: EntityId;
  pageId?: EntityId | undefined;
}

export function lastCraftKey(nodeKey: string, spaceId: string): string {
  return `${KEY_PREFIX}.${nodeKey}.${spaceId}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readLastCraft(key: string): LastCraft | null {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as { craftId?: unknown; pageId?: unknown };
    if (typeof value.craftId !== 'string' || !value.craftId) return null;
    return {
      craftId: value.craftId as EntityId,
      ...(typeof value.pageId === 'string' && value.pageId ? { pageId: value.pageId as EntityId } : {}),
    };
  } catch {
    return null;
  }
}

/** `null` forgets it (the home was the last place, or the craft is gone). */
export function writeLastCraft(key: string, last: LastCraft | null): void {
  try {
    const store = storage();
    if (!store) return;
    if (!last) store.removeItem(key);
    else store.setItem(key, JSON.stringify(last.pageId ? { craftId: last.craftId, pageId: last.pageId } : { craftId: last.craftId }));
  } catch {
    /* A full or blocked store only loses the memory, never the navigation. */
  }
}
