/**
 * ONE DESIGN, LIVE: its read, its page edits and the "updated" marks, for the
 * design screen's page row and for a nested design's smaller row (the same
 * hook at both depths).
 *
 * LIVE BY EVENTS: a change to the design (a page added, moved, removed, a
 * rename) re-reads it; a change to one of its pages marks that page updated
 * unless it is the active one. Agents never switch the page (D5).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import { positionAt, type DesignPageRow, type DesignRead, type DesignSource, type NewPageKind } from './design-source';

export interface DesignHandle {
  design: DesignRead | null;
  state: 'loading' | 'ready' | 'error' | 'deleted';
  pages: readonly DesignPageRow[];
  updated: ReadonlySet<string>;
  retry(): void;
  /** Clear a page's updated mark (it was looked at). */
  seen(id: EntityId): void;
  createPage(kind: Exclude<NewPageKind, 'artifact'>): Promise<EntityId | null>;
  addExisting(id: EntityId): Promise<boolean>;
  move(id: EntityId, index: number): Promise<void>;
  remove(id: EntityId): Promise<boolean>;
}

/** The node's refusal for a design that would contain itself (lane A's cycle guard). */
function refusalText(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : '';
  if (code === '22023' || /contain itself|cycle|loop/i.test(message)) {
    return 'A design cannot contain itself, or a design it sits inside.';
  }
  return message || fallback;
}

export function useDesign(
  source: DesignSource,
  designId: EntityId,
  activeId: EntityId | null,
  onNotice?: (text: string) => void,
): DesignHandle {
  const [design, setDesign] = useState<DesignRead | null>(null);
  const [state, setState] = useState<DesignHandle['state']>('loading');
  const [updated, setUpdated] = useState<ReadonlySet<string>>(new Set());
  const [attempt, setAttempt] = useState(0);
  const pageIdsRef = useRef<ReadonlySet<string>>(new Set());
  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  const read = useCallback(async () => {
    try {
      const next = await source.read(designId);
      pageIdsRef.current = new Set(next.pages.map((page) => page.id));
      setDesign(next);
      setState('ready');
    } catch (error) {
      setState((error as { code?: unknown } | null)?.code === 'not_found' ? 'deleted' : 'error');
    }
  }, [source, designId]);

  useEffect(() => {
    setDesign(null);
    setState('loading');
    setUpdated(new Set());
    void read();
  }, [read, attempt]);

  useEffect(
    () =>
      source.subscribe(designId, () => pageIdsRef.current, (change) => {
        if (change.type === 'design') void read();
        else if (change.type === 'deleted') {
          if (change.id === designId) setState('deleted');
          else void read();
        } else {
          /* The page re-renders itself; the design's row learns its new title. */
          void read();
          if (change.id !== activeRef.current) {
            setUpdated((current) => (current.has(change.id) ? current : new Set(current).add(change.id)));
          }
        }
      }),
    [source, designId, read],
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

  const pages = useMemo(() => design?.pages ?? [], [design]);

  const createPage = useCallback(
    async (kind: Exclude<NewPageKind, 'artifact'>) => {
      try {
        const id = await source.createPage(designId, kind, positionAt(pages, pages.length));
        await read();
        return id;
      } catch (error) {
        onNotice?.(refusalText(error, 'Could not add the page.'));
        return null;
      }
    },
    [source, designId, pages, read, onNotice],
  );

  const addExisting = useCallback(
    async (id: EntityId) => {
      try {
        await source.placePage(designId, id, positionAt(pages, pages.length));
        await read();
        return true;
      } catch (error) {
        onNotice?.(refusalText(error, 'Could not add that entity as a page.'));
        return false;
      }
    },
    [source, designId, pages, read, onNotice],
  );

  const move = useCallback(
    async (id: EntityId, index: number) => {
      const moving = pages.find((page) => page.id === id);
      if (!moving) return;
      const without = pages.filter((page) => page.id !== id);
      const position = positionAt(without, index);
      /* Optimistic: the row shows the new order now; the re-read confirms it. */
      setDesign((current) =>
        current
          ? { ...current, pages: [...without.slice(0, index), { ...moving, position }, ...without.slice(index)] }
          : current,
      );
      try {
        await source.placePage(designId, id, position);
      } catch (error) {
        onNotice?.(refusalText(error, 'Could not move the page.'));
      }
      await read();
    },
    [source, designId, pages, read, onNotice],
  );

  const remove = useCallback(
    async (id: EntityId) => {
      try {
        await source.removePage(designId, id);
        await read();
        return true;
      } catch (error) {
        onNotice?.(refusalText(error, 'Could not remove the page.'));
        return false;
      }
    },
    [source, designId, read, onNotice],
  );

  return {
    design,
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
