/**
 * ONE CRAFT, LIVE: its read, its page edits and the "updated" marks, for the
 * craft screen's page row and for a nested craft's smaller row (the same
 * hook at both depths).
 *
 * LIVE BY EVENTS: a change to the craft (a page added, moved, removed, a
 * rename) re-reads it; a change to one of its pages marks that page updated
 * unless it is the active one. Agents never switch the page (D5).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import { positionAt, type CraftPageRow, type CraftRead, type CraftSource, type NewPageKind } from './craft-source';

export interface CraftHandle {
  craft: CraftRead | null;
  state: 'loading' | 'ready' | 'error' | 'deleted';
  pages: readonly CraftPageRow[];
  updated: ReadonlySet<string>;
  retry(): void;
  /** Clear a page's updated mark (it was looked at). */
  seen(id: EntityId): void;
  createPage(kind: Exclude<NewPageKind, 'artifact'>): Promise<EntityId | null>;
  addExisting(id: EntityId): Promise<boolean>;
  move(id: EntityId, index: number): Promise<void>;
  remove(id: EntityId): Promise<boolean>;
}

/** The node's refusal for a craft that would contain itself (lane A's cycle guard). */
function refusalText(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : '';
  if (code === '22023' || /contain itself|cycle|loop/i.test(message)) {
    return 'A craft cannot contain itself, or a craft it sits inside.';
  }
  return message || fallback;
}

export function useCraft(
  source: CraftSource,
  craftId: EntityId,
  activeId: EntityId | null,
  onNotice?: (text: string) => void,
): CraftHandle {
  const [craft, setCraft] = useState<CraftRead | null>(null);
  const [state, setState] = useState<CraftHandle['state']>('loading');
  const [updated, setUpdated] = useState<ReadonlySet<string>>(new Set());
  const [attempt, setAttempt] = useState(0);
  const pageIdsRef = useRef<ReadonlySet<string>>(new Set());
  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  const read = useCallback(async () => {
    try {
      const next = await source.read(craftId);
      pageIdsRef.current = new Set(next.pages.map((page) => page.id));
      setCraft(next);
      setState('ready');
    } catch (error) {
      setState((error as { code?: unknown } | null)?.code === 'not_found' ? 'deleted' : 'error');
    }
  }, [source, craftId]);

  useEffect(() => {
    setCraft(null);
    setState('loading');
    setUpdated(new Set());
    void read();
  }, [read, attempt]);

  useEffect(
    () =>
      source.subscribe(craftId, () => pageIdsRef.current, (change) => {
        if (change.type === 'craft') void read();
        else if (change.type === 'deleted') {
          if (change.id === craftId) setState('deleted');
          else void read();
        } else {
          /* The page re-renders itself; the craft's row learns its new title. */
          void read();
          if (change.id !== activeRef.current) {
            setUpdated((current) => (current.has(change.id) ? current : new Set(current).add(change.id)));
          }
        }
      }),
    [source, craftId, read],
  );

  const seen = useCallback((id: EntityId) => {
    setUpdated((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);
  useEffect(() => {
    if (activeId) seen(activeId);
  }, [activeId, seen]);

  const pages = useMemo(() => craft?.pages ?? [], [craft]);

  const createPage = useCallback(
    async (kind: Exclude<NewPageKind, 'artifact'>) => {
      try {
        const id = await source.createPage(craftId, kind, positionAt(pages, pages.length));
        await read();
        return id;
      } catch (error) {
        onNotice?.(refusalText(error, 'Could not add the page.'));
        return null;
      }
    },
    [source, craftId, pages, read, onNotice],
  );

  const addExisting = useCallback(
    async (id: EntityId) => {
      try {
        await source.placePage(craftId, id, positionAt(pages, pages.length));
        await read();
        return true;
      } catch (error) {
        onNotice?.(refusalText(error, 'Could not add that entity as a page.'));
        return false;
      }
    },
    [source, craftId, pages, read, onNotice],
  );

  const move = useCallback(
    async (id: EntityId, index: number) => {
      const moving = pages.find((page) => page.id === id);
      if (!moving) return;
      const without = pages.filter((page) => page.id !== id);
      const position = positionAt(without, index);
      /* Optimistic: the row shows the new order now; the re-read confirms it. */
      setCraft((current) =>
        current
          ? { ...current, pages: [...without.slice(0, index), { ...moving, position }, ...without.slice(index)] }
          : current,
      );
      try {
        await source.placePage(craftId, id, position);
      } catch (error) {
        onNotice?.(refusalText(error, 'Could not move the page.'));
      }
      await read();
    },
    [source, craftId, pages, read, onNotice],
  );

  const remove = useCallback(
    async (id: EntityId) => {
      try {
        await source.removePage(craftId, id);
        await read();
        return true;
      } catch (error) {
        onNotice?.(refusalText(error, 'Could not remove the page.'));
        return false;
      }
    },
    [source, craftId, read, onNotice],
  );

  return {
    craft,
    state,
    pages,
    updated,
    retry: () => setAttempt((n) => n + 1),
    seen,
    createPage,
    addExisting,
    move,
    remove,
  };
}
