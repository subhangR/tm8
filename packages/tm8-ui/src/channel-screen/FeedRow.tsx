import { useState, type ReactNode } from 'react';
import type { ActorSummary, EntityId, FeedItem, MessageView } from '@tm8/contract';
import { Avatar, Pill } from '../kit';
import { DisabledAction, DisabledIconControl, NOT_WIRED_REASON } from '../panels/honesty/DisabledWithReason';
import {
  accessibleDateTime,
  activityPresentation,
  canSendAgain,
  clockTime,
  deliveryPresentation,
  deliverySummaryLine,
  safeDeliveryReason,
  type FeedGroup,
} from './feed-model';

/**
 * ONE FEED ROW — chat grammar: a fixed avatar gutter on the left, the byline
 * (name · time · facts) on the first message of an author run, and the body
 * hanging under the name. Consecutive messages from the same author within a
 * short window render as FOLLOW rows: no repeated byline, the timestamp
 * surfaces in the gutter on hover. Row-level actions (reply, send again) live
 * in a hover-revealed bar so they never inflate the reading density.
 *
 * WHAT THIS FILE STILL REFUSES TO DO, since every one of these was a defect
 * somewhere in this build's history:
 *
 *   · It never drops a row it does not understand (S15). An unrecognised
 *     activity variant renders a safe card carrying timestamp, actor and an
 *     open-details route — the row is always at least navigable.
 *   · It never lets a delivery failure remove or grey out the MESSAGE (S19).
 *     Delivery is a badge on a stored thing; the stored thing is the fact.
 *   · It never recovers a redacted body from cache (S14). A tombstone keeps
 *     its position and its permitted metadata and nothing else.
 *
 * Provenance demotion is deliberate, not a loss: the canonical-anchor and
 * source-session line renders ONLY when it says something the surface does not
 * already imply — a foreign anchor or a source session. "This message in this
 * channel is anchored to this channel" is not information; repeating it under
 * every row was the single biggest source of feed noise.
 */

export interface FeedRowHandlers {
  /** Real dispatcher for Send again — posts a NEW message, never a retry. */
  onPost?: (body: string, parentMessageId: EntityId | null) => void;
  onReply?: (message: MessageView) => void;
  onOpenEntity?: (id: EntityId) => void;
  /** Loaded-page index for bounded reply previews; no recursive fetches here. */
  loadedMessages?: ReadonlyMap<EntityId, MessageView>;
  onFocusMessage?: (id: EntityId) => void;
}

export function FeedRowGroup({
  group,
  anchorId,
  clustered = false,
  handlers,
}: {
  group: FeedGroup;
  anchorId: EntityId;
  /** This row continues the author run above it — no repeated byline. */
  clustered?: boolean;
  handlers: FeedRowHandlers;
}) {
  if (group.kind === 'operation') {
    return <MutationGroupRow group={group} />;
  }
  return <FeedRow item={group.item} anchorId={anchorId} clustered={clustered} handlers={handlers} />;
}

function FeedRow({
  item,
  anchorId,
  clustered,
  handlers,
}: {
  item: FeedItem;
  anchorId: EntityId;
  clustered: boolean;
  handlers: FeedRowHandlers;
}) {
  const isMessage = item.itemKind === 'message';
  const cls = [
    'chs-row',
    clustered ? 'chs-row--follow' : '',
    isMessage ? '' : 'chs-row--activity',
  ].filter(Boolean).join(' ');
  return (
    <li className={cls}>
      <article
        className="chs-row__grid"
        {...(isMessage ? { 'data-feed-message-id': item.message.id, tabIndex: -1 } : {})}
      >
        <Gutter item={item} clustered={clustered} />
        <div className="chs-row__body">
          {isMessage ? (
            <MessageContent item={item} anchorId={anchorId} clustered={clustered} handlers={handlers} />
          ) : (
            <ActivityContent item={item} handlers={handlers} />
          )}
        </div>
        {isMessage && !item.message.state.redactedAt ? (
          <RowActions item={item} handlers={handlers} />
        ) : null}
      </article>
    </li>
  );
}

/**
 * The avatar gutter. First message of a run: the author's avatar (shape is
 * provenance — humans round, agents rounded-square). Follow rows and activity
 * rows: the timestamp, so every row still answers "when" without a byline.
 */
function Gutter({ item, clustered }: { item: FeedItem; clustered: boolean }) {
  if (item.itemKind === 'message' && !clustered) {
    const author = item.message.state.author ?? item.message.createdBy;
    return (
      <div className="chs-gutter">
        <Avatar
          actorId={author.id}
          provenance={author?.isAgent ? 'agent' : 'human'}
          label={author?.displayName ?? 'unknown'}
          size={32}
          src={author?.avatar ?? null}
        />
      </div>
    );
  }
  return (
    <div className="chs-gutter">
      <time
        className="chs-gutter__time"
        dateTime={item.createdAt}
        aria-label={accessibleDateTime(item.createdAt)}
      >
        {clockTime(item.createdAt)}
      </time>
    </div>
  );
}

/**
 * The hover action bar. Reply and Send again float over the row's top-right
 * corner instead of sitting in the byline — the 44px touch targets stay
 * honest without adding 44px to every row's height. An absent dispatcher is
 * still a visible refusal (R5 #9), never a hidden control.
 */
function RowActions({
  item,
  handlers,
}: {
  item: Extract<FeedItem, { itemKind: 'message' }>;
  handlers: FeedRowHandlers;
}) {
  return (
    <div className="chs-actions">
      {canSendAgain(item.delivery) ? <SendAgain item={item} handlers={handlers} /> : null}
      <ReplyButton message={item.message} onReply={handlers.onReply} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function MessageContent({
  item,
  anchorId,
  clustered,
  handlers,
}: {
  item: Extract<FeedItem, { itemKind: 'message' }>;
  anchorId: EntityId;
  clustered: boolean;
  handlers: FeedRowHandlers;
}) {
  const { message, delivery } = item;
  const author = message.state.author ?? message.createdBy;

  if (message.state.redactedAt) {
    /*
     * S14 — the tombstone. It keeps its PLACE (so replies below it still make
     * sense) and states who removed it and when, where that is permitted. The
     * body is not rendered from any cached copy: "the former title is not
     * recovered from cache" is the same law one level down.
     */
    return (
      <p className="chs-tomb" data-testid="chs-tombstone">
        {`⌀ message${author?.displayName ? ` from ${author.displayName}` : ''} redacted · ${clockTime(
          message.state.redactedAt,
        )} — replies keep their place`}
      </p>
    );
  }

  const summary = deliverySummaryLine(delivery);
  const single = delivery.length === 1 ? delivery[0] : null;

  return (
    <>
      {!clustered ? (
        <div className="chs-byline">
          <span className="chs-byline__who">{author?.displayName ?? 'unknown'}</span>
          {author?.isAgent ? <span className="chs-byline__kind">agent</span> : null}
          <time
            className="chs-byline__time"
            dateTime={message.createdAt}
            aria-label={accessibleDateTime(message.createdAt)}
          >
            {clockTime(message.createdAt)}
          </time>
          {message.state.editedAt ? (
            <span className="chs-byline__edited" title={`Edited ${accessibleDateTime(message.state.editedAt)}`}>
              edited
            </span>
          ) : null}
          {message.pending ? <Pill tone="idle">saving…</Pill> : null}
          {single ? <DeliveryBadge status={single.status} /> : null}
        </div>
      ) : null}

      <ContextLine item={item} anchorId={anchorId} onOpenEntity={handlers.onOpenEntity} />

      {message.state.rootMessageId ? (
        <ParentPreview
          id={message.state.rootMessageId}
          parent={handlers.loadedMessages?.get(message.state.rootMessageId) ?? null}
          onOpenEntity={handlers.onOpenEntity}
          onFocusMessage={handlers.onFocusMessage}
        />
      ) : null}

      <MessageBody message={message} onOpenEntity={handlers.onOpenEntity} />

      {summary && delivery.length > 1 ? <TargetList summary={summary} rows={delivery} /> : null}
    </>
  );
}

/**
 * The body, with the message's canonical mentions rendered IN PLACE.
 *
 * A mention whose `@display` token appears in the text becomes an inline
 * control right where it was typed; only mentions the text does NOT carry
 * fall through to trailing chips. Rendering both — the token in the text and
 * a chip repeating it below — was the duplication the screenshot complained
 * about. Matching is exact-token against the message's OWN mention list;
 * nothing in the body is guessed at.
 */
function MessageBody({
  message,
  onOpenEntity,
}: {
  message: MessageView;
  onOpenEntity?: (id: EntityId) => void;
}) {
  const { body } = message.content;
  const mentions = message.content.mentions;
  const attachments = message.content.attachments;

  type Match = { start: number; end: number; mention: (typeof mentions)[number] };
  const candidates: Match[] = [];
  for (const mention of mentions) {
    const token = `@${mention.display}`;
    for (let at = body.indexOf(token); at !== -1; at = body.indexOf(token, at + token.length)) {
      candidates.push({ start: at, end: at + token.length, mention });
    }
  }
  // Earliest first; on a tie the longer token wins so "@Haiku 4.5" beats "@Haiku".
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const matches: Match[] = [];
  let cursor = 0;
  for (const match of candidates) {
    if (match.start < cursor) continue;
    matches.push(match);
    cursor = match.end;
  }

  const inlined = new Set(matches.map((m) => `${m.mention.kind}:${m.mention.entityId}`));
  const trailing = mentions.filter((m) => !inlined.has(`${m.kind}:${m.entityId}`));

  const parts: ReactNode[] = [];
  let from = 0;
  for (const [index, match] of matches.entries()) {
    if (match.start > from) parts.push(body.slice(from, match.start));
    const label = `@${match.mention.display}`;
    parts.push(onOpenEntity ? (
      <button
        key={`m-${index}`}
        type="button"
        className="chs-mention-inline"
        aria-label={`Open mention ${match.mention.display}`}
        onClick={() => onOpenEntity(match.mention.entityId)}
      >
        {label}
      </button>
    ) : (
      <span key={`m-${index}`} className="chs-mention-inline">{label}</span>
    ));
    from = match.end;
  }
  if (from < body.length) parts.push(body.slice(from));

  return (
    <>
      <p className="chs-text">{parts}</p>
      {trailing.length > 0 || attachments.length > 0 ? (
        <div className="chs-references">
          {trailing.length > 0 ? (
            <ul className="chs-mentions" aria-label="Mentions">
              {trailing.map((mention) => (
                <li key={`${mention.kind}:${mention.entityId}`}>
                  {onOpenEntity ? (
                    <button
                      type="button"
                      className="chs-ref-chip"
                      aria-label={`Open mention ${mention.display}`}
                      onClick={() => onOpenEntity(mention.entityId)}
                    >
                      @{mention.display}
                    </button>
                  ) : <span className="chs-ref-chip">@{mention.display}</span>}
                </li>
              ))}
            </ul>
          ) : null}
          {attachments.length > 0 ? (
            <ul className="chs-attachments" aria-label="Attachments">
              {attachments.map((attachment) => (
                <li key={attachment.fileEntityId}>
                  {onOpenEntity ? (
                    <button
                      type="button"
                      className="chs-attachment"
                      aria-label={`Open attachment ${attachment.name}`}
                      onClick={() => onOpenEntity(attachment.fileEntityId)}
                    >
                      <span aria-hidden>▧</span>
                      <span>{attachment.name}</span>
                      <span className="chs-attachment__mime">{attachment.mime}</span>
                    </button>
                  ) : (
                    <span className="chs-attachment">
                      <span aria-hidden>▧</span>
                      <span>{attachment.name}</span>
                      <span className="chs-attachment__mime">{attachment.mime}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * Cross-surface provenance, rendered ONLY when it is news: the message
 * surfaced from a work session, or its canonical anchor is some OTHER entity
 * than the one this feed is anchored on. A message posted to this channel,
 * shown in this channel, says nothing here — that line was pure noise.
 */
function ContextLine({
  item,
  anchorId,
  onOpenEntity,
}: {
  item: Extract<FeedItem, { itemKind: 'message' }>;
  anchorId: EntityId;
  onOpenEntity?: (id: EntityId) => void;
}) {
  const canonicalId = item.anchor?.id ?? item.message.state.anchorId;
  const foreign = canonicalId && canonicalId !== anchorId
    ? { id: canonicalId, label: item.anchor?.title || canonicalId }
    : null;
  if (!item.sourceWorkSessionId && !foreign) return null;
  return (
    <p className="chs-message-meta" data-testid="chs-message-meta">
      {item.sourceWorkSessionId ? (
        <span className="chs-message-meta__part">
          <span>from session </span>
          {onOpenEntity ? (
            <button
              type="button"
              className="chs-linkbtn"
              aria-label="Open source session"
              onClick={() => onOpenEntity(item.sourceWorkSessionId!)}
            >
              {item.sourceWorkSessionId}
            </button>
          ) : <span>{item.sourceWorkSessionId}</span>}
        </span>
      ) : null}
      {foreign ? (
        <span className="chs-message-meta__part">
          <span>in </span>
          {onOpenEntity ? (
            <button
              type="button"
              className="chs-linkbtn"
              aria-label="Open canonical anchor"
              onClick={() => onOpenEntity(foreign.id)}
            >
              {foreign.label}
            </button>
          ) : <span>{foreign.label}</span>}
        </span>
      ) : null}
    </p>
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
            const reason = safeDeliveryReason(r.failureReason);
            return (
              <li
                key={r.deliveryId}
                className="chs-targets__row"
                data-delivery-status={r.status}
              >
                <span className="chs-targets__name">{r.targetWorkSessionId}</span>
                <span className={`chs-targets__state chs-targets__state--${p.tone}`} title={p.tooltip}>
                  {p.label}
                </span>
                {reason ? <span className="chs-targets__reason">{reason}</span> : null}
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
 * The reply's parent preview — a compact quote card the whole of which jumps
 * to the parent.
 *
 * HONEST LIMIT, stated rather than papered over: `MessageView` carries the
 * parent's ID and nothing else, and this surface holds only the page it was
 * given — so an excerpt is available only if the parent happens to be on that
 * page, which is not a guarantee this component can make. Rather than render a
 * sometimes-excerpt that silently degrades, it renders the RELATIONSHIP, which
 * is always true. The oracle's excerpt needs a parent-hydration read that the
 * seam does not expose; it is filed in HANDOVER.md under GAPS.
 */
function ParentPreview({
  id,
  parent,
  onOpenEntity,
  onFocusMessage,
}: {
  id: EntityId;
  parent: MessageView | null;
  onOpenEntity?: (id: EntityId) => void;
  onFocusMessage?: (id: EntityId) => void;
}) {
  const author = parent?.state.author ?? parent?.createdBy ?? null;
  const preview = parent
    ? parent.state.redactedAt
      ? 'redacted message'
      : parent.content.body
    : id;
  const inner = (
    <>
      <span aria-hidden className="chs-parent__glyph">↩</span>
      {author ? <InlineActor actor={author} className="chs-parent__author" /> : null}
      <span className="chs-parent__excerpt">{preview}</span>
    </>
  );
  if (onFocusMessage || onOpenEntity) {
    return (
      <div className="chs-parent" data-testid="chs-parent">
        <button
          type="button"
          className="chs-parent__jump"
          aria-label="Focus parent message"
          onClick={() => (parent && onFocusMessage ? onFocusMessage(id) : onOpenEntity?.(id))}
        >
          {inner}
        </button>
      </div>
    );
  }
  return (
    <div className="chs-parent" data-testid="chs-parent">
      <span className="chs-parent__jump">{inner}</span>
    </div>
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
  const presentation = activityPresentation(item);

  if (presentation.kind === 'entity-change') {
    const entity = presentation.entity;
    return (
      <div className="chs-artifact" data-testid="chs-artifact">
        <span className="chs-artifact__kind">{entity.kind}</span>
        <strong className="chs-artifact__title">{entity.title}</strong>
        {entity.excerpt ? <span className="chs-artifact__excerpt">{entity.excerpt}</span> : null}
        <span className="chs-artifact__provenance">
          <span>{`${presentation.verb} by `}</span>
          {item.actor ? <InlineActor actor={item.actor} /> : <span>unknown</span>}
          {item.sourceWorkSessionId ? <span>{` · session ${item.sourceWorkSessionId}`}</span> : null}
        </span>
        {handlers.onOpenEntity ? (
          <button
            type="button"
            className="chs-linkbtn"
            aria-label={`Open ${entity.title}`}
            onClick={() => handlers.onOpenEntity?.(entity.id)}
          >
            open details →
          </button>
        ) : <OpenDetails id={entity.id} onOpenEntity={handlers.onOpenEntity} />}
      </div>
    );
  }

  if (presentation.kind === 'state') {
    return (
      <p className="chs-state" data-testid="chs-state">
        <span aria-hidden className="chs-state__dot" />
        {item.actor ? <InlineActor actor={item.actor} className="chs-state__actor" /> : null}
        <span className="chs-state__verb">{presentation.label}</span>
        {presentation.from ? (
          <>
            <span className="chs-state__from">{presentation.from}</span>
            <span aria-hidden className="chs-state__arrow">→</span>
          </>
        ) : null}
        <span className="chs-state__to">{presentation.to}</span>
      </p>
    );
  }

  if (presentation.kind === 'event') {
    return (
      <p className="chs-state chs-state--event" data-testid="chs-event">
        <span aria-hidden className="chs-state__dot" />
        <span className="chs-state__verb">{presentation.label}</span>
        {item.actor ? <InlineActor actor={item.actor} prefix="by " /> : null}
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
      {item.actor ? <InlineActor actor={item.actor} className="chs-unknown__actor" /> : null}
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
function MutationGroupRow({ group }: { group: Extract<FeedGroup, { kind: 'operation' }> }) {
  const [open, setOpen] = useState(false);
  const head = group.items[0];
  const actor = head.actor;
  return (
    <li className="chs-row chs-row--activity">
      <article className="chs-row__grid">
        <div className="chs-gutter">
          <time
            className="chs-gutter__time"
            dateTime={head.createdAt}
            aria-label={accessibleDateTime(head.createdAt)}
          >
            {clockTime(head.createdAt)}
          </time>
        </div>
        <div className="chs-row__body">
          <div className="chs-group" data-testid="chs-group">
            <span aria-hidden className="chs-group__glyph">
              ⇄
            </span>
            {actor ? <InlineActor actor={actor} /> : <span className="chs-group__text">someone</span>}
            <span className="chs-group__text">{`changed ${group.items.length} records`}</span>
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

/** One compact actor spelling for every activity/reply variant. */
function InlineActor({
  actor,
  prefix = '',
  className = '',
}: {
  actor: ActorSummary;
  prefix?: string;
  className?: string;
}) {
  return (
    <span className={`chs-inline-actor ${className}`.trim()}>
      {prefix ? <span>{prefix}</span> : null}
      <Avatar
        actorId={actor.id}
        provenance={actor.isAgent ? 'agent' : 'human'}
        label={actor.displayName}
        size={15}
        src={actor.avatar ?? null}
      />
      <span>{actor.displayName}</span>
    </span>
  );
}
