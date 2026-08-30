/**
 * THE HOME DASHBOARD SEAM — what Home may say about chats, and when.
 *
 * Home is being restructured from a TAXONOMY ("what kinds of thing exist here")
 * into a DASHBOARD ("what is happening, and what can I do"). Two of the three
 * dashboard categories are network reads, so on every load there is a window in
 * which the screen knows nothing at all. This module exists so that window
 * cannot be rendered as a fact.
 *
 * THE BUG THIS PREVENTS ALREADY SHIPPED ONCE, one surface over. The composer
 * derived "No agent teammate is available in this space." from `teammateId ===
 * ''` — that is, from THE INITIAL VALUE OF A STATE ARRAY. An array nobody has
 * filled yet and an array that came back empty are indistinguishable that way,
 * so the initial value was rendered as an assertion about the space, for the
 * whole opening read, in a space with 34 teammates.
 *
 * On Home the same mistake is worse than it was in the composer. "You haven't
 * created anything yet" during a read tells the viewer their workspace is
 * empty, which is the complaint this whole pass is answering — and it is the
 * first thing on screen.
 *
 * SO: PENDING, FAILED AND LOADED-EMPTY ARE THREE DIFFERENT FACTS. "Nothing
 * here yet" is a CLAIM, and a caller may only make it after a read that
 * actually came back empty. `items` is empty in all three states; only
 * `status` distinguishes them, and a caller that branches on `items.length`
 * alone has reintroduced the defect.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SpaceId } from '@tm8/contract';

import type { ChatHomePort, ChatThreadSummary } from './types';

/** PENDING is not a kind of empty. See the file docblock. */
export type HomeRegionStatus = 'pending' | 'failed' | 'loaded';

const NOTHING: readonly never[] = [];

/**
 * A read whose answer is KEYED TO THE (port, spaceId) THAT PRODUCED IT.
 *
 * Holding the key beside the value is what makes a prop change turn the answer
 * pending DURING RENDER. A passive effect is too late: the surface paints
 * before effects run, so on a space switch the previous space's rows would be
 * shown, briefly, as though they belonged to the new one — a stale answer being
 * strictly worse than a spinner, because it is wrong rather than absent.
 *
 * STATUS AND VALUE ARE ONE STATE OBJECT, deliberately. The composer's version
 * wrote options first and the `loaded` marker second, and depended on that
 * ORDER for correctness. Here they cannot be observed apart at all, so the
 * guarantee is structural rather than a convention the next editor must know.
 */
interface KeyedRead<T> {
  port: ChatHomePort;
  spaceId: SpaceId | string;
  status: Exclude<HomeRegionStatus, 'pending'>;
  value: readonly T[];
}

export interface HomeRegion<T> {
  status: HomeRegionStatus;
  /** Empty in ALL THREE states. Never branch on this alone — branch on `status`. */
  items: readonly T[];
}

/**
 * Run one space-scoped read and report it as three states.
 *
 * `read` IS HELD IN A REF AND IS DELIBERATELY NOT AN EFFECT DEPENDENCY. Callers
 * pass inline arrows; an inline arrow is a new identity every render, so
 * depending on it would re-fire the read on every render and never settle. The
 * read is keyed by what it is ABOUT — the port and the space — not by the
 * identity of the closure that performs it.
 *
 * `port` may safely be an effect dependency: `ChatHomeSurface` memoises it on
 * `[bridge, seam]`, which is the identity the existing chat read already
 * depends on, so this adds no new stability requirement to any host.
 */
export function useKeyedRead<T>(
  port: ChatHomePort,
  spaceId: SpaceId | string,
  read: (port: ChatHomePort, spaceId: SpaceId | string) => Promise<readonly T[]>,
): HomeRegion<T> {
  const [answer, setAnswer] = useState<KeyedRead<T> | null>(null);
  const readRef = useRef(read);
  readRef.current = read;

  /* DERIVED DURING RENDER, not in an effect — see KeyedRead's docblock. */
  const status: HomeRegionStatus =
    answer !== null && answer.port === port && answer.spaceId === spaceId
      ? answer.status
      : 'pending';

  useEffect(() => {
    let alive = true;
    readRef.current(port, spaceId).then(
      (value) => {
        if (alive) setAnswer({ port, spaceId, status: 'loaded', value });
      },
      () => {
        /* A FAILED READ IS NOT AN EMPTY SPACE. It gets its own state and its own
           sentence; reporting it as `loaded` with no rows would be the original
           lie wearing a different hat. */
        if (alive) setAnswer({ port, spaceId, status: 'failed', value: NOTHING as readonly T[] });
      },
    );
    return () => {
      alive = false;
    };
  }, [port, spaceId]);

  return {
    status,
    items: status === 'loaded' && answer !== null ? answer.value : NOTHING,
  };
}

/**
 * The sentence a region may show, for each of the three facts.
 *
 * `noun` is the plural the empty case names — "conversations", "sessions". The
 * copy is deliberately shorter than the string it replaces on every surface
 * that had one, so no container gains width pressure from adopting this.
 */
export function homeRegionNote(status: HomeRegionStatus, noun: string): string | null {
  if (status === 'pending') return `Loading ${noun}…`;
  if (status === 'failed') return `Your ${noun} could not be loaded.`;
  return null;
}

/**
 * RECENT CHATS, FROM THE READER THAT ALREADY EXISTS.
 *
 * THE CLIENT NEVER SORTS THIS LIST, and that is exactly why Home must reuse it.
 * `listThreads` (`real-port.ts:92`) delegates to `bridge.listThreads`, which is
 * `(await seam.home(sid)).chatThreads` (`GateApp.tsx:1393`) — the server's L2
 * home payload, mapped in whatever order it arrives. There is no client-side
 * sort anywhere in the path, so every consumer of this reader inherits ONE
 * order by construction and no second one can drift from it. A Home whose top
 * chat differed from the chat list's top chat would be the owner's own "options
 * repeating" complaint reintroduced by the fix for it.
 *
 * WHAT IS *NOT* GUARANTEED HERE: that the order is most-recent-first.
 * `ChatHomeScreen:734-737` records that as a 2026-08-15 ruling and the cold
 * start relies on it, but it is a property of the SERVER payload, asserted in a
 * comment and enforced nowhere in the UI. If a surface ever needs it to be true
 * rather than expected, that is a server question — do not answer it by sorting
 * here, which would create the second definition this seam exists to prevent.
 *
 * (An earlier draft of this file cited `real-port.ts:82`'s `sort:
 * 'activityAt_desc'` as the guarantee. That line is inside `listTeammates` and
 * orders TEAMMATES. Recorded because the mistake — attributing a grep hit to the
 * function you happen to be writing about, without reading its enclosing scope —
 * is the same one that made a guarded `<MenuRail>` look live and a registry-driven
 * Pill tone look like it had three call sites.)
 *
 * `limit` TRIMS, IT DOES NOT RANK. The order is the port's; taking a prefix
 * cannot reorder it, so there is no second definition of recency here.
 */
export function useRecentChats(
  port: ChatHomePort,
  spaceId: SpaceId | string,
  limit = 5,
): HomeRegion<ChatThreadSummary> & { note: string | null } {
  const region = useKeyedRead(port, spaceId, readThreads);
  const items = useMemo(() => region.items.slice(0, limit), [region.items, limit]);
  return { status: region.status, items, note: homeRegionNote(region.status, 'conversations') };
}

/**
 * THE CREATE VERBS, AS A TYPE, SO HOME WIRES THE ONES THAT ALREADY EXIST.
 *
 * "New chat / task / project / doc, startable without navigating first" is not
 * new plumbing — `ChatHomeScreen` already takes exactly these, and
 * `ListRootHeader` already renders a control for any kind. This interface is
 * that same shape, named, so a Home card can accept it from the host rather
 * than grow a second create control. Two controls for one verb is how "options
 * repeating" comes back, which is the complaint the dashboard exists to answer.
 *
 * D10 IS A RULING, NOT AN IMPLEMENTATION DETAIL (task 01a00932). A create takes
 * the detail region AND lands the surrounding list on the new entity's root. A
 * create path that skips the second half produces a new doc the visible column
 * cannot show — which is precisely "I made something and I can't see it".
 */
export interface HomeCreateVerbs {
  /** Back to the new-conversation composer. Chat's own create. */
  onShowChat?: (() => void) | undefined;
  /** Create the CURRENT kind immediately (D3), then land on its root (D10). */
  onNewEntity?: (() => void) | undefined;
  /** Create ANY kind from one control — the four the dashboard brief asks for. */
  onCreateKind?: ((kind: string) => void) | undefined;
  /**
   * WHY CREATION IS REFUSED, when it is. Present ⇒ the control renders DISABLED
   * WITH THE REASON; it is never hidden. A missing button reads as a missing
   * feature; a disabled one that says why reads as a product that knows its own
   * state, which is the difference a client sees in a demo.
   */
  newEntityUnavailable?: { cause: string; remedy: string } | null;
}

/* Module scope so the identity is stable — see `useKeyedRead`'s note on why the
   reader must not be an effect dependency. */
function readThreads(
  port: ChatHomePort,
  spaceId: SpaceId | string,
): Promise<readonly ChatThreadSummary[]> {
  return port.listThreads(spaceId);
}
