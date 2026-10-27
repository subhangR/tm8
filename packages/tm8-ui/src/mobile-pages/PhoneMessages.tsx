/**
 * THE MESSAGES SECTION of a phone entity page (CONTRACT §5 ruling 8, owner
 * 2026-10-18): the latest three messages and "View all".
 *
 * Task, doc and session pages draw it below the body and above Linked; the
 * generic entity page draws it under Linked. It is a READING of the
 * discussion, not the discussion: the composer and the full thread stay where
 * they already live (the Discussion sheet), so "View all" and a tap on a
 * message both open that, and nothing here posts.
 */
import type { ReactNode } from 'react';
import type { MessageView } from '@tm8/contract';
import { phoneTime } from '../mobile-lists/phone-row';
import './phone-page.css';

export const MESSAGES_PREVIEW = 3;

export interface PhoneMessagesProps {
  /** Undefined while the read has not landed — drawn as a quiet loading line. */
  messages: readonly MessageView[] | undefined;
  /** The whole thread's count, when it is known to be larger than what was read. */
  total?: number;
  /** Opens the full discussion. Absent ⇒ every loaded message is listed here. */
  onViewAll?: () => void;
  className?: string;
}

export function PhoneMessages(props: PhoneMessagesProps): ReactNode {
  const { messages, onViewAll } = props;
  const now = Date.now();
  const sorted = messages
    ? [...messages].filter((m) => !m.deletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    : [];
  const total = Math.max(props.total ?? 0, sorted.length);
  /* The LATEST three, still in reading order: oldest of the three on top. */
  const shown = onViewAll ? sorted.slice(-MESSAGES_PREVIEW) : sorted;
  return (
    <section className={props.className ? `pp-sec ${props.className}` : 'pp-sec'} aria-label="Messages" data-testid="phone-messages">
      <h2 className="pp-sec__h">
        Messages
        {total > 0 ? <span className="pp-sec__n">{total}</span> : null}
      </h2>
      {messages === undefined ? (
        <p className="pp-quiet">Loading messages…</p>
      ) : shown.length === 0 ? (
        <p className="pp-quiet">No messages yet.</p>
      ) : (
        <ul className="pp-msgs">
          {shown.map((m) => {
            const author = m.state.author.displayName || 'Someone';
            const body = (
              <>
                <span className="pp-msg__av" aria-hidden>
                  {author.slice(0, 1).toUpperCase()}
                </span>
                <span className="pp-msg__b">
                  <span className="pp-msg__l1">
                    <span className="pp-msg__who">{author}</span>
                    <time className="pp-msg__tm" dateTime={m.createdAt}>
                      {phoneTime(m.createdAt, now)}
                    </time>
                  </span>
                  <span className="pp-msg__tx">{m.content.body}</span>
                </span>
              </>
            );
            return (
              <li key={m.id}>
                {onViewAll ? (
                  <button type="button" className="pp-msg" data-testid="phone-message" onClick={onViewAll}>
                    {body}
                  </button>
                ) : (
                  <div className="pp-msg" data-testid="phone-message">
                    {body}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {onViewAll ? (
        <button type="button" className="pp-more" data-testid="phone-messages-all" onClick={onViewAll}>
          {total === 0 ? 'Open discussion' : total > shown.length ? `View all ${total}` : 'View all'}
        </button>
      ) : null}
    </section>
  );
}
