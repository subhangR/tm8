/**
 * THE CHATS ABOUT ONE ENTITY — the read behind the Chat button's count, the
 * slot's "reopen the most recent" (Q1) and the panel's switcher.
 *
 * ONE READ, THREE CONSUMERS. `entities.connections` on the subject, incoming
 * `about` edges, is the same read `chatIdsAbout` (chat-home/real-port.ts)
 * makes — but that one returns bare ids for Craft to intersect with its own
 * list. Here every consumer wants the chats THEMSELVES (title, teammate, last
 * turn), and each edge already embeds its source's `EntitySummary`, so the
 * projection costs no second read.
 *
 * `about` accepts every source kind (migration 056: `dst_kinds = ['*']`, and a
 * memory can be about a blueprint), so the incoming side is filtered to chats
 * on the STATE discriminator — the same test `itemFromSummary` makes — rather
 * than trusted to be all chats.
 *
 * DETAIL-HEADER ONLY. One read per open panel; never per list row (an N+1 the
 * design rules out, §3.2).
 */
import { useCallback, useEffect, useState } from 'react';
import type { DurableWorkspaceEvent, EdgeView, EntityId, EntitySummary } from '@tm8/contract';
import type { Seam } from '../data/seam';

/** One chat about the subject, as the switcher lists it. */
export interface ChatAboutRow {
  id: EntityId;
  title: string;
  teammateId: EntityId | null;
  /** When the last turn landed, else when the chat was created. Sort key. */
  lastActivityAt: string;
  turnCount: number;
}

/** The slice of the seam this read needs — a fixture can supply just this. */
export type ChatsAboutSeam = Pick<Seam, 'connections'> & Partial<Pick<Seam, 'onEvent'>>;

function rowOf(summary: EntitySummary): ChatAboutRow | null {
  if (summary.state?.kind !== 'chat') return null;
  const state = summary.state;
  return {
    id: summary.id,
    title: summary.title?.trim() || 'Conversation',
    teammateId: state.teammateId ?? null,
    lastActivityAt: state.lastTurnAt ?? summary.createdAt,
    turnCount: state.turnCount ?? 0,
  };
}

/**
 * NEWEST FIRST (§3.3), by last turn. A deleted chat is dropped: an `about`
 * edge can outlive a soft-deleted source for one event's worth of time, and
 * the switcher must not offer a chat that will not open.
 */
export function chatsAboutFrom(edges: readonly EdgeView[]): ChatAboutRow[] {
  const seen = new Set<EntityId>();
  const rows: ChatAboutRow[] = [];
  for (const edge of edges) {
    if (edge.source.deletedAt) continue;
    const row = rowOf(edge.source);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  return rows.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0));
}

/** Read the chats about `aboutId`. Soft-fails to `[]` — a count is never a gate. */
export async function readChatsAbout(seam: ChatsAboutSeam, aboutId: EntityId): Promise<ChatAboutRow[]> {
  try {
    const page = await seam.connections(aboutId, { types: ['about'], direction: 'incoming', limit: 100 });
    return chatsAboutFrom(page.items);
  } catch {
    return [];
  }
}

/**
 * DOES THIS EVENT CHANGE THE ANSWER FOR `aboutId`? (§3.2: "refreshes when a
 * `chat` entity or an `about` link event names the subject").
 *
 *   · an `about` edge written to or removed from the subject — a chat was
 *     started about it, or a link was corrected;
 *   · a chat we already list changed — its title, its last turn, or it was
 *     deleted. A chat we do NOT list cannot be about the subject without an
 *     edge event, which the first arm already catches.
 */
export function eventTouchesChatsAbout(
  event: DurableWorkspaceEvent,
  aboutId: EntityId,
  known: ReadonlySet<EntityId>,
): boolean {
  switch (event.type) {
    case 'edge.upsert':
    case 'edge.deleted':
      return event.edge.type === 'about' && event.edge.target.id === aboutId;
    case 'entity.upsert':
    case 'entity.deleted':
      return known.has(event.entity.id);
    case 'entity.activity_touched':
      return known.has(event.id);
    default:
      return false;
  }
}

export interface ChatsAbout {
  /** `null` until the first read lands — "not known yet" is not "none". */
  chats: readonly ChatAboutRow[] | null;
  /** Re-read now (after this surface created a chat, say). */
  refresh(): void;
}

/**
 * The live list of chats about one entity. `aboutId: null` reads nothing.
 * Re-reads on every event `eventTouchesChatsAbout` accepts.
 */
export function useChatsAbout(seam: ChatsAboutSeam | null | undefined, aboutId: EntityId | null): ChatsAbout {
  const [state, setState] = useState<{ about: EntityId | null; chats: readonly ChatAboutRow[] | null }>(
    { about: null, chats: null },
  );
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!seam || !aboutId) return;
    let live = true;
    void readChatsAbout(seam, aboutId).then((chats) => {
      if (live) setState({ about: aboutId, chats });
    });
    return () => {
      live = false;
    };
  }, [seam, aboutId, tick]);

  const chats = state.about === aboutId ? state.chats : null;
  const knownKey = chats ? chats.map((chat) => chat.id).join(',') : '';
  useEffect(() => {
    if (!seam?.onEvent || !aboutId) return;
    const known = new Set(knownKey ? (knownKey.split(',') as EntityId[]) : []);
    return seam.onEvent((event) => {
      if (eventTouchesChatsAbout(event, aboutId, known)) refresh();
    });
  }, [seam, aboutId, knownKey, refresh]);

  return { chats, refresh };
}
