/**
 * MessageBody — the body of a message, rendered from its token segments.
 *
 * `{{embed:id}}` becomes a LIVE Z2 card (`CardById`, so it re-renders as the
 * entity changes — a task embedded last week shows today's status), `{{ref:id}}`
 * and `@mentions` become Z1 chips. Nothing here knows about kinds: the entity
 * layer resolves each id through the registry.
 */
import { Fragment, type ReactNode } from 'react';
import { CardById, ChipById } from '../../entity';
import type { Mention } from '../../types/contract';
import { parseBody } from './body';

export interface MessageBodyProps {
  body: string;
  mentions?: readonly Mention[];
  /** Suppresses live embed cards (collapsed/preview contexts). */
  compact?: boolean;
}

export function MessageBody({ body, mentions = [], compact = false }: MessageBodyProps) {
  const segments = parseBody(body, mentions);
  const text: ReactNode[] = [];
  const blocks: ReactNode[] = [];

  segments.forEach((seg, i) => {
    if (seg.type === 'text') {
      text.push(<Fragment key={i}>{seg.text}</Fragment>);
    } else if (seg.type === 'mention') {
      text.push(
        <span key={i} className="cv2-thread__mention" data-mention-id={seg.entityId}>
          <ChipById entityId={seg.entityId} />
        </span>,
      );
    } else if (seg.type === 'ref') {
      text.push(
        <span key={i} className="cv2-thread__ref" data-ref-id={seg.entityId}>
          <ChipById entityId={seg.entityId} />
        </span>,
      );
    } else if (compact) {
      text.push(
        <span key={i} className="cv2-thread__ref" data-embed-id={seg.entityId}>
          <ChipById entityId={seg.entityId} />
        </span>,
      );
    } else {
      blocks.push(
        <div key={`e${i}`} className="cv2-thread__embed" data-embed-id={seg.entityId}>
          <CardById entityId={seg.entityId} />
        </div>,
      );
    }
  });

  // A mention whose display never appears in the prose (an agent posting with
  // a structured `mentions[]`, a body edited around it) still has to be
  // visible — it drove a notification. Show it as a trailing chip row.
  const inline = new Set(segments.filter((s) => s.type === 'mention').map((s) => s.entityId));
  const offscreen = mentions.filter((m) => !inline.has(m.entityId));

  return (
    <>
      <div className="cv2-thread__body">{text}</div>
      {offscreen.length > 0 && (
        <div className="cv2-thread__mentions" aria-label="Mentions">
          {offscreen.map((m) => (
            <span key={m.entityId} className="cv2-thread__mention" data-mention-id={m.entityId}>
              <ChipById entityId={m.entityId} />
            </span>
          ))}
        </div>
      )}
      {blocks}
    </>
  );
}
