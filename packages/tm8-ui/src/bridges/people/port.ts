/**
 * THE BRIDGE PEOPLE PORT — the bridge panel's People tab (BRIDGE-ENTITY-DESIGN
 * §2.4, §4.4, D50-D52).
 *
 * The tab takes this narrow surface and never imports a seam, so a fixture and
 * a real node are indistinguishable to it. The server does the masking and the
 * trust resolution (D50); nothing here can unmask an id. `update` is human-only
 * and admin-only at the facade and again in SQL (D52); a refusal is rendered as
 * the refusal the server gave.
 */
import type { ActorSummary, BridgeParticipant, BridgeParticipantListResult } from '@tm8/contract';
import type { HttpClient } from '../../data/real/http';

export interface BridgeParticipantPatch {
  muted?: boolean;
  /** Assert *This is <member>*; null revokes the assertion. */
  memberId?: string | null;
}

export interface BridgePeoplePort {
  /** The roster, most recently seen first, with the viewer's admin bit. */
  participants(bridgeId: string): Promise<BridgeParticipantListResult>;
  update(bridgeId: string, externalId: string, patch: BridgeParticipantPatch): Promise<BridgeParticipant>;
  /** The space's active members: the *This is…* picker. */
  members(spaceId: string): Promise<ActorSummary[]>;
}

const mutation = () => ({ clientMutationId: `bridge-participant-${crypto.randomUUID()}` });

export function createBridgePeoplePort(http: HttpClient): BridgePeoplePort {
  return {
    participants: (bridgeId) =>
      http.call<BridgeParticipantListResult>('bridges.participants.list', { params: { bridgeId } }),
    update: (bridgeId, externalId, patch) =>
      http.call<BridgeParticipant>('bridges.participants.update', {
        params: { bridgeId, externalId }, body: { ...mutation(), patch },
      }),
    members: async (spaceId) =>
      (await http.call<{ actor: ActorSummary }[]>('spaces.members.list', { params: { spaceId } })).map((m) => m.actor),
  };
}
