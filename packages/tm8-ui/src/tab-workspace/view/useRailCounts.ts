/**
 * The rail's live counts (task 01a111a2-f9ad, design log R42). FOUR kinds and
 * no others:
 *
 *   task         ROOT tasks in the In Progress tier
 *   story        ROOT stories in the In Progress tier
 *   work_session EVERY live session in the space, children included
 *                (Subhang: "for sessions full count; running sessions")
 *   chat         ROOT chats whose turn is running
 *
 * EXACT, AND FROM THE SERVER. The browser's tier tab reads `page.total`, a
 * `count(*)` over the tab's own filter; this asks the same question with the
 * same filter (the kind's registry In Progress tab, so the two cannot drift)
 * plus `parentId: null`, which is the list's top level. `limit: 1` — only the
 * total is wanted. Sessions read the liveness snapshot's `liveSessionCount`,
 * the same both-truths verdict the tab strip's running dot and the list's
 * `● N live` come from. Chats have no turn-state filter, so the root chats are
 * read newest-activity first and their `state.turnState` counted; a running
 * turn is the most recent activity a chat has, so it sits on the first page.
 *
 * LIVE, WITHOUT A POLLING LOOP. Every durable event re-arms one coalesced
 * re-read (the same quiet/max-wait trigger the list totals use), and the
 * liveness cadence the seam already runs pushes session changes.
 *
 * `undefined` for a kind means "no answer" (not read yet, or no seam) and draws
 * nothing, exactly like 0.
 */
import { useEffect, useState } from 'react';
import type { CollectionQuery, EntitySummary } from '@tm8/contract';
import { getKind } from '../../domain';
import {
  EVENT_REFRESH_MAX_WAIT_MS,
  EVENT_REFRESH_QUIET_MS,
  createCoalescedTrigger,
} from '../../views/event-refresh';
import type { LivenessSnapshot, Seam } from '../../data/seam';
import { useWorkspace } from './context';

export const RAIL_COUNT_KINDS = ['task', 'story', 'work_session', 'chat'] as const;
export type RailCountKind = (typeof RAIL_COUNT_KINDS)[number];
export type RailCounts = Partial<Record<RailCountKind, number>>;

export function isRailCountKind(kind: string): kind is RailCountKind {
  return (RAIL_COUNT_KINDS as readonly string[]).includes(kind);
}

/** The words after the number: "Tasks · 4 in progress (top-level)". */
export const RAIL_COUNT_PHRASE: Record<RailCountKind, string> = {
  task: 'in progress (top-level)',
  story: 'in progress (top-level)',
  work_session: 'running',
  chat: 'running (top-level)',
};

/** Hidden at 0 (null), `99+` above 99. */
export function railCountLabel(n: number | undefined): string | null {
  if (n === undefined || n <= 0) return null;
  return n > 99 ? '99+' : String(n);
}

/** "Tasks · 4 in progress (top-level)", or the plain label at 0. */
export function railKindLabel(kind: string, labelPlural: string, n: number | undefined): string {
  const label = railCountLabel(n);
  return label && isRailCountKind(kind) ? `${labelPlural} · ${label} ${RAIL_COUNT_PHRASE[kind]}` : labelPlural;
}

/** The kind's own In Progress tab filter, so the rail and the tab agree. */
export function inProgressFilter(kind: string): NonNullable<CollectionQuery['filters']> {
  const tab = getKind(kind).list.categories?.find((t) => t.id === 'in_progress');
  return (tab?.filter as NonNullable<CollectionQuery['filters']> | undefined) ?? {
    category: ['in_progress'],
    deleted: 'exclude',
  };
}

/** Root chats read per probe; a running turn is newest activity, so page one holds them. */
export const CHAT_PROBE_LIMIT = 100;

export function isRunningChat(row: EntitySummary): boolean {
  const state = row.state as { turnState?: unknown } | undefined;
  return row.parentId == null && state?.turnState === 'running';
}

/** One read of the three query-backed counts. Failures leave a kind unanswered. */
export async function readRailCounts(seam: Seam, spaceId: string): Promise<RailCounts> {
  const total = (kind: 'task' | 'story') =>
    seam
      .query({
        spaceId,
        kinds: [kind],
        parentId: null,
        filters: inProgressFilter(kind),
        limit: 1,
      } as CollectionQuery)
      .then((result) => result.page.total)
      .catch(() => undefined);
  const chats = seam
    .query({
      spaceId,
      kinds: ['chat'],
      parentId: null,
      filters: { deleted: 'exclude' },
      sort: 'activityAt_desc',
      limit: CHAT_PROBE_LIMIT,
    } as CollectionQuery)
    .then((result) => result.page.items.filter(isRunningChat).length)
    .catch(() => undefined);
  const [task, story, chat] = await Promise.all([total('task'), total('story'), chats]);
  const out: RailCounts = {};
  if (task !== undefined) out.task = task;
  if (story !== undefined) out.story = story;
  if (chat !== undefined) out.chat = chat;
  return out;
}

/**
 * Both truths (PTY map AND recorded status) when the node sends the count; an
 * older node sends only the PTY map, which the server already scopes to this
 * space's work sessions.
 */
export function sessionCountOf(snapshot: LivenessSnapshot): number {
  return typeof snapshot.liveSessionCount === 'number' ? snapshot.liveSessionCount : snapshot.liveEntityIds.length;
}

export function useRailCounts(): RailCounts {
  const { gate } = useWorkspace();
  const data = (gate as { data?: { seam?: Seam; spaceId?: string } } | undefined)?.data;
  const seam = data?.seam;
  const spaceId = data?.spaceId;
  const [queried, setQueried] = useState<RailCounts>({});
  const [sessions, setSessions] = useState<number | undefined>(undefined);

  useEffect(() => {
    setQueried({});
    if (!seam || !spaceId) return undefined;
    let live = true;
    const trigger = createCoalescedTrigger({
      quietMs: EVENT_REFRESH_QUIET_MS,
      maxWaitMs: EVENT_REFRESH_MAX_WAIT_MS,
      run: async () => {
        const next = await readRailCounts(seam, spaceId);
        if (live) setQueried(next);
      },
    });
    void readRailCounts(seam, spaceId).then((next) => {
      if (live) setQueried(next);
    });
    const unsubscribe = seam.onEvent(() => trigger.note());
    return () => {
      live = false;
      trigger.dispose();
      unsubscribe();
    };
  }, [seam, spaceId]);

  useEffect(() => {
    setSessions(undefined);
    if (!seam || !spaceId) return undefined;
    let live = true;
    const unsubscribe = seam.liveness.onChange((snapshot) => {
      if (live && snapshot.spaceId === spaceId) setSessions(sessionCountOf(snapshot));
    });
    /* One read now, so the badge does not wait a whole cadence to appear. */
    void seam.liveness
      .refresh(spaceId as never)
      .then((snapshot) => {
        if (live) setSessions(sessionCountOf(snapshot));
      })
      .catch(() => undefined);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [seam, spaceId]);

  return sessions === undefined ? queried : { ...queried, work_session: sessions };
}
