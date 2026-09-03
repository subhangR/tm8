import { ChatTurnFrameSchema, type ChatTurnFrame } from '@tm8/contract';
import type { SubscriptionRegistry } from '../events/subscriptions.js';

/**
 * C3 live projection: every connection subscribed to the thread's Space gets
 * the stream. A chat thread is collaborative — no participant, including the
 * human who configured it, has a privileged view of the conversation.
 *
 * ## Why the Space fan-out is the authorized set, not a shortcut past one
 *
 * The pattern this file must NOT repeat is the one `events/pump.ts` documents:
 * read under one member's claims, fan the result out to everyone, and the leak
 * happens after a perfectly authorized read. It does not repeat it, and the
 * reason is specific rather than hopeful:
 *
 *   * a subscription is authorized. `canSubscribe` (events/control.ts:90) does
 *     an RLS-checked read of the Space row as `tm8_app` under the sink's own
 *     identity, so a subscriber of this Space is a member of this Space;
 *   * a chat root message carries its anchor's visibility
 *     (`w2_post_message_batch`, 019), and `internal.entity_readable` (021)
 *     grants a Space member every non-deleted `visibility='space'` entity. Its
 *     only other arm is `visibility='restricted' and kind='project'`, so a
 *     non-space-visible MESSAGE is readable by nobody at all — including the
 *     configuring human, whose `start_chat` would have been refused.
 *     A chat thread that some Space member cannot read therefore cannot exist.
 *
 * Space member + space-visible thread = the same set on both sides, which is
 * why this is a broadcast and not a widened filter.
 *
 * THE CONDITION THAT BREAKS IT is written down in 008:35 — activating
 * restricted visibility (adding `has_visible_to_edge` to `entity_readable`) is
 * a policy change, not a migration, and it would make "member of the Space"
 * stop implying "can read this thread". Whoever makes that change must give
 * this publisher a per-sink readability check in the same commit.
 */
export class ChatTurnPublisher {
  constructor(private readonly subscriptions: SubscriptionRegistry) {}

  publish(spaceId: string, candidate: ChatTurnFrame): number {
    const frame = ChatTurnFrameSchema.parse(candidate);
    const text = JSON.stringify(frame);
    let sent = 0;
    for (const sink of this.subscriptions.connectionsFor(spaceId)) {
      try {
        sink.send(text);
        sent += 1;
      } catch {
        // One broken browser cannot suppress another browser's frame. The
        // durable message part is already committed and remains replayable.
      }
    }
    return sent;
  }
}
