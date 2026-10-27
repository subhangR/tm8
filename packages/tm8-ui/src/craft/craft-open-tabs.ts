/**
 * THE OPEN-CRAFT TABS — which crafts THIS viewer has open in the Craft top bar
 * (`[Home | craft 1 | craft 2 …]`, owner decisions doc 01a1255d §3), in the
 * order they opened them.
 *
 * Crafts are shared in the space; the tab row is not. Opening a craft adds a
 * tab, closing one drops it, and neither ever touches the craft itself.
 *
 * WHERE THIS LIVES. On the node: the per-user craft-workspace rows (lane L3)
 * carry `open` and `position`, so the row follows the viewer across devices
 * (`serverOpenCraftsPort`). A seam without those ops (fixtures, an older node)
 * falls back to localStorage keyed by node, space AND viewer
 * (`localOpenCraftsPort`): it survives a reload but is per browser.
 *
 * AN ID IS NOT A TAB. Only ids are stored; the bar draws a tab for an id only
 * when that craft is still in the space's list, so a deleted craft cannot be
 * resurrected by having once been open.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CraftWorkspace } from '@tm8/contract';
import type { CraftWorkspacesPort } from '../data/seam';

const VERSION = 'v1';
const KEY_PREFIX = `tm8.craft-open-tabs.${VERSION}`;
/** A bound, not a feature: localStorage is a shared origin budget. */
export const MAX_OPEN_CRAFTS = 30;

export function craftTabsKey(nodeKey: string, spaceId: string, viewerId: string): string {
  return `${KEY_PREFIX}.${nodeKey}.${spaceId}.${viewerId}`;
}

/** Every access is guarded: private mode throws on write, a policy throws on read. */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Dedupe (first wins), drop junk, cap. */
function normalise(ids: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id === '' || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_OPEN_CRAFTS) break;
  }
  return out;
}

export function readOpenCrafts(key: string): string[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { ids?: unknown };
    return Array.isArray(parsed?.ids) ? normalise(parsed.ids) : [];
  } catch {
    try {
      store.removeItem(key);
    } catch {
      /* nothing further to do */
    }
    return [];
  }
}

function writeOpenCrafts(key: string, ids: readonly string[]): void {
  try {
    storage()?.setItem(key, JSON.stringify({ ids }));
  } catch {
    /* quota or policy: the row still works for this page's life */
  }
}

/** Open a tab: appended at the end, a no-op when already open. */
export function withOpened(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? [...ids] : normalise([...ids, id]);
}

/** Close a tab. */
export function withClosed(ids: readonly string[], id: string): string[] {
  return ids.filter((open) => open !== id);
}

/**
 * Where the selection goes when the selected tab closes: the tab to its
 * right, else to its left, else Home (`null`).
 */
export function neighbourAfterClose(ids: readonly string[], id: string): string | null {
  const at = ids.indexOf(id);
  if (at < 0) return null;
  return ids[at + 1] ?? ids[at - 1] ?? null;
}

/** Sweep every viewer's rows on this node — explicit sign-out only. */
export function clearCraftOpenTabs(nodeKey: string): void {
  const store = storage();
  if (!store) return;
  try {
    const prefix = `${KEY_PREFIX}.${nodeKey}.`;
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key !== null && key.startsWith(prefix)) doomed.push(key);
    }
    for (const key of doomed) store.removeItem(key);
  } catch {
    /* storage refused: nothing stored, nothing to forget */
  }
}

/**
 * Where the open-craft ids are kept. The bar is written against this port so
 * the backing store is one adapter: `localOpenCraftsPort` today, the per-user
 * craft-workspace rows (lane L3: `craft.open` / `craft.close` and the
 * `craft.workspaces` push) once they land.
 */
export interface OpenCraftsPort {
  /** The open ids, in tab order. */
  read(): Promise<readonly string[]>;
  open(craftId: string): Promise<void>;
  close(craftId: string): Promise<void>;
  /** Called with the new order whenever another window or an agent changes it. */
  subscribe(onChange: (ids: readonly string[]) => void): () => void;
}

/** The localStorage port, kept in step with this viewer's other windows by the `storage` event. */
export function localOpenCraftsPort(key: string): OpenCraftsPort {
  return {
    read: async () => readOpenCrafts(key),
    open: async (id) => writeOpenCrafts(key, withOpened(readOpenCrafts(key), id)),
    close: async (id) => writeOpenCrafts(key, withClosed(readOpenCrafts(key), id)),
    subscribe(onChange) {
      const onStorage = (event: StorageEvent) => {
        if (event.key === key) onChange(readOpenCrafts(key));
      };
      window.addEventListener('storage', onStorage);
      return () => window.removeEventListener('storage', onStorage);
    },
  };
}

/** The top bar's ids from the craft-workspace rows: the open ones, in position order. */
export function openIdsOf(items: readonly CraftWorkspace[]): string[] {
  return items
    .filter((item) => item.open)
    .sort((a, b) => a.position - b.position)
    .map((item) => item.craftId);
}

function requestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `crafttabs:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The server port (lane L3): per user and across devices. The open list is the
 * craft-workspace rows' `open` / `position`; `craft.open` / `craft.close` move
 * it, and every window of this identity hears the `craft.workspaces` push.
 */
export function serverOpenCraftsPort(port: CraftWorkspacesPort, spaceId: string): OpenCraftsPort {
  const run = async (craftId: string, command: 'craft.open' | 'craft.close') => {
    await port.command(spaceId, craftId, { requestId: requestId(), command, args: {} });
  };
  return {
    read: async () => openIdsOf((await port.list(spaceId)).items),
    open: (craftId) => run(craftId, 'craft.open'),
    close: (craftId) => run(craftId, 'craft.close'),
    subscribe: (onChange) =>
      port.onPush((frame) => {
        if (frame.spaceId === spaceId && frame.type === 'craft.workspaces') onChange(openIdsOf(frame.items));
      }),
  };
}

export interface OpenCraftTabs {
  ids: readonly string[];
  open(id: string): void;
  close(id: string): void;
}

/**
 * The viewer's open-craft ids. A press moves the row at once; the port's
 * answer (or its next push) is the truth after that.
 */
export function useOpenCraftTabs(port: OpenCraftsPort | null): OpenCraftTabs {
  const [ids, setIds] = useState<readonly string[]>([]);
  /* The presses made while the first read is in flight: replayed on top of
     its answer, so a tab opened on mount is not wiped by a read that started
     before it. `null` once the read has landed. */
  const pending = useRef<{ op: 'open' | 'close'; id: string }[] | null>(null);
  useEffect(() => {
    setIds([]);
    if (!port) return;
    let live = true;
    pending.current = [];
    port.read().then(
      (now) => {
        if (!live) return;
        const presses = pending.current ?? [];
        pending.current = null;
        setIds(presses.reduce((acc, p) => (p.op === 'open' ? withOpened(acc, p.id) : withClosed(acc, p.id)), [...now]));
      },
      () => {
        if (live) pending.current = null;
      },
    );
    const off = port.subscribe((now) => live && setIds(now));
    return () => {
      live = false;
      off();
    };
  }, [port]);
  const open = useCallback(
    (id: string) => {
      pending.current?.push({ op: 'open', id });
      setIds((was) => (was.includes(id) ? was : withOpened(was, id)));
      void port?.open(id).catch(() => undefined);
    },
    [port],
  );
  const close = useCallback(
    (id: string) => {
      pending.current?.push({ op: 'close', id });
      setIds((was) => (was.includes(id) ? withClosed(was, id) : was));
      void port?.close(id).catch(() => undefined);
    },
    [port],
  );
  return { ids, open, close };
}
