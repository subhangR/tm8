/**
 * `/remember` proposals (BRIDGE-ENTITY-DESIGN D29, D61-D63; migration 409):
 * the door the bridge command executor (B1b-4) calls for `/remember <text>`.
 *
 * It records a PROPOSAL, never a memory: the memory is made only when a
 * linked member of that group accepts it in tm8 (`bridges.memories.proposals
 * .resolve`, human-only). Nothing from WhatsApp decides one — a "YES" or
 * "/remember accept" in the group is just text, or another proposal.
 *
 * Call it under the bridges worker's claims (`bridgesWorkerClaims()`, 398);
 * the SQL door refuses any other caller with `bridges_worker_only`. The door
 * resolves the sender itself, so the executor passes the provider sender, never
 * a member. Refusals the executor answers in the group, as CollabErrors with
 * `details.reason`: `remember_needs_link` (a guest), `proposal_holds_secret`
 * (a credential value: stored nowhere), `too_many_proposals` (20 waiting),
 * `bridge_ended`.
 */
import type { BridgeMemoryProposal } from '@tm8/contract';
import type { Querier } from '../db/types.js';

export interface ProposeBridgeMemoryInput {
  bridgeId: string;
  /** The provider sender id of the `/remember` message (message_origins.external_sender_id). */
  senderExternalId: string;
  /** The text after `/remember`, multi-line bodies included. */
  statement: string;
  /** The `/remember` message on the bridge's log, when stored. */
  messageId: string | null;
  /** The provider's message id: one proposal per (bridge, provider message), so a re-run adds none. */
  providerMessageId: string;
}

export type ProposeBridgeMemoryResult = BridgeMemoryProposal & { created: boolean };

export async function proposeBridgeMemory(q: Querier, input: ProposeBridgeMemoryInput): Promise<ProposeBridgeMemoryResult> {
  return q.rpc<ProposeBridgeMemoryResult>('propose_bridge_memory', [
    input.bridgeId, input.senderExternalId, input.statement, input.messageId, input.providerMessageId,
  ]);
}
