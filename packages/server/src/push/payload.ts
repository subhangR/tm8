/**
 * NotificationItem → PushPayloadV1, for one device's previews setting.
 *
 * THE WORDS are the inbox's (packages/tm8-ui/src/inbox/inbox-model.ts, VERB
 * and headlineOf): a push says what the recipient's inbox row says, "Priya
 * mentioned you", and with no actor the verb stands alone, capitalised, because
 * inventing "Someone" puts a made-up fact on the loudest line. Two kinds that
 * table has no verb for are named as the server writes them: `message_reply`
 * (the web table keys it `reply`) and `anchor_message` (077, a message on a
 * task you watch), which would otherwise humanise to "anchor message".
 *
 * THE PREVIEWS SETTING decides how much of that text leaves the node, because
 * the relay sees every byte of a payload (decide Q5):
 *   full    the headline (with "in #channel" for a message), and the quoted
 *           message or the target's title (s-inbox: "Priya mentioned you in
 *           #mobile" · the message; "Marco assigned you" · the task title)
 *   sender  the headline only: who, and what kind of thing, never a title,
 *           a channel name or message text
 *   none    "New notification", nothing else
 * `data` is ids and the web address whatever the setting.
 */
import {
  PUSH_BODY_MAX,
  PUSH_PAYLOAD_VERSION,
  PUSH_TITLE_MAX,
  pushRouteOf,
  pushThreadIdOf,
  type NotificationItem,
  type PushPayloadV1,
  type PushPreviews,
} from '@tm8/contract';

const VERB: Readonly<Record<string, string>> = {
  mention: 'mentioned you',
  assignment: 'assigned you',
  reply: 'replied',
  message_reply: 'replied',
  anchor_message: 'posted',
  review_request: 'requested your review',
  unblock: 'unblocked you',
  award: 'awarded you',
  stale: 'flagged this as stale',
};

/** Kinds that are about a message: their full preview quotes it. */
const MESSAGE_KINDS: ReadonlySet<string> = new Set(['mention', 'reply', 'message_reply', 'anchor_message']);

export const NO_PREVIEW_BODY = 'New notification';

/** One line: control characters and runs of whitespace become one space. */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim();
}

/** Cut to `max` UTF-16 units with an ellipsis, never splitting a surrogate pair. */
function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

function verbOf(kind: string): string {
  return Object.prototype.hasOwnProperty.call(VERB, kind) ? VERB[kind]! : kind.replace(/[_-]+/g, ' ');
}

/** The inbox headline: actor + verb, or the verb alone, capitalised. */
export function pushHeadlineOf(item: NotificationItem): string {
  const verb = oneLine(verbOf(item.kind));
  const actor = oneLine(item.actor?.displayName ?? '');
  if (!actor) return verb.charAt(0).toUpperCase() + verb.slice(1);
  return `${actor} ${verb}`;
}

/**
 * The web address of what the push is about, on the web's own routes
 * (packages/tm8-ui/src/routes/codec.ts): a channel message opens the channel at
 * the message, anything else its entity page, and a row about nothing the
 * recipient can read opens the inbox.
 */
export function pushWebAddressOf(origin: string, item: NotificationItem, messageId: string | null): string {
  const space = `${origin}/#/s/${encodeURIComponent(item.spaceId)}`;
  const target = item.target ?? null;
  if (!target) return `${space}/inbox`;
  const id = encodeURIComponent(target.id);
  if (target.kind === 'channel') {
    return messageId ? `${space}/channel/${id}?msg=${encodeURIComponent(messageId)}` : `${space}/channel/${id}`;
  }
  return `${space}/e/${id}`;
}

function textsFor(item: NotificationItem, previews: PushPreviews): { title: string; body: string } {
  if (previews === 'none') return { title: '', body: NO_PREVIEW_BODY };
  const headline = pushHeadlineOf(item);
  if (previews === 'sender') return { title: headline, body: '' };

  const target = item.target ?? null;
  const targetTitle = target ? oneLine(target.title) : '';
  if (MESSAGE_KINDS.has(item.kind)) {
    const where = target && targetTitle ? (target.kind === 'channel' ? `#${targetTitle}` : targetTitle) : '';
    return { title: where ? `${headline} in ${where}` : headline, body: oneLine(item.message ?? '') };
  }
  return { title: headline, body: targetTitle || oneLine(item.message ?? '') };
}

export interface BuildPushPayloadInput {
  readonly notification: NotificationItem;
  /** The message the notification is about, when it names one. */
  readonly messageId: string | null;
  readonly previews: PushPreviews;
  /** The server's origin as the phone knows it (TM8_PUBLIC_ORIGIN). */
  readonly origin: string;
}

export function buildPushPayload(input: BuildPushPayloadInput): PushPayloadV1 {
  const { notification: item, origin } = input;
  const texts = textsFor(item, input.previews);
  return {
    title: cap(texts.title, PUSH_TITLE_MAX),
    body: cap(texts.body, PUSH_BODY_MAX),
    categoryId: pushRouteOf(item.kind).categoryId,
    threadId: pushThreadIdOf(origin, item.spaceId),
    data: {
      v: PUSH_PAYLOAD_VERSION,
      o: origin,
      sp: item.spaceId,
      n: item.id,
      e: item.target?.id ?? null,
      k: item.kind.slice(0, 64),
      h: pushWebAddressOf(origin, item, input.messageId),
    },
  };
}
