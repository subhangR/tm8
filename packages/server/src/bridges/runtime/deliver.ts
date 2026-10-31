/**
 * Delivery of inbound bridge messages to sessions (BRIDGE-ENTITY-DESIGN §2.2,
 * §2.7, D30; migration 402 §5): a session target's routed copy, and the
 * workers B1b-3's audience names (an `@handle`, a reply to the worker's own
 * post, its /work thread, or a worker listening at `thread`/`all`).
 *
 * `internal.bridge_inbound_deliveries` answers each route at most once per
 * (message, session), records the answerer of a directed message and adds the
 * bridge origin to the session in the same transaction; this hands the routes
 * to the one stored-first PTY delivery loop every message uses, with the
 * `tm8.incoming-message` envelope's bridge `origin` element (directed, unread).
 * The message is a provider participant's, never a session's, so attribution
 * is `recorded_only` and there is no source session.
 */
import type { Db } from '../../db/types.js';
import {
  dispatchSessionMessages,
  type DeliveryDisposition,
  type DispatchableRoute,
  type MessageDeliveryPort,
} from '../../facade/services/w2/message-dispatch.js';
import { bridgesWorkerClaims } from '../outbox.js';

export type BridgeSessionDelivery = (messageId: string) => Promise<DeliveryDisposition[]>;

export function createBridgeSessionDelivery(o: {
  readonly db: Db;
  readonly delivery: MessageDeliveryPort;
}): BridgeSessionDelivery {
  return async (messageId) => {
    const routes = await o.db.rpc<DispatchableRoute[]>(bridgesWorkerClaims(), 'internal.bridge_inbound_deliveries', [messageId]);
    if (!Array.isArray(routes) || routes.length === 0) return [];
    return dispatchSessionMessages({
      routes,
      parentsById: new Map(),
      requestId: `bridges:inbound:${messageId}`,
      sourceWorkSessionId: null,
      senderAttribution: 'recorded_only',
      delivery: o.delivery,
    });
  };
}
