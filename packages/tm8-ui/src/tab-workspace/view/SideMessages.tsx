/**
 * The side column's Messages section (task 01a122b9, D4/D5): the entity's
 * conversation as a list — one compact row per message (avatar, author, time,
 * a two-line preview), oldest at the top, newest beside a one-row composer.
 * A row expands in place to its full markdown.
 *
 * The reading is the Messages tab's own: `useAnchorFeed` on the entity, no
 * scope, so the server resolves the conversation per kind and this list and
 * the old full-page surface can never disagree about what was said.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { EntityId, FeedItem, MessageView } from '@tm8/contract';
import { useAnchorFeed } from '../../channel-screen/useAnchorFeed';
import type { GateData } from '../../views/useGateData';
import { Avatar } from '../../kit/Avatar';
import { Markdown } from '../../kit/Markdown';
import { absTime, relTime } from '../../kit/time';

type MessageItem = Extract<FeedItem, { itemKind: 'message' }>;

/** The composer grows with what is typed, up to this many lines. */
const COMPOSER_MAX_LINES = 5;
/** A reader this close to the end stays pinned to the newest message. */
const AT_END_PX = 24;

export interface SideMessagesProps {
  data: GateData;
  entityId: EntityId;
  viewerMemberId: string;
  /** Whether the viewer may post here (edit or react capability). */
  canPost: boolean;
  onOpenEntity?: (id: EntityId) => void;
}

export function SideMessages({ data, entityId, viewerMemberId, canPost, onOpenEntity }: SideMessagesProps) {
  const feed = useAnchorFeed({
    seam: data.seam,
    anchorId: entityId,
    spaceId: data.spaceId,
    viewerMemberId,
    filter: 'workspace-side-messages',
    postMessage: data.postMessage,
  });
  const messages = (feed.page?.items ?? []).filter((item): item is MessageItem => item.itemKind === 'message');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setExpanded((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /* Follow the newest message while the reader is at the end. */
  const listRef = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const newest = messages[messages.length - 1]?.message.id;
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [newest, messages.length]);

  if (feed.error) {
    return (
      <div className="tws-side-state" role="alert">
        <p>This conversation could not be read.</p>
        <button type="button" className="tws-side-state__action" onClick={() => void feed.reload()}>
          Retry
        </button>
      </div>
    );
  }
  if (feed.refusal) {
    return (
      <div className="tws-side-state" role="status">
        <p>{feed.refusal.kind === 'forbidden' ? 'You cannot read this conversation.' : 'This conversation is gone.'}</p>
      </div>
    );
  }

  return (
    <div className="tws-side-messages" data-testid="tws-side-messages">
      <div
        ref={listRef}
        className="tws-side-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_END_PX;
        }}
      >
        {feed.page?.nextCursor ? (
          <button
            type="button"
            className="tws-side-more"
            disabled={feed.loadingEarlier}
            onClick={() => void feed.loadOlder()}
          >
            {feed.loadingEarlier ? 'Loading…' : 'Load earlier'}
          </button>
        ) : null}
        {feed.loading && messages.length === 0 ? (
          <div className="tws-side-skeleton" aria-busy="true" aria-label="Loading messages">
            <span />
            <span />
            <span />
          </div>
        ) : messages.length === 0 ? (
          <p className="tws-side-empty">No messages yet.</p>
        ) : (
          <ul className="tws-side-list" aria-label="Messages">
            {messages.map((item) => (
              <MessageRow
                key={item.message.id}
                message={item.message}
                open={expanded.has(item.message.id)}
                onToggle={() => toggle(item.message.id)}
                onOpenEntity={onOpenEntity}
              />
            ))}
          </ul>
        )}
      </div>
      {canPost ? (
        <Composer
          draft={feed.draft}
          onDraft={feed.setDraft}
          disabled={feed.uncertainMutation !== null}
          onSend={(body) => {
            atEnd.current = true;
            return feed.post({ anchorIds: [entityId], body, parentMessageId: null });
          }}
        />
      ) : null}
    </div>
  );
}

function MessageRow({
  message,
  open,
  onToggle,
  onOpenEntity,
}: {
  message: MessageView;
  open: boolean;
  onToggle: () => void;
  onOpenEntity?: (id: EntityId) => void;
}) {
  const author = message.state.author;
  const body = message.content.body;
  const at = message.createdAt;
  return (
    <li className="tws-side-row tws-side-row--message" data-open={open || undefined} data-pending={message.pending || undefined}>
      <button
        type="button"
        className="tws-side-row__hit"
        aria-expanded={open}
        onClick={(e) => {
          /* A link inside an expanded message is its own target. */
          if ((e.target as HTMLElement).closest('a, .md-root button')) return;
          onToggle();
        }}
      >
        <Avatar
          actorId={author.id}
          provenance={author.kind === 'member' ? 'human' : 'agent'}
          label={author.displayName}
          size={20}
          className="tws-side-row__lead"
        />
        <span className="tws-side-row__main">
          <span className="tws-side-row__line">
            <span className="tws-side-row__title">{author.displayName}</span>
            <time className="tws-side-row__when" dateTime={at} title={absTime(at)}>
              {relTime(at)}
            </time>
          </span>
          {open ? null : <span className="tws-side-row__preview">{previewOf(body)}</span>}
          {!open && message.replyCount > 0 ? (
            <span className="tws-side-row__meta">
              {`↳ ${message.replyCount} ${message.replyCount === 1 ? 'reply' : 'replies'}`}
            </span>
          ) : null}
        </span>
      </button>
      {open ? (
        <div className="tws-side-row__body">
          <Markdown source={body} onOpenEntity={onOpenEntity ? (id) => onOpenEntity(id as EntityId) : undefined} />
          {message.replyCount > 0 ? (
            <span className="tws-side-row__meta">
              {`↳ ${message.replyCount} ${message.replyCount === 1 ? 'reply' : 'replies'}`}
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Markdown read as one plain line of prose — the row's preview, not its body. */
export function previewOf(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ONE ROW TALL (D5): a single-line field that grows only while a longer
 * message is typed, to `COMPOSER_MAX_LINES`. Enter sends; Shift+Enter breaks
 * the line.
 */
function Composer({
  draft,
  onDraft,
  onSend,
  disabled,
}: {
  draft: string;
  onDraft: (body: string) => void;
  onSend: (body: string) => Promise<void>;
  disabled: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight) || 18;
    el.style.height = `${Math.min(el.scrollHeight, line * COMPOSER_MAX_LINES + 8)}px`;
  }, [draft]);
  const body = draft.trim();
  const send = () => {
    if (!body || sending || disabled) return;
    setSending(true);
    onSend(body)
      .then(() => onDraft(''))
      .catch(() => undefined)
      .finally(() => setSending(false));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    send();
  };
  return (
    <form
      className="tws-side-composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        className="tws-side-composer__input"
        aria-label="Write a message"
        placeholder="Write a message…"
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="submit"
        className="tws-side-composer__send"
        aria-label="Send"
        title="Send (Enter)"
        disabled={!body || sending || disabled}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </form>
  );
}
