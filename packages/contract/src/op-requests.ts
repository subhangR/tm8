/**
 * Op requests (lane L5, owner decision D5; migration 280). An agent cannot do
 * a human-only operation — add a space link, set a link's spawn switch,
 * register a gate folder — and must not be able to. It can ASK:
 *
 *   · opRequests.create  — any space member files a typed request: one
 *                          allow-listed catalog op, its path params and body,
 *                          and a justification. The request is an `op_request`
 *                          entity, raised to attention as an `approve` item.
 *   · opRequests.list    — the space's requests, newest first.
 *   · opRequests.get     — one request.
 *   · opRequests.approve — HUMAN-ONLY. The server runs the op AS THE APPROVER:
 *                          the approver's identity, the approver's authority
 *                          checks, the op's own schema. Never the agent's claims.
 *   · opRequests.deny    — HUMAN-ONLY. Nothing runs.
 *
 * Either way the outcome is posted as a message to the requesting session (and
 * on the request), authored by the approver.
 *
 * THE ALLOW-LIST below is the only set of ops a request may name. It is
 * checked at create AND again at approve, so removing an entry here stops a
 * pending request of that op from ever running.
 */
import { z } from 'zod';

import type { EntityId } from './contract.js';

/**
 * Who may approve a request.
 *
 * `requester`: only the human the requesting agent acts for (the same
 * identity). For ops that change the CALLER'S OWN row, such as
 * `spaceLinks.setSpawn` (your own switch on a link), because running them as
 * any other human would change that human's row, not the agent's.
 *
 * `any_member`: any human member of the space. The op's own authority check
 * decides; for example, `gate.folders.create` refuses anyone who is not a gate admin.
 */
export type OpRequestApprover = 'requester' | 'any_member';

export interface OpRequestableEntry {
  /** The canonical catalog op name. */
  readonly op: string;
  /** Short human label, shown on the attention item and the approve card. */
  readonly label: string;
  readonly approver: OpRequestApprover;
}

/**
 * THE allow-list. Add an entry to make an op requestable; every entry must be
 * a catalog command (asserted by test).
 *
 * Folder ops: `gate.folders.create` is today's "register a folder", and
 * `node.pathGrants.create` (282, task 01a0fb5a) grants one account a
 * filesystem root. Both are `any_member`: the op's own node/gate-admin check
 * decides, so a non-admin approver settles the request `failed`, never runs it.
 */
export const OP_REQUESTABLE: readonly OpRequestableEntry[] = [
  { op: 'spaceLinks.add', label: 'Link a space', approver: 'requester' },
  { op: 'spaceLinks.login', label: 'Sign in to a space link', approver: 'requester' },
  { op: 'spaceLinks.setSpawn', label: "Set a space link's spawn switch", approver: 'requester' },
  { op: 'gate.folders.create', label: 'Register a gate folder', approver: 'any_member' },
  { op: 'node.pathGrants.create', label: 'Grant a filesystem path', approver: 'any_member' },
];

export function opRequestable(op: string): OpRequestableEntry | null {
  return OP_REQUESTABLE.find((entry) => entry.op === op) ?? null;
}

/**
 * pending → executing (claimed by an approver) → succeeded | failed;
 * pending → denied.
 */
export type OpRequestStatus = 'pending' | 'executing' | 'succeeded' | 'failed' | 'denied';

export const OP_REQUEST_STATUSES: readonly OpRequestStatus[] = [
  'pending', 'executing', 'succeeded', 'failed', 'denied',
];

export const OpRequestStatusSchema = z.enum(['pending', 'executing', 'succeeded', 'failed', 'denied']);

/** An op request's row facts on the entity (280): which op, and where it is. */
export const OpRequestEntityFactsSchema = z.object({
  kind: z.literal('op_request'),
  op: z.string(),
  status: OpRequestStatusSchema,
}).strict();

export interface OpRequestView {
  id: EntityId;
  spaceId: string;
  op: string;
  /** The allow-list label, or the op name when it has since left the list. */
  label: string;
  /** Path params of the op (`:linkId` → `params.linkId`). */
  params: Record<string, string>;
  /** The op's body. `clientMutationId` is never stored: the server sets it. */
  input: Record<string, unknown>;
  justification: string;
  title: string;
  status: OpRequestStatus;
  approver: OpRequestApprover;
  /** The actor that filed it: a teammate for an agent, a member for a human. */
  requestedBy: EntityId;
  /** The session to report the outcome to; null when a human or a link filed it. */
  requestingSessionId: EntityId | null;
  /** The member who approved or denied it. */
  decidedBy: EntityId | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** The op's own `data` on success. */
  result: unknown;
  /** `{ code, message }` when the op failed. */
  error: { code: string; message: string } | null;
  /** Whether THIS caller may approve or deny it now. */
  canDecide: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** The body of opRequests.create; the Space is the path's `:spaceId`. */
export interface OpRequestsCreateInput {
  op: string;
  params?: Record<string, string>;
  /** The op's body, without `clientMutationId`. */
  input?: Record<string, unknown>;
  justification: string;
  clientMutationId: string;
}

/** The body of opRequests.approve and opRequests.deny. */
export interface OpRequestsDecideInput {
  note?: string | null;
  clientMutationId: string;
}

export interface OpRequestsListQuery {
  status?: OpRequestStatus;
  limit?: number;
}

export const OP_REQUEST_JUSTIFICATION_MAX = 4000;
export const OP_REQUEST_NOTE_MAX = 1000;

const clientMutationId = z.string().trim().min(1);

export const OpRequestsCreateInputSchema: z.ZodType<OpRequestsCreateInput> = z.object({
  op: z.string().min(1).max(200),
  params: z.record(z.string().min(1).max(500)).optional(),
  input: z.record(z.unknown()).optional(),
  justification: z.string().trim().min(1).max(OP_REQUEST_JUSTIFICATION_MAX),
  clientMutationId,
}).strict();

export const OpRequestsDecideInputSchema: z.ZodType<OpRequestsDecideInput> = z.object({
  note: z.string().max(OP_REQUEST_NOTE_MAX).nullable().optional(),
  clientMutationId,
}).strict();

/** The approved op's own clientMutationId: one per request, so a retry replays. */
export function opRequestMutationId(requestId: string): string {
  return `opRequest:${requestId}`;
}
