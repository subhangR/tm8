/**
 * Push payloads (s-lld §11): what a tm8 node hands its push relay for ONE
 * notification on ONE device, and what the phone reads back out of it.
 *
 * The relay is Expo Push Service (decide Q5, answered 2026-10-29: the default
 * stands). The relay sees everything in a payload, which is why the TEXT
 * follows the device's `previews` setting (`full` · `sender` · `none`, default
 * `sender`) and `data` carries ids and one address only — never a name, a
 * title or message text, whatever the setting.
 *
 * `data` is the phone's routing record:
 *   v   payload version, 1
 *   o   the server's origin exactly as the phone knows it; the phone maps a
 *       push to a server by exact origin
 *   sp  space id
 *   n   notification id (Mark read is `inbox.markRead` with it)
 *   e   the entity the notification is about (its target), or null
 *   k   `NotificationItem.kind`, an open union: an unknown kind is still valid
 *   h   the web address, resolved by the same link resolver as any link
 *
 * There is no badge here on purpose: a node cannot know your other servers'
 * counts, so it never sets one (s-lld §11, Badge).
 */
import { z } from 'zod';

export const PUSH_PAYLOAD_VERSION = 1;

/** The device's previews setting (`devices.previews`). */
export const PUSH_PREVIEWS = ['full', 'sender', 'none'] as const;
export type PushPreviews = (typeof PUSH_PREVIEWS)[number];
/** Decide Q5: a device that never chose shows the sender only. */
export const DEFAULT_PUSH_PREVIEWS: PushPreviews = 'sender';

/** The notification categories the app registers (their action sets). */
export const PUSH_CATEGORY_IDS = ['tm8.reply', 'tm8.task', 'tm8.review', 'tm8.activity'] as const;
export type PushCategoryId = (typeof PUSH_CATEGORY_IDS)[number];

/** The Android channels the app creates: needs-you is high, activity is low. */
export const PUSH_ANDROID_CHANNEL_IDS = ['needs-you', 'mentions', 'activity', 'quiet'] as const;
export type PushAndroidChannelId = (typeof PUSH_ANDROID_CHANNEL_IDS)[number];

export type PushInterruptionLevel = 'active' | 'passive' | 'time-sensitive';

/** How one notification kind is presented: the same answer on every device. */
export interface PushKindRoute {
  readonly categoryId: PushCategoryId;
  readonly androidChannelId: PushAndroidChannelId;
  readonly interruptionLevel: PushInterruptionLevel;
}

/**
 * The s-lld §11 table. Categories follow it exactly; it names no channel per
 * kind, so mentions and replies share `mentions` (s-inbox: "Mentions and
 * replies") and every other kind is `activity`. Nothing a notification row
 * carries is time-sensitive and nothing goes to `needs-you`: those belong to a
 * session waiting on you, an attention request, not an inbox row (s-inbox).
 */
const ROUTES: Readonly<Record<string, PushKindRoute>> = {
  mention: { categoryId: 'tm8.reply', androidChannelId: 'mentions', interruptionLevel: 'active' },
  message_reply: { categoryId: 'tm8.reply', androidChannelId: 'mentions', interruptionLevel: 'active' },
  anchor_message: { categoryId: 'tm8.reply', androidChannelId: 'activity', interruptionLevel: 'passive' },
  assignment: { categoryId: 'tm8.task', androidChannelId: 'activity', interruptionLevel: 'active' },
  review_request: { categoryId: 'tm8.review', androidChannelId: 'activity', interruptionLevel: 'active' },
  unblock: { categoryId: 'tm8.task', androidChannelId: 'activity', interruptionLevel: 'active' },
  stale: { categoryId: 'tm8.task', androidChannelId: 'activity', interruptionLevel: 'passive' },
};

/** `award` and every other kind, known or not (s-lld §11: "award · other"). */
const OTHER_ROUTE: PushKindRoute = {
  categoryId: 'tm8.activity',
  androidChannelId: 'activity',
  interruptionLevel: 'passive',
};

/**
 * The route for a kind. `quiet` is the device's quiet window (`quietUntil` in
 * the future): the push still arrives, passively and on the quiet channel,
 * because the OS shows a push before app code runs (s-lld §11, Quiet hours).
 */
export function pushRouteOf(kind: string, options: { readonly quiet?: boolean } = {}): PushKindRoute {
  const route = Object.prototype.hasOwnProperty.call(ROUTES, kind) ? ROUTES[kind]! : OTHER_ROUTE;
  if (options.quiet !== true) return route;
  return { categoryId: route.categoryId, androidChannelId: 'quiet', interruptionLevel: 'passive' };
}

/** iOS groups pushes by server and space (s-inbox lock screen). */
export function pushThreadIdOf(origin: string, spaceId: string): string {
  return `${origin}/s/${spaceId}`;
}

/** Room for the headline the inbox draws, and for the excerpt it quotes. */
export const PUSH_TITLE_MAX = 120;
export const PUSH_BODY_MAX = 240;

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

const PushOriginSchema = z
  .string()
  .max(200)
  .refine((value) => originOf(value) === value, 'an origin: scheme://host[:port] with nothing after it');

export const PushPayloadDataV1Schema = z
  .object({
    v: z.literal(PUSH_PAYLOAD_VERSION),
    o: PushOriginSchema,
    sp: z.string().uuid(),
    n: z.string().uuid(),
    e: z.string().uuid().nullable(),
    k: z.string().min(1).max(64),
    h: z.string().max(1000),
  })
  .strict()
  // The address is on the server the push names, and nowhere else.
  .refine((data) => data.h.startsWith(`${data.o}/`) && originOf(data.h) === data.o, {
    message: 'h must be an address on the origin o names',
    path: ['h'],
  });

export const PushPayloadV1Schema = z
  .object({
    title: z.string().max(PUSH_TITLE_MAX),
    body: z.string().max(PUSH_BODY_MAX),
    categoryId: z.enum(PUSH_CATEGORY_IDS),
    threadId: z.string().min(1).max(300),
    data: PushPayloadDataV1Schema,
  })
  .strict();

export type PushPayloadDataV1 = z.infer<typeof PushPayloadDataV1Schema>;
export type PushPayloadV1 = z.infer<typeof PushPayloadV1Schema>;
