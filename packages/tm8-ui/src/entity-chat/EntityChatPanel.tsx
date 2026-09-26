/**
 * `EntityChatPanel` — ONE component for every place the chat slot renders
 * (design 01a0da4e §3.3): Home's third column, Home's overlay sheet, Work's
 * centre and the phone's sheet all draw this; only where they put it differs.
 *
 * PRESENTATIONAL. It is handed the slot, the subject, the chats about it and a
 * body, and reports intents (open the subject, switch thread, new, close). It
 * reads no store and no seam, so each layout lane can host it without the
 * panel knowing which layout it is in. `EntityChatSlot` is the host that wires
 * it to the route and the seam.
 *
 * HEADER, left to right:
 *   · the SUBJECT CHIP — "about ‹title›", clickable (Q4: the chat stays pinned
 *     to its subject, and the chip is how the viewer gets back to it);
 *   · the SWITCHER — `Chat 2 of 3 ▾`, this entity's chats newest first, each
 *     with its title, teammate and last turn;
 *   · `+ New` and Close.
 */
import { EntityAttentionChip } from '../attention';
import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import type { EntityId } from '@tm8/contract';
import type { ChatSlot } from '../routes';
import { useDismissable } from '../panels/useDismissable';
import { relativeTime } from '../messages/messages-model';
import type { ChatAboutRow } from './chatsAbout';

export interface EntityChatSubject {
  id: EntityId;
  /** `null` while the subject's own read is in flight. */
  title: string | null;
  /** The kind's chip glyph, when known. */
  glyph?: string | undefined;
}

export interface EntityChatPanelProps {
  slot: ChatSlot;
  subject: EntityChatSubject;
  /** Newest first. `null` until the first read lands. */
  chats: readonly ChatAboutRow[] | null;
  /** The switcher's teammate column. Absent or `null` ⇒ the column is omitted. */
  teammateLabel?: ((id: EntityId) => string | null) | undefined;
  /** The subject chip's press. Absent ⇒ the chip is plain text, not a button. */
  onOpenSubject?: ((id: EntityId) => void) | undefined;
  /** A switcher pick or `+ New`. The host REPLACES the slot's thread (§3.1). */
  onSelectThread(thread: EntityId | 'new'): void;
  onClose(): void;
  /** The conversation (or, for `new`, the composer and anything gating it). */
  children: ReactNode;
  /** For "now" in the switcher's last-turn column; injectable for tests. */
  now?: Date;
}

/** `Chat 2 of 3`, `New chat`, or a bare `Chat` while the list catches up. */
export function switcherCaption(thread: EntityId | 'new', chats: readonly ChatAboutRow[] | null): string {
  if (thread === 'new') return 'New chat';
  if (!chats) return 'Chat';
  const at = chats.findIndex((chat) => chat.id === thread);
  /* A just-created chat is on screen before the about-edge event has re-read
     the list. "Chat" is true; "Chat 0 of 2" would not be. */
  if (at === -1) return 'Chat';
  return `Chat ${at + 1} of ${chats.length}`;
}

export function EntityChatPanel({
  slot,
  subject,
  chats,
  teammateLabel,
  onOpenSubject,
  onSelectThread,
  onClose,
  children,
  now,
}: EntityChatPanelProps) {
  const [open, setOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement | null>(null);
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissable(open, switcherRef, dismiss);
  const menuId = useId();

  const title = subject.title ?? '…';
  const subjectLabel = `${subject.glyph ? `${subject.glyph} ` : ''}${title}`;
  const count = chats?.length ?? 0;
  const at = now ?? new Date();

  return (
    <section
      className="ecp"
      aria-label={`Chat about ${title}`}
      data-testid="entity-chat-panel"
      data-thread={slot.thread}
    >
      <header className="ecp__head">
        {onOpenSubject ? (
          <button
            type="button"
            className="ecp__subject"
            title={`Open ${title}`}
            data-testid="entity-chat-subject"
            onClick={() => onOpenSubject(subject.id)}
          >
            <span className="ecp__about">about</span> <span className="ecp__subject-title">{subjectLabel}</span>
          </button>
        ) : (
          <span className="ecp__subject" data-testid="entity-chat-subject">
            <span className="ecp__about">about</span> <span className="ecp__subject-title">{subjectLabel}</span>
          </span>
        )}
        <div className="ecp__switcher" ref={switcherRef}>
          <button
            type="button"
            className="ecp__switch"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            data-testid="entity-chat-switcher"
            /* Nothing to switch to while the list is empty — the button still
               names where the viewer is, and `+ New` is beside it. */
            disabled={count === 0}
            onClick={() => setOpen((value) => !value)}
          >
            {switcherCaption(slot.thread, chats)}
            {count > 0 ? <span aria-hidden> ▾</span> : null}
          </button>
          {open && chats && chats.length > 0 ? (
            <ul className="ecp__menu" role="menu" id={menuId} data-testid="entity-chat-switcher-menu">
              {chats.map((chat) => {
                const teammate = chat.teammateId ? (teammateLabel?.(chat.teammateId) ?? null) : null;
                const current = chat.id === slot.thread;
                return (
                  <li key={chat.id} role="none">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={current}
                      className={`ecp__item${current ? ' ecp__item--on' : ''}`}
                      data-testid={`entity-chat-item-${chat.id}`}
                      onClick={() => {
                        setOpen(false);
                        if (!current) onSelectThread(chat.id);
                      }}
                    >
                      <span className="ecp__item-title">{chat.title}</span>
                      <span className="ecp__item-meta">
                        <EntityAttentionChip entity={{ id: chat.id }} compact />
                        {teammate ? <span className="ecp__item-who">{teammate}</span> : null}
                        <span className="ecp__item-when">{relativeTime(chat.lastActivityAt, at)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
        <button
          type="button"
          className="ecp__new"
          data-testid="entity-chat-new"
          disabled={slot.thread === 'new'}
          onClick={() => onSelectThread('new')}
        >
          + New
        </button>
        <button
          type="button"
          className="ecp__close"
          aria-label="Close chat"
          title="Close chat"
          data-testid="entity-chat-close"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="ecp__body">{children}</div>
    </section>
  );
}
