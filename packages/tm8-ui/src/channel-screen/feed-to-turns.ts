/**
 * A FEED MESSAGE AS A CHAT TURN — the adapter that lets a channel (and a
 * session's Chat tab, which shares `ChannelScreen`) draw every message with
 * chat's own `ChatTurn` instead of a second row grammar.
 *
 * The shape is `chat-home/types.ts` `ChatTurn`, unchanged: the transcript lane
 * maps its entries onto the same type, so all three surfaces render one
 * component. Channel-only facts (delivery, threads, mentions, context) are not
 * squeezed into it — the row passes them to `ChatTurn` as byline and footer
 * chrome.
 */
import type { MessageView } from '@tm8/contract';
import type { ChatTurn } from '../chat-home/types';
import { turnPartFromMessagePart } from '../chat-home/wire';

export function chatTurnFromMessage(message: MessageView): ChatTurn {
  const author = message.state.author ?? message.createdBy ?? null;
  const parts = (message.parts ?? []).map(turnPartFromMessagePart);
  /*
   * AN AGENT'S PLAIN MESSAGE READS AS A CHAT ANSWER. Chat draws an answer as
   * its text part — a reading column, no bubble — and a bubble only for a
   * typed message. A session reporting into a channel writes a body and no
   * parts (`append_chat_message_part` only accepts chat turns), so its report
   * would otherwise land in a bubble that chat never draws for an agent. One
   * text part carrying the body puts it through the same `TurnParts` path.
   */
  if (author?.isAgent && parts.length === 0 && !message.turnInFlight && message.content.body.trim()) {
    parts.push({ seq: 0, kind: 'text', text: message.content.body });
  }
  return {
    messageId: message.id,
    /* An agent's message reads as an answer, a person's as a typed message —
       the same split chat's own turns carry. */
    role: author?.isAgent ? 'assistant' : 'user',
    author,
    createdAt: message.createdAt,
    body: message.content.body,
    parts,
    attachments: message.content.attachments,
    ...(message.turnInFlight ? { turnInFlight: true } : {}),
  };
}
