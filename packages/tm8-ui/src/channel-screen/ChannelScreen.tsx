import { useMemo, useState } from 'react';
import type { Cursor, EntityFeedPage, EntityId, MessageView } from '@tm8/contract';
import type { ConnectionState } from '../data/seam';
import { DisabledAction, NOT_WIRED_REASON } from '../panels/honesty/DisabledWithReason';
import { HollowInline } from '../panels/honesty/HollowValue';
import { Composer } from './Composer';
import { FeedRowGroup } from './FeedRow';
import { groupByOperation, type ChannelPostInput, type ChannelRefusal } from './feed-model';
import './channel-screen.css';

/**
 * THE CHAT SURFACE — T10, mounted as the destination a hub's Feed points at.
 *
 * `T10 Chat Surface Hi-Fi.dc.html` (repo root, ` (1)` directory) draws 27
 * frames. Its hero draws a whole PANEL: breadcrumb, entity header, the
 * Content/Discussion/Connections/Activity tab strip, the Terminal|Chat surface
 * switch, and inside all of that, a feed and a composer. THIS COMPONENT IS THE
 * INSIDE — the feed region, the composer, and the provenance footer. The panel
 * chrome around it already exists and is owned elsewhere; re-drawing it here
 * would be a second implementation of a solved surface, and the two would
 * drift.
 *
 * THE BAR THIS MEETS IS LINK-LEVEL COMPLETENESS, NOT FIDELITY. Every control
 * the canvas draws exists here and either dispatches through the real seam or
 * refuses visibly with its true reason (R7). Geometry and colour are tokenised
 * and plausible; they are NOT canvas-diffed, and a later parity session owns
 * that. Nothing in this file should be read as a pixel claim.
 *
 * THE READ IT CONSUMES is `seam.feed(id, opts)` → `EntityFeedPage`, which is
 * what the oracle's own footer names ("entities.feed · scope session_chat_v1").
 * The page arrives as a PROP rather than being fetched here, for the reason
 * every other body in this package takes its data as props: the surface stays
 * testable without a seam, and the host keeps one place where reads are
 * sequenced.
 */

export interface ChannelScreenProps {
  /** The entity this surface is anchored on — a channel, a session, anything. */
  anchorId: EntityId;
  /**
   * The caller's word for that anchor ("this channel", "this session"). A PROP
   * because naming a kind is registry knowledge; a component that looked it up
   * would be branching on kind by another name (§15.2).
   */
  anchorNoun: string;
  /**
   * The feed page. `undefined` and an empty `items` array are DIFFERENT FACTS
   * and stay different: nothing read this anchor, versus a read that found
   * nothing. Collapsing them is how a screen claims a measurement it never
   * took.
   */
  page?: EntityFeedPage;
  /** A read is in flight and there is nothing to show yet (S06). */
  loading?: boolean;
  /** An older page is in flight (S08). */
  loadingEarlier?: boolean;
  /** S10 — the cursor expired and history was re-seeded from newest. */
  refreshedFromNewest?: boolean;
  /** S12 / S13 — a refusal REPLACES the surface; it never overlays it. */
  refusal?: ChannelRefusal | null;
  /** T4 connection honesty, passed straight through to the composer. */
  connection?: ConnectionState;
  /** S21 — the anchor's session has exited; composing stores but never wakes. */
  sessionExited?: boolean;
  /** Client-local divider: the first item that arrived after this surface opened. */
  newSinceItemId?: string | null;

  /** The seam command. Absent ⇒ Send and Send-again refuse with their reason. */
  onPost?: (input: ChannelPostInput) => Promise<void> | void;
  /** Pages backwards on `nextCursor`. Absent ⇒ the control refuses visibly. */
  onLoadEarlier?: (cursor: Cursor) => Promise<void> | void;
  onOpenEntity?: (id: EntityId) => void;
  /**
   * The surface switch the S07 empty state offers. OPTIONAL AND MEANINGFULLY
   * SO: "the agent's native output lives in Terminal" is true of a session
   * anchor and false of a channel, so the sentence and its button appear only
   * where the host says a terminal exists. An absent control here is not a
   * hidden one — there is nothing to hide.
   */
  onSwitchToTerminal?: () => void;
}

export function ChannelScreen({
  anchorId,
  anchorNoun,
  page,
  loading = false,
  loadingEarlier = false,
  refreshedFromNewest = false,
  refusal = null,
  connection,
  sessionExited = false,
  newSinceItemId = null,
  onPost,
  onLoadEarlier,
  onOpenEntity,
  onSwitchToTerminal,
}: ChannelScreenProps) {
  const [replyTo, setReplyTo] = useState<MessageView | null>(null);

  const groups = useMemo(() => groupByOperation(page?.items ?? []), [page]);

  /*
   * S12 / S13 — a refusal REPLACES everything, composer included.
   *
   * "Nothing about its contents is shown. No titles, counts, or cached
   * excerpts survive." Rendering the refusal as a banner ABOVE a still-painted
   * feed is the exact leak the frame exists to forbid, and it is the shape a
   * hurried implementation reaches for first.
   */
  if (refusal) {
    return (
      <section className="chs-root chs-root--refused" data-testid="chs-root">
        <div className="chs-refusal" data-testid="chs-refusal">
          <span aria-hidden className="chs-refusal__glyph">
            {refusal.kind === 'forbidden' ? '⊘' : '⌀'}
          </span>
          <p className="chs-refusal__headline">{refusal.message}</p>
          <p className="chs-refusal__note">
            {refusal.kind === 'forbidden'
              ? 'Access to other surfaces on this entity is evaluated on its own.'
              : 'Entity tombstone — the former title is not recovered from cache.'}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="chs-root" data-testid="chs-root">
      <div className="chs-feed">
        {refreshedFromNewest ? (
          <p className="chs-notice" data-testid="chs-refreshed">
            history refreshed from newest — the cursor expired · your draft is untouched
          </p>
        ) : null}

        <LoadEarlier
          cursor={page?.nextCursor ?? null}
          busy={loadingEarlier}
          onLoadEarlier={onLoadEarlier}
        />

        {loading && !page ? (
          <ul className="chs-list chs-list--skeleton" aria-busy="true" aria-label="Messages and activity">
            {/* Stable skeletons, fixed height — "no jumping" (S06). */}
            {[0, 1, 2].map((i) => (
              <li key={i} className="chs-skeleton" aria-hidden />
            ))}
          </ul>
        ) : !page ? (
          /*
           * THE HOLLOW STATE. No read has run for this anchor. Distinct from an
           * empty feed in exactly the way `messages === undefined` is distinct
           * from `messages === []` in HubBody: one is an absence of data, the
           * other an absence of a MEASUREMENT, and only the second is our bug.
           */
          <p className="chs-hollow" data-testid="chs-unread">
            <HollowInline caption="No feed read has run for this surface — the page was never passed to it.">
              — messages and activity
            </HollowInline>
          </p>
        ) : page.items.length === 0 ? (
          <EmptyFeed onSwitchToTerminal={onSwitchToTerminal} />
        ) : (
          <ul className="chs-list" aria-label="Messages and activity">
            {groups.map((group) => {
              const first = group.kind === 'operation' ? group.items[0] : group.item;
              return (
                <FeedRowGroupWithMark
                  key={first.itemId}
                  mark={newSinceItemId === first.itemId}
                  group={group}
                  anchorId={anchorId}
                  anchorNoun={anchorNoun}
                  onPost={onPost}
                  onOpenEntity={onOpenEntity}
                  onReply={setReplyTo}
                />
              );
            })}
          </ul>
        )}

        <Provenance page={page} />
      </div>

      <Composer
        anchorId={anchorId}
        anchorNoun={anchorNoun}
        onPost={onPost}
        connection={connection}
        sessionExited={sessionExited}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
      />
    </section>
  );
}

function FeedRowGroupWithMark({
  mark,
  group,
  anchorId,
  anchorNoun,
  onPost,
  onOpenEntity,
  onReply,
}: {
  mark: boolean;
  group: ReturnType<typeof groupByOperation>[number];
  anchorId: EntityId;
  anchorNoun: string;
  onPost?: (input: ChannelPostInput) => Promise<void> | void;
  onOpenEntity?: (id: EntityId) => void;
  onReply: (m: MessageView) => void;
}) {
  return (
    <>
      {mark ? (
        /* The oracle labels this divider CLIENT-LOCAL in its own copy, and the
           label is load-bearing: this is not a read state and does not survive
           a reload, so calling it "unread" would promise durability we do not
           have. */
        <li className="chs-mark" aria-hidden data-testid="chs-mark">
          <span>NEW SINCE OPENED · CLIENT-LOCAL</span>
        </li>
      ) : null}
      <FeedRowGroup
        group={group}
        anchorId={anchorId}
        anchorNoun={anchorNoun}
        handlers={{
          onOpenEntity,
          onReply,
          onPost: onPost
            ? (body, parentMessageId) => void onPost({ anchorIds: [anchorId], body, parentMessageId })
            : undefined,
        }}
      />
    </>
  );
}

/**
 * `load earlier` exists only when there IS an earlier page — `nextCursor` is
 * the whole condition. Drawing it against a null cursor would be a control
 * that cannot succeed; withholding it when a cursor exists but nothing
 * dispatches it would hide a real gap. So: no cursor ⇒ nothing; cursor with no
 * handler ⇒ refusal with its reason; both ⇒ a working button.
 */
function LoadEarlier({
  cursor,
  busy,
  onLoadEarlier,
}: {
  cursor: Cursor | null;
  busy: boolean;
  onLoadEarlier?: (cursor: Cursor) => Promise<void> | void;
}) {
  if (!cursor) return null;
  if (!onLoadEarlier) {
    return (
      <div className="chs-earlier">
        <DisabledAction label="Load earlier" reason={NOT_WIRED_REASON}>
          load earlier ↑
        </DisabledAction>
      </div>
    );
  }
  return (
    <div className="chs-earlier">
      <button
        type="button"
        className="chs-chip-btn"
        disabled={busy}
        onClick={() => void onLoadEarlier(cursor)}
      >
        {busy ? 'loading earlier…' : 'load earlier ↑'}
      </button>
    </div>
  );
}

/**
 * S07 — the empty feed is COMMON, NOT AN ERROR, and the copy says so without
 * apology. It explains where an agent's native output actually lives, and it
 * never offers to import a transcript (the oracle forbids that in writing).
 */
function EmptyFeed({ onSwitchToTerminal }: { onSwitchToTerminal?: () => void }) {
  return (
    <div className="chs-empty" data-testid="chs-empty">
      <span aria-hidden className="chs-empty__glyph">
        ◌
      </span>
      <p className="chs-empty__headline">No explicit tm8 messages or activity yet.</p>
      {onSwitchToTerminal ? (
        <>
          <p className="chs-empty__note">
            The agent’s native output lives in Terminal — Chat only shows deliberate tm8 messages and
            session activity.
          </p>
          <button type="button" className="chs-chip-btn" onClick={onSwitchToTerminal}>
            Switch to Terminal
          </button>
        </>
      ) : null}
    </div>
  );
}

/**
 * The oracle's footer line, and the one number it is allowed to state.
 *
 * S09 is explicit: "1 item returned · continue via nextCursor — no total shown,
 * ever." A total would require counting rows the viewer may not be authorized
 * to see, so the only honest figures are what this page returned and whether
 * another page exists. `resolvedScope` is printed rather than the scope we
 * asked for — the server's answer outranks the request, the same shape as a
 * liveness verdict outranking a stored status.
 */
function Provenance({ page }: { page?: EntityFeedPage }) {
  if (!page) return null;
  const n = page.items.length;
  return (
    <p className="chs-provenance" data-testid="chs-provenance">
      {`entities.feed · scope ${page.resolvedScope} · ${n} item${n === 1 ? '' : 's'} returned · ${
        page.nextCursor ? 'continue via nextCursor' : 'no further pages'
      }`}
    </p>
  );
}
