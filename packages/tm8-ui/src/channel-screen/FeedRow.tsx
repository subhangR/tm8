import { useState } from 'react';
import type { EntityId, FeedItem, MessageView } from '@tm8/contract';
import { Avatar, Pill } from '../kit';
import { DisabledAction, DisabledIconControl, NOT_WIRED_REASON } from '../panels/honesty/DisabledWithReason';
import {
  canSendAgain,
  clockTime,
  deliveryPresentation,
  deliverySummaryLine,
  directionOf,
  viaTitle,
  type FeedGroup,
} from './feed-model';

/**
 * ONE FEED ROW — the T10 hero's row grammar, in the oracle's default
 * provenance treatment (§5 "1a Margin rail": direction owns an 88px left
 * margin; time and `via` live with it; the byline carries name, delivery and
 * the verbs).
 *
 * WHY 1a AND NOT 1b/1c. The oracle draws three and marks one: "1a is the hero
 * default." Picking a different one would be a design decision this lane has
 * no standing to make, and the canvas already made it.
 *
 * WHAT THIS FILE REFUSES TO DO, since every one of these was a defect
 * somewhere in this build's history:
 *
 *   · It never drops a row it does not understand (S15). An unrecognised
 *     activity variant renders a safe card carrying timestamp, actor and an
 *     open-details route — the row is always at least navigable.
 *   · It never lets a delivery failure remove or grey out the MESSAGE (S19).
 *     Delivery is a badge on a stored thing; the stored thing is the fact.
 *   · It never recovers a redacted body from cache (S14). A tombstone keeps
 *     its position and its permitted metadata and nothing else.
 */

export interface FeedRowHandlers {
  /** Real dispatcher for Send again — posts a NEW message, never a retry. */
  onPost?: (body: string, parentMessageId: EntityId | null) => void;
  onReply?: (message: MessageView) => void;
  onOpenEntity?: (id: EntityId) => void;
}

export function FeedRowGroup({
  group,
  anchorId,
  anchorNoun,
  handlers,
}: {
  group: FeedGroup;
  anchorId: EntityId;
  anchorNoun: string;
  handlers: FeedRowHandlers;
}) {
  if (group.kind === 'operation') {
    return <MutationGroupRow group={group} anchorId={anchorId} anchorNoun={anchorNoun} />;
  }
  return <FeedRow item={group.item} anchorId={anchorId} anchorNoun={anchorNoun} handlers={handlers} />;
}

function FeedRow({
  item,
  anchorId,
  anchorNoun,
  handlers,
}: {
  item: FeedItem;
  anchorId: EntityId;
  anchorNoun: string;
  handlers: FeedRowHandlers;
}) {
  return (
    <li className="chs-row">
      <article className="chs-row__grid">
        <Rail item={item} anchorId={anchorId} anchorNoun={anchorNoun} />
        <div className="chs-row__body">
          {item.itemKind === 'message' ? (
            <MessageContent item={item} handlers={handlers} />
          ) : (
            <ActivityContent item={item} handlers={handlers} />
          )}
        </div>
      </article>
    </li>
  );
}

/**
 * The margin rail. Direction, `via ×N`, time — right-aligned in a fixed column
 * so the eye has a constant scan line down the left of the feed.
 *
 * `via ×N` is shown only for a MULTI-predicate item, exactly as the oracle
 * does: one predicate is the ordinary case and needs no annotation, while two
 * or more mean the server surfaced this row by several routes at once — which
 * is the fact worth exposing. The tooltip prints the predicates verbatim.
 */
function Rail({ item, anchorId, anchorNoun }: { item: FeedItem; anchorId: EntityId; anchorNoun: string }) {
  const dir = directionOf(item, anchorId, anchorNoun);
  return (
    <div className="chs-rail">
      {dir ? <span className={`chs-rail__dir chs-rail__dir--${dir.tone}`}>{dir.word}</span> : null}
      {item.via.length > 1 ? (
        <span className="chs-rail__via" title={viaTitle(item.via)}>
          {`via ×${item.via.length}`}
        </span>
      ) : null}
      <time className="chs-rail__time" dateTime={item.createdAt}>
        {clockTime(item.createdAt)}
      </time>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function MessageContent({
  item,
  handlers,
}: {
  item: Extract<FeedItem, { itemKind: 'message' }>;
  handlers: FeedRowHandlers;
}) {
  const { message, delivery } = item;
  const author = message.state.author ?? message.createdBy;

  if (message.deletedAt) {
    /*
     * S14 — the tombstone. It keeps its PLACE (so replies below it still make
     * sense) and states who removed it and when, where that is permitted. The
     * body is not rendered from any cached copy: "the former title is not
     * recovered from cache" is the same law one level down.
     */
    return (
      <p className="chs-tomb" data-testid="chs-tombstone">
        {`⌀ message removed${author?.displayName ? ` by ${author.displayName}` : ''} · ${clockTime(
          message.deletedAt,
        )} — replies keep their place`}
      </p>
    );
  }

  const summary = deliverySummaryLine(delivery);
  const single = delivery.length === 1 ? delivery[0] : null;

  return (
    <>
      <div className="chs-byline">
        {/*
          DRIFT, recorded rather than smuggled: the oracle draws an 18px avatar
          on this byline (hero line 98) and `kit/Avatar` types its size as
          15|20|22|32. 20 is the nearest legal value. Widening the kit union is
          an edit outside this lane, so the divergence goes to HANDOVER.md for
          the coordinator to route — a 2px silent deviation is exactly the class
          of "close and wrong" the ink-chip lesson was about.
        */}
        <Avatar
          provenance={author?.isAgent ? 'agent' : 'human'}
          label={author?.displayName ?? 'unknown'}
          size={20}
        />
        <span className="chs-byline__who">{author?.displayName ?? 'unknown'}</span>
        <span className="chs-byline__gap" />
        {single ? <DeliveryBadge status={single.status} /> : null}
        {canSendAgain(delivery) ? <SendAgain item={item} handlers={handlers} /> : null}
        <ReplyButton message={message} onReply={handlers.onReply} />
      </div>

      {message.state.rootMessageId ? <ParentPreview id={message.state.rootMessageId} /> : null}

      <p className="chs-text">{message.content.body}</p>

      {summary && delivery.length > 1 ? <TargetList summary={summary} rows={delivery} /> : null}
    </>
  );
}

/** The §6 badge: colour + WORD, never colour alone, and never its own row. */
function DeliveryBadge({ status }: { status: Parameters<typeof deliveryPresentation>[0] }) {
  const p = deliveryPresentation(status);
  return (
    <span className="chs-delivery" data-testid="chs-delivery" title={p.tooltip}>
      <Pill tone={p.tone} dot={p.pulse ? 'pulse' : undefined}>
        {p.label}
      </Pill>
    </span>
  );
}

/**
 * S20 — per-target delivery under one shared message. The summary chip is the
 * control; the expansion lists every target UNCOLLAPSED, so `unknown` sits
 * beside `delivered` in its own warning tone rather than being averaged into
 * a cheerful count.
 */
function TargetList({
  summary,
  rows,
}: {
  summary: string;
  rows: Extract<FeedItem, { itemKind: 'message' }>['delivery'];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chs-targets">
      <button
        type="button"
        className="chs-chip-btn"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="content is shared — delivery is per-target"
      >
        {`${summary} ${open ? '▾' : '▸'}`}
      </button>
      {open ? (
        <ul className="chs-targets__list" data-testid="chs-targets">
          {rows.map((r) => {
            const p = deliveryPresentation(r.status);
            return (
              <li key={r.deliveryId} className="chs-targets__row">
                <span className="chs-targets__name">{r.targetWorkSessionId}</span>
                <span className={`chs-targets__state chs-targets__state--${p.tone}`} title={p.tooltip}>
                  {p.label}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * SEND AGAIN — deliberately not "Retry".
 *
 * The oracle spells the distinction out in its own tooltip: "Send again creates
 * a deliberate new message — the original stored message remains. There is no
 * delivery-only Retry." So this routes through the SAME dispatcher the composer
 * uses; there is no second write path, and with no dispatcher it refuses
 * visibly rather than sitting there enabled and inert (R5 #9).
 */
function SendAgain({
  item,
  handlers,
}: {
  item: Extract<FeedItem, { itemKind: 'message' }>;
  handlers: FeedRowHandlers;
}) {
  const body = item.message.content.body;
  if (!handlers.onPost) {
    return (
      <DisabledAction
        label="Send again"
        reason={{
          cause: 'Sending isn’t connected in this surface yet',
          remedy: 'the stored message is unaffected; nothing was lost',
        }}
      >
        send again
      </DisabledAction>
    );
  }
  return (
    <button
      type="button"
      className="chs-linkbtn"
      title="Send again creates a deliberate new message — the original stored message remains. There is no delivery-only Retry."
      onClick={() => handlers.onPost?.(body, null)}
    >
      send again
    </button>
  );
}

function ReplyButton({
  message,
  onReply,
}: {
  message: MessageView;
  onReply?: (m: MessageView) => void;
}) {
  const who = message.state.author?.displayName ?? message.createdBy?.displayName ?? 'this message';
  if (!onReply) {
    return <DisabledIconControl label={`Reply to ${who}`} glyph="↩" reason={NOT_WIRED_REASON} />;
  }
  return (
    <button type="button" className="chs-iconbtn" aria-label={`Reply to ${who}`} onClick={() => onReply(message)}>
      <span aria-hidden>↩</span>
    </button>
  );
}

/**
 * The reply's parent preview.
 *
 * HONEST LIMIT, stated rather than papered over: `MessageView` carries the
 * parent's ID and nothing else, and this surface holds only the page it was
 * given — so an excerpt is available only if the parent happens to be on that
 * page, which is not a guarantee this component can make. Rather than render a
 * sometimes-excerpt that silently degrades, it renders the RELATIONSHIP, which
 * is always true. The oracle's excerpt needs a parent-hydration read that the
 * seam does not expose; it is filed in HANDOVER.md under GAPS.
 */
function ParentPreview({ id }: { id: EntityId }) {
  return (
    <p className="chs-parent" data-testid="chs-parent">
      <span className="chs-parent__label">in reply to</span>
      <span className="chs-parent__id">{id}</span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/**
 * Activity has exactly two drawn forms here: a STATE CHANGE when the row's own
 * summary carries a from/to pair, and the SAFE CARD for everything else.
 *
 * The discrimination is structural — "does this summary contain a transition?"
 * — never a list of known verbs. A verb allow-list would make S15 unreachable:
 * the whole point of that frame is that the feed can outrun the renderer, and
 * the renderer must degrade to something honest instead of to nothing.
 */
function ActivityContent({
  item,
  handlers,
}: {
  item: Extract<FeedItem, { itemKind: 'activity' }>;
  handlers: FeedRowHandlers;
}) {
  const { activity } = item;
  const from = scalar(activity.summary.from ?? activity.summary.fromStatus);
  const to = scalar(activity.summary.to ?? activity.summary.toStatus);

  if (from !== null && to !== null) {
    return (
      <p className="chs-state" data-testid="chs-state">
        <span aria-hidden className="chs-state__dot" />
        <span className="chs-state__verb">{activity.verb}</span>
        <span className="chs-state__from">{from}</span>
        <span aria-hidden className="chs-state__arrow">
          →
        </span>
        <span className="chs-state__to">{to}</span>
      </p>
    );
  }

  return (
    <div className="chs-unknown" data-testid="chs-unknown">
      <span aria-hidden className="chs-unknown__glyph">
        ◇
      </span>
      <span className="chs-unknown__label">unknown activity</span>
      <span className="chs-unknown__variant">{activity.verb}</span>
      {item.actor ? <span className="chs-unknown__actor">{item.actor.displayName}</span> : null}
      <span className="chs-byline__gap" />
      <OpenDetails id={activity.entityId ?? item.anchor?.id ?? null} onOpenEntity={handlers.onOpenEntity} />
    </div>
  );
}

/**
 * The open-details route on a row nobody can render.
 *
 * Three honest outcomes, and none of them is a dead control: no target on the
 * row at all ⇒ the reason says the ROW carries no entity; a target with no
 * navigator wired ⇒ the standard not-wired refusal; both present ⇒ a real
 * button. The two refusals read differently because they ARE different, and a
 * user who cannot open a row deserves to know which of the two is true.
 */
function OpenDetails({ id, onOpenEntity }: { id: EntityId | null; onOpenEntity?: (id: EntityId) => void }) {
  if (!id) {
    return (
      <DisabledAction
        label="Open details"
        reason={{
          cause: 'This activity row names no entity to open',
          remedy: 'the feed item carries no entityId — nothing is being hidden from you',
        }}
      >
        open details →
      </DisabledAction>
    );
  }
  if (!onOpenEntity) {
    return <DisabledAction label="Open details" reason={NOT_WIRED_REASON}>open details →</DisabledAction>;
  }
  return (
    <button type="button" className="chs-linkbtn" onClick={() => onOpenEntity(id)}>
      open details →
    </button>
  );
}

/**
 * S16 — the collapsed mutation group. Says WHAT changed and HOW MANY records,
 * and the expansion lists them. The key is printed in the tooltip because the
 * grouping rule is a claim about the data and the user is entitled to check it.
 */
function MutationGroupRow({
  group,
  anchorId,
  anchorNoun,
}: {
  group: Extract<FeedGroup, { kind: 'operation' }>;
  anchorId: EntityId;
  anchorNoun: string;
}) {
  const [open, setOpen] = useState(false);
  const head = group.items[0];
  const actor = head.actor?.displayName ?? 'someone';
  return (
    <li className="chs-row">
      <article className="chs-row__grid">
        <Rail item={head} anchorId={anchorId} anchorNoun={anchorNoun} />
        <div className="chs-row__body">
          <div className="chs-group" data-testid="chs-group">
            <span aria-hidden className="chs-group__glyph">
              ⇄
            </span>
            <span className="chs-group__text">{`${actor} changed ${group.items.length} records`}</span>
            <button
              type="button"
              className="chs-chip-btn"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              title={`grouped by logical-operation key ${group.key} — never by timestamps`}
            >
              {`${group.items.length} records ${open ? '▾' : '▸'}`}
            </button>
          </div>
          {open ? (
            <ul className="chs-group__rows" data-testid="chs-group-rows">
              {group.items.map((i) => (
                <li key={i.itemId} className="chs-group__row">
                  {i.itemKind === 'activity' ? i.activity.verb : i.itemId}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </article>
    </li>
  );
}

function scalar(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number') return String(v);
  return null;
}
