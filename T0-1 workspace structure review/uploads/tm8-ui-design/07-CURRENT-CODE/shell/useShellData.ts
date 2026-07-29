/**
 * Shell data hooks — the only facade reads the shell chrome performs.
 *
 * The rails are data-driven: spaces from `listSpaces`, the space name / channel
 * tree / unread totals / viewer from `getNavigation`, section badges from
 * counting collection queries. Everything refetches when a WorkspaceEvent that
 * could move those numbers arrives, so unread dots stay live under the
 * simulation without the shell duplicating store state.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CollabFacade } from '../facade/CollabFacade';
import type { ViewName } from '../stores/nav';
import type { SpaceId, SpaceNavigation, SpaceSummary, WorkspaceEvent } from '../types/contract';

export interface AsyncValue<T> { value: T | null; loading: boolean; error: Error | null; reload: () => void }

export function useAsyncValue<T>(load: (() => Promise<T>) | null, deps: unknown[]): AsyncValue<T> {
  const [value, setValue] = useState<T | null>(null);
  const [loading, setLoading] = useState(load != null);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!load) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    load().then(
      (v) => { if (alive) { setValue(v); setError(null); setLoading(false); } },
      (e: unknown) => { if (alive) { setError(e as Error); setLoading(false); } },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { value, loading, error, reload };
}

/** Refetch trigger: bumps whenever an event matching `matches` lands. */
function useEventNonce(
  facade: CollabFacade,
  spaceId: SpaceId | null,
  matches: (e: WorkspaceEvent) => boolean,
): number {
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!spaceId) return;
    return facade.subscribe(spaceId, (event) => {
      if (matches(event)) setNonce((n) => n + 1);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facade, spaceId]);
  return nonce;
}

const NAV_EVENTS = (e: WorkspaceEvent): boolean =>
  e.type === 'message.created'
  || e.type === 'message.deleted'
  || e.type === 'notification.created'
  || e.type === 'notification.read'
  || (e.type === 'entity.upsert' && e.entity.kind === 'channel') // registry-purity: allow — event refetch filter (rail tree scope), not behavior branching
  || e.type === 'counter.changed';

export function useSpaces(facade: CollabFacade): AsyncValue<SpaceSummary[]> {
  return useAsyncValue(() => facade.listSpaces(), [facade]);
}

export function useSpaceNavigation(facade: CollabFacade, spaceId: SpaceId | null): AsyncValue<SpaceNavigation> {
  const nonce = useEventNonce(facade, spaceId, NAV_EVENTS);
  return useAsyncValue(
    spaceId ? () => facade.getNavigation(spaceId) : null,
    [facade, spaceId, nonce],
  );
}

/**
 * Left-rail section badges. Each section is conceptually a saved collection
 * view, so its badge is just that query's total — no bespoke endpoints.
 */
export const SECTION_QUERIES: Partial<Record<ViewName, { kinds: Array<'task' | 'doc' | 'member' | 'team_member' | 'pull_request'> }>> = {
  tasks: { kinds: ['task'] },
  docs: { kinds: ['doc'] },
  team: { kinds: ['member', 'team_member'] },
  tracking: { kinds: ['pull_request'] },
};

export function useSectionCounts(facade: CollabFacade, spaceId: SpaceId | null): Partial<Record<ViewName, number>> {
  const nonce = useEventNonce(facade, spaceId, (e) => e.type === 'entity.upsert' || e.type === 'entity.deleted');
  const entries = useMemo(() => Object.entries(SECTION_QUERIES) as Array<[ViewName, { kinds: Array<'task' | 'doc' | 'member' | 'team_member' | 'pull_request'> }]>, []);
  const load = useCallback(async (): Promise<Partial<Record<ViewName, number>>> => {
    if (!spaceId) return {};
    const results = await Promise.all(entries.map(async ([view, q]) => {
      const res = await facade.queryCollection({ spaceId, kinds: q.kinds, limit: 1 });
      return [view, res.page.total ?? res.page.items.length] as const;
    }));
    return Object.fromEntries(results) as Partial<Record<ViewName, number>>;
  }, [facade, spaceId, entries]);

  const { value } = useAsyncValue(spaceId ? load : null, [load, nonce]);
  return value ?? {};
}

/** Unread notification count backing the Inbox dot on the icon rail. */
export function useUnreadInbox(facade: CollabFacade, spaceId: SpaceId | null): number {
  const nonce = useEventNonce(facade, spaceId, (e) => e.type === 'notification.created' || e.type === 'notification.read');
  const { value } = useAsyncValue(() => facade.getInbox(), [facade, nonce]);
  return (value?.items ?? []).filter((n) => n.readAt == null).length;
}
