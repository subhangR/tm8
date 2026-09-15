/**
 * THE CONVERSATION LIST, MOVED OUT OF THE DRAWER.
 *
 * ── WHY IT MOVED (task 01a0a5f2, owner report 2026-09-15) ──────────────────
 *
 * `MobileDrawer` shipped with the thread list rendered INLINE as its first
 * section. That was ruling 3 — Chats first, because it is what a reader
 * returns to — and it was right while a space had a handful of conversations.
 * It stopped being right the moment they accumulated: the reporter's own space
 * put eight conversation rows, each two lines tall, between the ☰ and the
 * word "Destinations". Every entity kind in the app — nineteen of them — sat
 * below a list that grows without bound. Reaching Tasks meant scrolling past
 * every conversation anyone had ever started.
 *
 * It was also, on its own file's terms, the one thing the drawer said it would
 * never do. Ruling 7: "A KIND ROW OPENS A FULL-SCREEN LIST. NO list is
 * rendered inside the drawer" — because a panel that expands a population into
 * rows beside itself is a two-pane phone UI. The Chats section was exactly
 * that, exempted only because nothing else could hold it yet.
 *
 * ── WHY A SHEET AND NOT A KIND ROW ─────────────────────────────────────────
 *
 * The obvious reading of the report — "we can just show the chats also as
 * entity" — does not typecheck, and the reason is worth keeping written down.
 * A chat thread is NOT a registry kind. `CHATS_ROOT` is a named sentinel
 * precisely because messages are `strategy: 'anchored'`: a thread is a message
 * subtree hanging off an entity, not an entity with a slug, a collection route
 * and a list screen. `collectionKinds()` cannot be made to yield it without
 * lying about what a thread is, and `homeRailGroups()` reads from that same
 * set — so a "Chats" row in the Entities band would be a row the registry does
 * not back.
 *
 * `channel` IS a collection kind and DOES already have its row there (People
 * group, since 2026-08-01). That row is not this list and must not be confused
 * with it: it lists channels, this lists conversations.
 *
 * So the population keeps its own surface. A SHEET rather than a pushed screen
 * for `MobileSheet`'s own stated reason — a push replaces your place, a sheet
 * suspends it — and picking a conversation is a return to the chat screen, not
 * a drill into a new one. It is `'full'` size because this is a LIST that
 * competes with nothing underneath and wants the rows; the strip a default
 * sheet keeps would cost two conversations for nothing.
 *
 * ── WHAT THE DRAWER KEEPS ──────────────────────────────────────────────────
 *
 * Two rows where a list used to be: ＋ New conversation (the verb, unchanged
 * and still one tap from anywhere) and a Chats row carrying the count, which
 * opens this. That is the same shape every kind row has, which is as close to
 * the report's "show the chats also as entity" as the domain honestly allows.
 */
import { VectorIcon } from '../kit';
import { MobileSheet } from './MobileSheet';
import type { ChatThreadSummary } from '../chat-home/types';
import type { EntityId } from '@tm8/contract';
import './mobile-threads.css';

/** ＋, on `VectorIcon`'s 16x16 grid — the drawer's own mark, same weight. */
const PLUS_ART = ['M8 3.25v9.5', 'M3.25 8h9.5'];

export interface MobileThreadsSheetProps {
  readonly threads: readonly ChatThreadSummary[];
  readonly selectedThreadId: EntityId | null;
  /** Picking one selects it AND sends the viewer to the chat screen. */
  readonly onSelectThread: (id: EntityId) => void;
  readonly onNewThread: () => void;
  readonly onDismiss: () => void;
}

export function MobileThreadsSheet(props: MobileThreadsSheetProps) {
  return (
    <MobileSheet title="Chats" size="full" testId="mobile-threads-sheet" onDismiss={props.onDismiss}>
      <ul className="mthreads__rows">
        <li>
          {/* The verb leads, exactly as it did in the drawer. A viewer who
              opened this list to start something new should not have to read
              past the conversations they are not looking for to find it. */}
          <button type="button" className="mthreads__row mthreads__row--verb" onClick={props.onNewThread}>
            <span className="mthreads__mark" aria-hidden>
              <VectorIcon paths={PLUS_ART} size={16} strokeWidth={1.6} />
            </span>
            <span className="mthreads__name">New conversation</span>
          </button>
        </li>
        {props.threads.map((thread) => (
          <li key={thread.rootId}>
            <button
              type="button"
              className="mthreads__row"
              aria-current={thread.rootId === props.selectedThreadId ? 'true' : undefined}
              onClick={() => props.onSelectThread(thread.rootId)}
            >
              <span className="mthreads__name mthreads__name--stacked">
                <span className="mthreads__title">{thread.title}</span>
                <span className="mthreads__preview">{thread.preview}</span>
              </span>
            </button>
          </li>
        ))}
        {props.threads.length === 0 ? (
          <li className="mthreads__empty">No conversations on this space yet.</li>
        ) : null}
      </ul>
    </MobileSheet>
  );
}
