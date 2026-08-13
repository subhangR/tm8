/**
 * `src/messages/MessagesScreen.tsx` — the screen behind the `messages` rail row.
 *
 * D65 shape: an activated menu view replaces the centre WHOLESALE (the
 * workspace is the only three-panel exception), so this is a full-width screen
 * in the `files`/`graph` mould, not a panel. Two columns: the conversations on
 * the left in their own scroll, the selected conversation read on the right.
 *
 * WHAT THIS FILE IS. Presentation only, props-in. Every read is sequenced by
 * `useMessagesData` and every projection lives in `messages-model.ts`; this
 * file decides what the viewer SEES and nothing else. The right pane is
 * `ChannelScreen` — the chat surface already exists, it is anchor-agnostic by
 * design, and a second implementation here would drift from it within a week.
 *
 * R7 POSTURE, stated once for the whole file: **no control this screen draws
 * is hidden, and no control is live-but-inert.** Search is the one deferred
 * affordance and it renders disabled-with-reason (`aria-disabled` + focusable,
 * reason on `aria-describedby` — D28: a natively `disabled` button leaves the
 * tab order and takes its own explanation with it).
 *
 * THE FOUR ABSENCES THIS SCREEN REFUSES TO COLLAPSE, because each pair looks
 * identical if you draw them the same way and only one of each pair is a bug:
 *   · `unread === null` (nobody counted) vs `unread === 0` (counted, none).
 *     A `0 unread` badge on a row the server never measured is a claim, so
 *     null draws the MESSAGE COUNT and carries `UNREAD_NOT_COMPUTED_REASON`.
 *   · `conversations === null` (no read has resolved) vs `[]` (a read found
 *     nothing). Loading note vs `NO_CONVERSATIONS_NOTE`, never one note.
 *   · a resolved empty list vs a list emptied by the kind filter —
 *     `NO_MATCHES_NOTE` names the filter as the cause.
 *   · `anchorTitle === null` on a flat message row (the anchor is outside the
 *     loaded conversation index) vs a real title. The first renders as
 *     visibly unresolved; it is never backfilled with an invented name.
 *
 * AND ONE REPLACEMENT RULE: an error REPLACES the surface it belongs to, it
 * never overlays it. A list error leaves no rows behind, a feed error leaves
 * no feed behind. Same law `ChannelScreen` applies to its own refusals.
 *
 * §15.2: this lane names no kind. Kind reaches the screen as DATA — the chips
 * come from `kindsPresent(rows)`, their words from `getKind(...).label`, their
 * marks from `KindIcon` — so a new kind that learns to hold a discussion needs
 * no edit here. `anchorNoun` below is the same discipline in one word.
 *
 * FIDELITY IS DEFERRED. The bar here is link-level completeness; values follow
 * tokens throughout and no divergence is quietly absorbed.
 */
import { useId, useMemo } from 'react';
import type { EntityId, EntityKind } from '@tm8/contract';
import { Eyebrow, Pill } from '../kit';
import { KindIcon, getKind } from '../domain';
import { ChannelScreen } from '../channel-screen/ChannelScreen';
import { DisabledAction, toReason } from '../panels/honesty/DisabledWithReason';
import {
  CONVERSATIONS_UNRESOLVED_NOTE,
  NO_CONVERSATIONS_NOTE,
  NO_MATCHES_NOTE,
  SEARCH_DISABLED_REASON,
  UNREAD_NOT_COMPUTED_REASON,
  applyKindFilter,
  kindsPresent,
  relativeTime,
  type ConversationRow,
  type MessageRow,
  type MessagesMode,
} from './messages-model';
import type { MessagesData } from './useMessagesData';

export interface MessagesScreenProps {
  data: MessagesData;
  /** Opens the underlying entity — Messages is a lens, never a dead end. */
  onOpenEntity?: (id: EntityId) => void;
  /** Injected for determinism; recency is a pure projection of it. */
  now?: Date;
}

/**
 * The word this screen gives the chat surface for whatever it is anchored on.
 *
 * `ChannelScreen.anchorNoun` is a PROP precisely so the surface never asks what
 * kind it is mounted on, and this view is the strongest case for it: the whole
 * premise is that the reader stops having to know. "this conversation" is true
 * of every anchor that has messages, which is the exact set this screen lists.
 */
const ANCHOR_NOUN = 'this conversation';

const MODE_TABS: readonly { mode: MessagesMode; label: string }[] = [
  { mode: 'conversations', label: 'Conversations' },
  { mode: 'all', label: 'All messages' },
];

export function MessagesScreen({ data, onOpenEntity, now }: MessagesScreenProps) {
  const clock = now ?? new Date();
  const tabsId = useId();
  const panelId = useId();

  const rows = data.conversations;
  // Chips come from the DATA, never from a kind list: `kindsPresent` returns
  // the kinds these rows actually show, in the order they first show them.
  const kinds = useMemo(() => kindsPresent(rows ?? []), [rows]);
  const visible = useMemo(() => applyKindFilter(rows ?? [], data.kindFilter), [rows, data.kindFilter]);

  const selected = data.selected;

  /**
   * Selecting from the flat reading switches BACK to the conversation reading.
   * A click there means "show me this in context"; leaving the flat list up
   * with a conversation silently loaded beside it would answer a question
   * nobody asked and hide the one they did.
   */
  const selectAnchor = (anchorId: EntityId) => {
    data.select(anchorId);
    data.setMode('conversations');
  };

  return (
    <div className="msg-root" data-testid="messages-screen">
      <div className="msg-list" role="region" aria-label="Messages">
        <div className="msg-list__head">
          {/* ---- the two readings: a real tablist, not two styled buttons ---- */}
          <div className="msg-tabs" role="tablist" aria-label="Messages reading" id={tabsId}>
            {MODE_TABS.map((tab) => (
              <button
                key={tab.mode}
                type="button"
                role="tab"
                id={`${tabsId}-${tab.mode}`}
                aria-selected={data.mode === tab.mode}
                aria-controls={panelId}
                tabIndex={data.mode === tab.mode ? 0 : -1}
                className={data.mode === tab.mode ? 'msg-tab msg-tab--on' : 'msg-tab'}
                onClick={() => data.setMode(tab.mode)}
                data-testid={`messages-tab-${tab.mode}`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/*
            SEARCH IS REFUSED, NOT FAKED. `search.query` is `status: 'reserved'`
            in the operation catalog, so the only box this screen could ship
            would filter the page already loaded while LOOKING like it searched
            everything — the worst of the three options, because the viewer
            cannot tell an empty result from an unsearched corpus. Visible,
            focusable, and carrying the measurement instead.
          */}
          <div className="msg-search">
            <DisabledAction reason={toReason(SEARCH_DISABLED_REASON)} label="Search messages">
              ⌕ Search messages
            </DisabledAction>
          </div>

          {data.mode === 'conversations' && kinds.length > 0 ? (
            <KindChips
              kinds={kinds}
              selection={data.kindFilter}
              onChange={data.setKindFilter}
            />
          ) : null}
        </div>

        <div
          className="msg-list__scroll"
          role="tabpanel"
          id={panelId}
          aria-labelledby={`${tabsId}-${data.mode}`}
          tabIndex={0}
        >
          {data.mode === 'conversations' ? (
            <ConversationList
              rows={rows}
              visible={visible}
              error={data.conversationsError}
              filtered={(data.kindFilter?.length ?? 0) > 0}
              selectedId={data.selectedId}
              clock={clock}
              onSelect={data.select}
            />
          ) : (
            <FlatMessageList
              rows={data.allMessages}
              error={data.allMessagesError}
              clock={clock}
              onSelect={selectAnchor}
            />
          )}

          <MoreControl
            hasMore={data.mode === 'conversations' ? data.hasMore : data.allHasMore}
            busy={data.mode === 'conversations' ? data.loadingMore : data.allLoadingMore}
            onMore={data.mode === 'conversations' ? data.loadMore : data.loadMoreAll}
          />
        </div>
      </div>

      <div className="msg-read">
        {selected ? (
          <>
            <div className="msg-read__head">
              <span className="msg-read__kind">
                <KindIcon kind={selected.kind} size={13} />
                <span className="msg-read__kindword">{getKind(selected.kind).label}</span>
              </span>
              <span className="msg-read__title">{selected.title}</span>
              <div className="msg-spacer" />
              {/*
                MESSAGES IS A LENS, NEVER A DEAD END. Reading a discussion here
                has to be able to end at the thing being discussed; without a
                host handler that route does not exist, and the control says so
                rather than sitting there doing nothing.
              */}
              {onOpenEntity ? (
                <button
                  type="button"
                  className="msg-open"
                  onClick={() => onOpenEntity(selected.id)}
                  data-testid="messages-open-entity"
                >
                  {'Open ▸'}
                </button>
              ) : (
                <DisabledAction
                  label="Open this conversation’s entity"
                  reason={{
                    cause: 'Opening the entity isn’t connected here',
                    remedy: 'this screen reads the discussion; the host owns navigation to its entity',
                  }}
                >
                  {'Open ▸'}
                </DisabledAction>
              )}
            </div>

            {data.feedError ? (
              /* REPLACES the surface, never overlays it — the same law
                 ChannelScreen applies to its own refusals. A feed drawn under
                 an error banner is a feed the viewer will read as current. */
              <div className="msg-feed-error" role="alert" data-testid="messages-feed-error">
                <p className="msg-feed-error__line">{data.feedError}</p>
                <p className="msg-note">
                  Nothing of this conversation is shown while the read is failing — no cached
                  excerpts, no partial history.
                </p>
              </div>
            ) : (
              <div className="msg-read__surface">
                <ChannelScreen
                  anchorId={selected.id}
                  anchorNoun={ANCHOR_NOUN}
                  anchorTitle={selected.title}
                  page={data.feedPage}
                  loading={data.feedLoading}
                  loadingEarlier={data.loadingEarlier}
                  onLoadEarlier={() => data.loadEarlier()}
                  onPost={data.post}
                  connection={data.connection}
                  onOpenEntity={onOpenEntity}
                />
              </div>
            )}

            {data.postError ? (
              <p className="msg-note msg-note--block" role="alert" data-testid="messages-post-error">
                {data.postError}
              </p>
            ) : null}
          </>
        ) : (
          <NothingSelected rows={data.conversations} error={data.conversationsError} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Left column
// ---------------------------------------------------------------------------

/**
 * The kind filter, built entirely from what the rows contain.
 *
 * A hardcoded kind list here would be a kind branch by another name (§15.2) and
 * would offer chips that match nothing the moment the space's mix changes. An
 * empty selection means NO FILTER, never "match nothing" — `applyKindFilter`
 * encodes that and this control mirrors it: deselecting the last chip restores
 * everything rather than emptying the list.
 */
function KindChips({
  kinds,
  selection,
  onChange,
}: {
  kinds: readonly EntityKind[];
  selection: readonly EntityKind[] | null;
  onChange: (kinds: readonly EntityKind[] | null) => void;
}) {
  const active = selection ?? [];
  return (
    <div className="msg-chips" role="group" aria-label="Filter conversations by kind">
      {kinds.map((kind) => {
        const on = active.includes(kind);
        return (
          <button
            key={kind}
            type="button"
            aria-pressed={on}
            className={on ? 'msg-chip msg-chip--on' : 'msg-chip'}
            onClick={() => {
              const next = on ? active.filter((k) => k !== kind) : [...active, kind];
              onChange(next.length === 0 ? null : next);
            }}
            data-testid="messages-kind-chip"
          >
            <KindIcon kind={kind} size={11} />
            {getKind(kind).labelPlural}
          </button>
        );
      })}
      {active.length > 0 ? (
        <button
          type="button"
          className="msg-chip msg-chip--clear"
          onClick={() => onChange(null)}
          data-testid="messages-kind-clear"
        >
          {'clear ✕'}
        </button>
      ) : null}
    </div>
  );
}

function ConversationList({
  rows,
  visible,
  error,
  filtered,
  selectedId,
  clock,
  onSelect,
}: {
  rows: readonly ConversationRow[] | null;
  visible: readonly ConversationRow[];
  error: string | null;
  filtered: boolean;
  selectedId: EntityId | null;
  clock: Date;
  onSelect: (id: EntityId) => void;
}) {
  /* An error REPLACES the list. Rows painted under an error line are rows the
     viewer reads as the current truth, which is exactly what failed. */
  if (error) {
    return (
      <p className="msg-note msg-note--block" role="alert" data-testid="messages-list-error">
        {error}
      </p>
    );
  }
  /* `null` is NOT `[]`. No read has resolved yet — saying "no conversations"
     here would report a measurement that has not happened. */
  if (rows === null) {
    return (
      <p className="msg-empty" data-testid="messages-unresolved">
        {CONVERSATIONS_UNRESOLVED_NOTE}
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="msg-empty" data-testid="messages-empty">
        {NO_CONVERSATIONS_NOTE}
      </p>
    );
  }
  /* Resolved, non-empty, and emptied BY THE FILTER — a third state, and the
     only one where the remedy is in the viewer's hands. */
  if (visible.length === 0) {
    return (
      <p className="msg-empty" data-testid="messages-no-matches">
        {filtered ? NO_MATCHES_NOTE : NO_CONVERSATIONS_NOTE}
      </p>
    );
  }

  return (
    <ul className="msg-rows" aria-label="Conversations">
      {visible.map((row) => (
        <ConversationItem
          key={row.id}
          row={row}
          selected={row.id === selectedId}
          clock={clock}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function ConversationItem({
  row,
  selected,
  clock,
  onSelect,
}: {
  row: ConversationRow;
  selected: boolean;
  clock: Date;
  onSelect: (id: EntityId) => void;
}) {
  const unread = row.unread !== null && row.unread > 0;
  return (
    <li className="msg-row" data-testid="messages-conversation-row" data-selected={selected}>
      <button
        type="button"
        className={selected ? 'msg-row__hit msg-row__hit--on' : 'msg-row__hit'}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(row.id)}
      >
        {/* L10 / rule 5: the selection tint is never the only carrier. The
            word rides along for anyone the colour does not reach. */}
        {selected ? <span className="msg-vh">selected — </span> : null}
        <KindIcon kind={row.kind} size={13} />
        <span className="msg-row__body">
          <span className="msg-row__head">
            <span className={unread ? 'msg-row__title msg-row__title--unread' : 'msg-row__title'}>
              {row.title}
            </span>
            <span className="msg-row__time">{relativeTime(row.activityAt, clock)}</span>
          </span>
          <span className="msg-row__foot">
            <span className="msg-row__excerpt">
              {row.lastMessage ? (
                <>
                  <span className="msg-row__author">{row.lastMessage.authorName}</span>
                  {` · ${row.lastMessage.excerpt}`}
                </>
              ) : (
                /* No preview was learned for this row — the last-message page
                   did not reach back this far. Absence, not a wrong preview. */
                <span className="msg-row__excerpt--none">no preview loaded</span>
              )}
            </span>
            <CountCell row={row} unread={unread} />
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * The count treatment — the sharpest honesty edge on this screen.
 *
 * `unread` is `number | null` and `null` MEANS NOT COMPUTED. The server
 * computes per-anchor unread for one kind's state only, so most rows here
 * genuinely have no count; rendering `0` for them would put a measurement
 * nobody took in front of the viewer, and it would look identical to a row
 * that really was fully read. So:
 *   · `unread > 0`  ⇒ the unread treatment, with the WORD "unread" beside it;
 *   · `unread === 0` ⇒ counted and clear — the message count, no badge;
 *   · `unread === null` ⇒ the message count, carrying the reason on `title`
 *     so the blank is explained where a viewer would go looking for it.
 * The last two look alike on purpose: neither is an unread claim.
 */
function CountCell({ row, unread }: { row: ConversationRow; unread: boolean }) {
  if (unread) {
    return <Pill tone="brand">{`${row.unread} unread`}</Pill>;
  }
  return (
    <span
      className="msg-row__count"
      title={row.unread === null ? UNREAD_NOT_COMPUTED_REASON : undefined}
      data-uncomputed={row.unread === null}
    >
      {`${row.messageCount} in thread`}
    </span>
  );
}

/**
 * The flat reading — every message, newest first, across every anchor.
 *
 * Its whole point is that the viewer does not have to pick a conversation
 * first, so a row here carries the anchor's name as CONTEXT. When that name
 * was not resolvable from the loaded conversation index, the row says so.
 */
function FlatMessageList({
  rows,
  error,
  clock,
  onSelect,
}: {
  rows: readonly MessageRow[] | null;
  error: string | null;
  clock: Date;
  onSelect: (anchorId: EntityId) => void;
}) {
  if (error) {
    return (
      <p className="msg-note msg-note--block" role="alert" data-testid="messages-all-error">
        {error}
      </p>
    );
  }
  if (rows === null) {
    return (
      <p className="msg-empty" data-testid="messages-all-unresolved">
        {CONVERSATIONS_UNRESOLVED_NOTE}
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="msg-empty" data-testid="messages-all-empty">
        {NO_CONVERSATIONS_NOTE}
      </p>
    );
  }
  return (
    <ul className="msg-rows" aria-label="All messages">
      {rows.map((row) => (
        <li className="msg-row" key={row.id} data-testid="messages-message-row">
          <button type="button" className="msg-row__hit" onClick={() => onSelect(row.anchorId)}>
            <span className="msg-row__body">
              <span className="msg-row__head">
                <span className="msg-row__title">{row.authorName}</span>
                <span className="msg-row__time">{relativeTime(row.createdAt, clock)}</span>
              </span>
              <span className="msg-row__excerpt">{row.excerpt}</span>
              <span className="msg-row__anchor">
                {row.anchorKind ? <KindIcon kind={row.anchorKind} size={11} /> : null}
                {row.anchorTitle !== null ? (
                  row.anchorTitle
                ) : (
                  /*
                   * THE ANCHOR IS GENUINELY UNRESOLVED. This message hangs off
                   * something outside the conversation page we loaded, so we do
                   * not know its name — and a synthesized one ("Untitled", the
                   * id, the kind's word) would be indistinguishable from a real
                   * title to the person reading it. The row still SELECTS: the
                   * anchor id is known even when its name is not.
                   */
                  <span className="msg-row__anchor--unresolved" data-testid="messages-anchor-unresolved">
                    unknown conversation
                  </span>
                )}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Paging. `hasMore` is the whole condition — a control against a list with no
 * further page is a control that cannot succeed, and withholding one when a
 * page exists but nothing dispatches it would hide a real gap.
 */
function MoreControl({
  hasMore,
  busy,
  onMore,
}: {
  hasMore: boolean;
  busy: boolean;
  onMore?: () => void | Promise<void>;
}) {
  if (!hasMore) return null;
  if (!onMore) {
    return (
      <div className="msg-more">
        <DisabledAction
          label="Load more"
          reason={{
            cause: 'There is another page and this build does not fetch it',
            remedy: 'the list read reports more rows than it returned',
          }}
        >
          load more ↓
        </DisabledAction>
      </div>
    );
  }
  return (
    <div className="msg-more">
      <button type="button" className="msg-more__btn" disabled={busy} onClick={() => void onMore()}>
        {busy ? 'loading…' : 'load more ↓'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right column, before anything is chosen
// ---------------------------------------------------------------------------

/**
 * NOT A BLANK BOX. An empty right pane is indistinguishable from a broken one,
 * and the honest sentence differs by what the LEFT column actually knows: a
 * list that has not resolved cannot invite you to pick a row from it, and a
 * space with no conversations has nothing to pick at all.
 */
function NothingSelected({
  rows,
  error,
}: {
  rows: readonly ConversationRow[] | null;
  error: string | null;
}) {
  const note = error
    ? 'The conversation list failed to load, so there is nothing here to choose from.'
    : rows === null
      ? CONVERSATIONS_UNRESOLVED_NOTE
      : rows.length === 0
        ? NO_CONVERSATIONS_NOTE
        : 'Pick a conversation on the left to read it here.';
  return (
    <div className="msg-nothing" data-testid="messages-nothing-selected">
      <span aria-hidden className="msg-nothing__glyph">
        ◌
      </span>
      <Eyebrow faint>No conversation open</Eyebrow>
      <p className="msg-nothing__note">{note}</p>
      <p className="msg-note">
        Anything with messages on it is a conversation here — you never have to know what kind it is
        to read it.
      </p>
    </div>
  );
}
