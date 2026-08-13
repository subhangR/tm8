import { ChatTurnFrameSchema, type ChatTurnFrame } from '@tm8/contract';
import type { SubscriptionRegistry } from '../events/subscriptions.js';

/**
 * C3 live projection. Subscription membership establishes Space visibility;
 * the identity check narrows it further to the configuring human so a frame
 * cannot reveal restricted-anchor content to another member of that Space.
 */
export class ChatTurnPublisher {
  constructor(
    private readonly subscriptions: SubscriptionRegistry,
    private readonly autoOwnerIdentityId: string,
  ) {}

  publish(spaceId: string, requesterIdentityId: string, candidate: ChatTurnFrame): number {
    const frame = ChatTurnFrameSchema.parse(candidate);
    const text = JSON.stringify(frame);
    let sent = 0;
    for (const sink of this.subscriptions.connectionsFor(spaceId)) {
      const sinkIdentityId = sink.identity.kind === 'auto-owner'
        ? this.autoOwnerIdentityId
        : sink.identity.identityId;
      if (sinkIdentityId !== requesterIdentityId) continue;
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
