/**
 * MessageRow — one message in the thread, at any depth.
 *
 * Agent messages are visually distinct (AGENT badge, rounded-square avatar
 * from the kit, a tinted rail) but stay IN FLOW: an agent's progress report is
 * a message like any other, never a sidebar. Replies hang off the row as a
 * collapsible subtree; a soft-deleted message keeps its slot as a tombstone so
 * the replies underneath it still make sense.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Avatar, IconBtn, Timestamp, absTime } from '../../kit';
import { Tombstone } from '../../entity';
import { isTombstoned } from '../../registry';
import type { ActorSummary, EntityId, FileAttachment, Mention, MessageView } from '../../types/contract';
import { AttachmentGallery } from './AttachmentPreview';
import { MessageBody } from './MessageBody';
import { draftFromMarkup, markupFromBody } from './body';
import type { MessageNode } from './types';

/** Read-only fallback until Railway's ReactionsPointsBar fills the slot. */
export function ReactionsReadout({ message }: { message: MessageView }) {
  const c = message.counters;
  return (
    <span className="cv2-thread__reactions" data-slot="reactions">
      <span className="cv2-count" title="likes">👍 {c.likes}</span>
      {c.dislikes > 0 && <span className="cv2-count" title="dislikes">👎 {c.dislikes}</span>}
      <span className="cv2-count" title="stars">⭐ {c.stars}</span>
      {c.points > 0 && <span className="cv2-count" title="points">◈ {c.points}</span>}
    </span>
  );
}

export interface MessageRowProps {
  node: MessageNode;
  viewer?: ActorSummary;
  expanded: boolean;
  onToggleReplies: (id: EntityId) => void;
  onReply: (message: MessageView) => void;
  onEdit: (id: EntityId, draft: { body: string; mentions?: Mention[] }) => Promise<void>;
  onDelete: (id: EntityId) => void;
  reactionsSlot?: (message: MessageView) => ReactNode;
  /** True for the first message after the unread divider. */
  unread?: boolean;
  compact?: boolean;
}

export function MessageRow({
  node, viewer, expanded, onToggleReplies, onReply, onEdit, onDelete,
  reactionsSlot, unread = false, compact = false,
}: MessageRowProps) {
  const { message, depth } = node;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const author = message.state.author;
  const isMine = viewer != null && author.id === viewer.id;
  const replyCount = node.children.length + node.missingReplies;
  const indent = Math.min(depth, 6) * 20;

  if (isTombstoned(message)) {
    return (
      <article
        className="cv2-thread__msg cv2-thread__msg--tombstone"
        data-cv2-msg={message.id}
        data-depth={depth}
        style={{ marginLeft: indent }}
      >
        <Tombstone entity={message} variant="chip" />
        {replyCount > 0 && (
          <button type="button" className="cv2-thread__replytoggle"
            aria-expanded={expanded} onClick={() => onToggleReplies(message.id)}>
            {expanded ? '▾' : '▸'} {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
          </button>
        )}
      </article>
    );
  }

  const commit = (): void => {
    const { body, mentions } = draftFromMarkup(draft);
    if (!body.trim() || body === message.content.body) { setEditing(false); return; }
    setBusy(true);
    onEdit(message.id, { body, mentions })
      .then(() => setEditing(false))
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  return (
    <article
      className="cv2-thread__msg"
      data-cv2-msg={message.id}
      data-depth={depth}
      data-agent={author.isAgent || undefined}
      data-unread={unread || undefined}
      style={{ marginLeft: indent }}
      aria-label={`${author.displayName}${author.isAgent ? ' (agent)' : ''}`}
    >
      <Avatar actor={author} size={compact ? 22 : 26} />
      <div className="cv2-thread__main">
        <header className="cv2-thread__head">
          <span className="cv2-thread__author">{author.displayName}</span>
          {author.isAgent && <span className="cv2-thread__agent">AGENT</span>}
          {/* A message is about when it was said, so this is createdAt — an
              edit does not move it up the thread and must not move its time. */}
          <Timestamp className="cv2-thread__time" at={message.createdAt} />
          {message.state.editedAt && (
            <span className="cv2-thread__edited" title={`edited ${absTime(message.state.editedAt)}`}>edited</span>
          )}
        </header>

        {editing ? (
          <div className="cv2-thread__editor">
            <textarea
              ref={inputRef}
              className="cv2-thread__editinput"
              aria-label="Edit message"
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
                if (e.key === 'Escape') setEditing(false);
              }}
            />
            <div className="cv2-thread__editactions">
              <button type="button" className="cv2-actionbtn cv2-actionbtn--primary" disabled={busy} onClick={commit}>Save</button>
              <button type="button" className="cv2-actionbtn" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <MessageBody body={message.content.body} mentions={message.content.mentions} compact={compact} />
        )}

        <AttachmentGallery attachments={message.content.attachments} />

        <footer className="cv2-thread__foot">
          {reactionsSlot ? reactionsSlot(message) : <ReactionsReadout message={message} />}
          <button type="button" className="cv2-thread__act" onClick={() => onReply(message)}>Reply</button>
          {isMine && !editing && (
            <button type="button" className="cv2-thread__act" onClick={() => {
              setDraft(markupFromBody(message.content.body, message.content.mentions));
              setEditing(true);
            }}>Edit</button>
          )}
          {isMine && (
            <button type="button" className="cv2-thread__act cv2-thread__act--danger"
              onClick={() => onDelete(message.id)}>Delete</button>
          )}
          {replyCount > 0 && (
            <button type="button" className="cv2-thread__replytoggle"
              aria-expanded={expanded} onClick={() => onToggleReplies(message.id)}>
              {expanded ? '▾' : '▸'} {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
            </button>
          )}
        </footer>
      </div>
    </article>
  );
}

/** The optimistic row: what you typed, dimmed, until the command lands. */
export function PendingRow({
  body, mentions, attachments, author, failed, onRetry, onDiscard,
}: {
  body: string;
  mentions: readonly Mention[];
  attachments: readonly FileAttachment[];
  author?: ActorSummary;
  failed?: { code: string; message: string };
  onRetry: () => void;
  onDiscard: () => void;
}) {
  return (
    <article
      className="cv2-thread__msg cv2-thread__msg--pending"
      data-cv2-pending="true"
      data-failed={failed ? failed.code : undefined}
    >
      {author ? <Avatar actor={author} size={26} /> : <span className="cv2-thread__avatarghost" aria-hidden="true" />}
      <div className="cv2-thread__main">
        <header className="cv2-thread__head">
          <span className="cv2-thread__author">{author?.displayName ?? 'You'}</span>
          <span className="cv2-thread__time">{failed ? 'failed' : 'sending…'}</span>
        </header>
        <MessageBody body={body} mentions={mentions} compact />
        <AttachmentGallery attachments={attachments} />
        {failed && (
          <div className="cv2-thread__failed" role="alert">
            <span className="t-code">{failed.code}</span>
            <span>{failed.message}</span>
            <IconBtn aria-label="Retry sending" onClick={onRetry}>↻</IconBtn>
            <IconBtn aria-label="Discard message" onClick={onDiscard}>✕</IconBtn>
          </div>
        )}
      </div>
    </article>
  );
}
