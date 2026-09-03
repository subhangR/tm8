/**
 * useHomeData — the three reads Home needs that no existing hook already does,
 * and nothing else.
 *
 * `useGateData` is the app's one seam consumer and it is NOT MINE TO EDIT
 * (src/views is another lane's, and the wiring seat is the coordinator's), so
 * Home takes a NARROW STRUCTURAL PORT that `GateData` already satisfies and
 * performs its own three reads through the seam object that port hands it:
 *
 *   · `identity()` — who "me" is, which is what makes "assignee = me" a real
 *     filter rather than a guess. Until it resolves, the sections that depend
 *     on it say so (never a confident zero).
 *   · `inbox()`    — the MENTIONS & ASSIGNMENTS rows. Resolving `[]` and
 *     failing to resolve are kept apart all the way to the copy.
 *   · `onEvent()`  — the durable stream that IS the activity column.
 *
 * Everything else Home draws comes from the port: `rowsFor` (the seam's own
 * cached queries, filter and all — D57.1's lesson is that the filter must
 * actually reach the seam, and this hook passes one), `liveIds`, and
 * `livenessOf`, which is THE verdict and is never recomputed here.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EntitySummary, NotificationItem } from '@tm8/contract';
import type { Seam, SessionLiveness } from '../data/seam';
import { getKind, HOME_CHAT_KIND } from '../domain';
import { activityRowOf, appendActivity, type ActivityRow } from './home-activity';
import { assignableKinds, liveKinds } from './home-model';

/**
 * The port. Deliberately narrower than `GateData` — it names exactly what this
 * screen consumes, so the wiring can be type-checked without Home importing
 * upward into `views/`.
 */
export interface HomeScreenData {
  spaceId: string;
  /**
   * `home` joins the narrow port so Home can read its own CHAT THREADS.
   *
   * It has to. The owner removed the middle column (2026-08-30) and that column
   * was the ONLY way to pick a conversation — so the list that replaces it must
   * carry chats, and a list cannot carry what the port cannot read. `GateData`
   * already satisfies this structurally; nothing new is fetched that the chat
   * surface was not already fetching.
   */
  seam: Pick<Seam, 'identity' | 'inbox' | 'onEvent'> & Partial<Pick<Seam, 'home' | 'query'>>;
  /** Verbatim from the seam snapshot — the ONLY source for a live count. */
  liveIds: readonly string[];
  /** THE verdict (R-UI-5). Never derived in this directory. */
  livenessOf: (id: string) => SessionLiveness;
  /** Per-(kind, filter) rows; a miss hydrates on demand and returns [] meanwhile. */
  rowsFor: (kind: string) => (filter?: unknown) => readonly EntitySummary[];
  /** §9.2 pool byte-activity — NEVER liveness. */
  activity: Readonly<Record<string, boolean>>;
}

export interface HomeViewer {
  /** The member entity id inside THIS space — what `assigneeIds` matches on. */
  memberId: string | null;
  username: string;
  displayName: string;
}

export interface HomeData {
  viewer: HomeViewer | null;
  viewerError: string | null;
  notifications: readonly NotificationItem[] | null;
  notificationsError: string | null;
  activityRows: readonly ActivityRow[];
  /** Rows for the live-shaped kinds, unfiltered. */
  sessionPool: readonly EntitySummary[];
  /** assignee = me. Empty (not wrong) until `viewer` resolves. */
  myTasks: readonly EntitySummary[];
  /** assignee = me, in the registry's review status. */
  myReview: readonly EntitySummary[];
  /** Conversations in this space. NULL = not answered yet; [] = none. */
  chatThreads: readonly ChatThreadLite[] | null;
}

/**
 * THE MINIMUM A CHAT ROW NEEDS, and nothing more.
 *
 * The seam's thread objects are wider than this. Naming only what the strip
 * draws keeps Home from growing a dependency on fields it does not render —
 * the same reason `ListRowFacts` is deliberately narrow next door.
 */
export interface ChatThreadLite {
  id: string;
  title?: string | null;
  activityAt?: string | null;
  messageCount?: number | null;
}

/**
 * THE CONTRACT'S NAMES ARE NOT THIS SCREEN'S NAMES, AND THE TRANSLATION HAS TO
 * BE WRITTEN DOWN.
 *
 * This was `snapshot as { chatThreads?: ChatThreadLite[] }` — a cast asserting
 * that the contract's threads already had `id`, `activityAt` and
 * `messageCount`. They have none of the three. `ChatThreadSummary` carries
 * `rootMessageId`, `lastReplyAt`/`createdAt` and `replyCount`, so every chat
 * row reached the strip with `id === undefined`, which:
 *
 *   - collapsed sixty threads onto ONE React key (`chats-undefined`), so the
 *     top-ten split seated one chat and every other chat rode in on its key —
 *     sixty-three cards where ten were asked for, and no tail at all;
 *   - made `onOpen(row.id)` a no-op, so a chat card was never clickable;
 *   - left every chat with no time, which the screen drew as a blank rather
 *     than as the wrong field it was.
 *
 * A cast is an assertion the compiler is told not to check. This one was
 * wrong in three fields at once and nothing said so — which is the argument
 * for mapping explicitly rather than asserting.
 */
/*
 * 176 REPAIR ONLY. `HomeSnapshot.chatThreads` and `ChatThreadSummary` are gone
 * with the chat-thread model: a chat is an entity, and the list is
 * `entities.list kind=chat` like every other list. This maps the ordinary
 * `EntitySummary` that read returns, which is why the three fields the note
 * above is about are now simply the row's own — `id`, `activityAt`, and the
 * turn count off the chat state.
 *
 * NO FEATURE WORK HERE, by ruling (R-D, 2026-09-02: this tree is experimental
 * and tm8-ui is canonical). This exists because the root typecheck compiles
 * this package, and a mechanical repair is the smallest honest answer to that.
 */
export function chatRowOf(chat: EntitySummary): ChatThreadLite {
  return {
    id: chat.id,
    title: chat.title || null,
    activityAt: chat.activityAt,
    messageCount: chat.state?.kind === HOME_CHAT_KIND ? chat.state.turnCount : null,
  };
}

/**
 * The review status Home treats as "waiting on you".
 *
 * NOT a literal typed here: it is read out of the REGISTRY — the one status
 * value an assignable kind tones as `wait`, which is precisely what "amber,
 * waiting" means in this design system. If a future registry retones the ramp
 * this follows it; if a kind gains a second waiting status, both are used.
 */
export function reviewStatusValues(): string[] {
  const out = new Set<string>();
  for (const kind of assignableKinds()) {
    const tones = kind.panel.statusPill?.tones ?? {};
    for (const [value, tone] of Object.entries(tones)) if (tone === 'wait') out.add(value);
  }
  return [...out];
}

export function useHomeData(data: HomeScreenData): HomeData {
  const { seam, spaceId } = data;

  const [viewer, setViewer] = useState<HomeViewer | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<readonly NotificationItem[] | null>(null);
  const [notificationsError, setNotificationsError] = useState<string | null>(null);
  const [activityRows, setActivityRows] = useState<readonly ActivityRow[]>([]);
  /** NULL until the read answers — distinct from `[]`, which means "answered,
      and there are none". A list that cannot tell those apart draws "no chats"
      at the moment it knows nothing. */
  const [chatThreads, setChatThreads] = useState<readonly ChatThreadLite[] | null>(null);

  // -- identity -------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void seam
      .identity()
      .then((identity) => {
        if (cancelled) return;
        const membership = identity.memberships.find((m) => m.spaceId === spaceId);
        setViewer({
          // No membership in THIS space ⇒ no member id to filter on. Null is
          // the honest value; the sections read it and say so rather than
          // filtering on an id from a different space.
          memberId: membership?.memberId ?? null,
          username: identity.username,
          displayName: identity.displayName ?? identity.username,
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) setViewerError(messageOf(error));
      });
    return () => {
      cancelled = true;
    };
  }, [seam, spaceId]);

  // -- chat threads ---------------------------------------------------------
  // The same `spaces.home` read the chat surface makes. A failure leaves the
  // list at NULL rather than empty: the strip then says nothing instead of
  // claiming the space has no conversations.
  useEffect(() => {
    /* OPTIONAL ON THE PORT, ON PURPOSE. A host that does not serve the read is
       not broken — it is a host without conversations, and Home renders the
       rest of itself rather than throwing. 176 moved the read from `seam.home`
       (whose `chatThreads` projection is deleted) to the ordinary entity list,
       and the optionality rule is unchanged. */
    const read = seam.query;
    if (typeof read !== 'function') { setChatThreads(null); return; }
    let cancelled = false;
    void read({ spaceId, kinds: [HOME_CHAT_KIND], sort: 'activityAt_desc', limit: 50 })
      .then((result) => {
        if (cancelled) return;
        setChatThreads(result.page.items.map(chatRowOf));
      })
      .catch(() => {
        if (!cancelled) setChatThreads(null);
      });
    return () => {
      cancelled = true;
    };
  }, [seam, spaceId]);

  // -- inbox ----------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void seam
      .inbox()
      .then((page) => {
        if (!cancelled) setNotifications(page.items);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // An empty array would claim "no mentions". The error is held instead,
        // and the section renders the failure — the boot-error precedent.
        setNotificationsError(messageOf(error));
      });
    return () => {
      cancelled = true;
    };
  }, [seam]);

  // -- the activity stream --------------------------------------------------
  useEffect(() => {
    return seam.onEvent((event) => {
      const row = activityRowOf(event);
      if (row) setActivityRows((current) => appendActivity(current, row));
    });
  }, [seam]);

  // -- rows through the port's own cached queries ---------------------------
  //
  // ONE query per live-shaped kind and per assignable kind, not one per kind in
  // the registry: which kinds those are is a registry CAPABILITY question
  // (`home-model`), so no kind is named here and no kind is queried needlessly.
  const sessionKinds = useMemo(() => liveKinds().map((k) => k.kind), []);
  const taskKinds = useMemo(() => assignableKinds().map((k) => k.kind), []);
  const reviewValues = useMemo(() => reviewStatusValues(), []);

  const sessionPool = sessionKinds.flatMap((kind) => [...data.rowsFor(kind)(undefined)]);

  const me = viewer?.memberId ?? null;
  // THE FILTER REACHES THE SEAM (D57.1). `rowsFor(kind)(filter)` keys its cache
  // per (kind, filter) and the miss issues a real query carrying `filters` —
  // this is not a client-side narrowing of an already-fetched array.
  const myTasks = me
    ? taskKinds.flatMap((kind) => [...data.rowsFor(kind)({ assigneeIds: [me] })])
    : [];
  const myReview =
    me && reviewValues.length > 0
      ? taskKinds.flatMap((kind) => [
          ...data.rowsFor(kind)({ assigneeIds: [me], status: reviewValues }),
        ])
      : [];

  return {
    viewer,
    viewerError,
    notifications,
    notificationsError,
    activityRows,
    sessionPool,
    myTasks,
    myReview,
    chatThreads,
  };
}

function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const shaped = error as { code?: unknown; message?: unknown };
    if (typeof shaped.message === 'string') return shaped.message;
    if (typeof shaped.code === 'string') return shaped.code;
  }
  return String(error);
}
