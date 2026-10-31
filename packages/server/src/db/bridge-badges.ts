import { MessageBridgeViewSchema, type MessageBridgeView } from '@tm8/contract';

import type { Querier } from './types.js';

/**
 * The bridge mark of each message that crossed or is crossing one
 * (BRIDGE-ENTITY-DESIGN §4.5, D4): provider, conversation, the participant and
 * trust of an inbound message, the delivery badge of an outbound one. One read
 * per page, through 409's `internal.bridge_message_badges`, which takes the
 * delivery badge from 398's `internal.bridge_message_delivery` (D65).
 *
 * A message no bridge touched is simply absent from the map.
 */
export async function bridgeMessageBadges(
  q: Querier,
  messageIds: readonly string[],
  label = 'bridge:badges',
): Promise<Map<string, MessageBridgeView>> {
  if (messageIds.length === 0) return new Map();
  const [row] = await q.query<{ badges: unknown }>(
    `/* ${label} */ select internal.bridge_message_badges($1::uuid[]) as badges`,
    [messageIds],
  );
  const out = new Map<string, MessageBridgeView>();
  for (const raw of Array.isArray(row?.badges) ? row.badges : []) {
    const { messageId, ...view } = raw as { messageId: string } & Record<string, unknown>;
    out.set(messageId, MessageBridgeViewSchema.parse(view));
  }
  return out;
}
