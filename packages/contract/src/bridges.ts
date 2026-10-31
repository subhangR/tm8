/**
 * Bridges (BRIDGE-ENTITY-DESIGN.md §2.1, §3.4; migration 395): one provider
 * conversation — a WhatsApp group, a Slack channel, a DM thread — bound to
 * one tm8 target (a chat, a work session or a channel).
 *
 * `BridgeFacts` is the content arm and the state arm of the `bridge` kind, and
 * what every `bridges.*` read answers inside a `BridgeView`. `status` and
 * `health` are DERIVED on the server once (`internal.bridge_view`, T-L12) and
 * never computed by a client.
 */
import { z } from 'zod';
import type { EntityId, SpaceId } from './contract.js';

export const BRIDGE_PROVIDERS = ['whatsapp', 'telegram', 'slack', 'discord', 'instagram', 'messenger'] as const;
export type BridgeProvider = typeof BRIDGE_PROVIDERS[number];
export type BridgeTargetKind = 'chat' | 'work_session' | 'channel';
export type BridgeConversationKind = 'group' | 'channel' | 'dm';
/** `ended` is the tombstone `bridges.remove` leaves (§2.1). */
export type BridgeStatus = 'live' | 'degraded' | 'paused' | 'ended';
export type BridgeConnectionStatus = 'linked' | 'connecting' | 'logged_out' | 'offline';
/** A worker's wake level, and the bridge's ceiling for it (§2.7). */
export type BridgeWake = 'directed' | 'thread' | 'all';

/**
 * Why the outbox refused to carry a post to the provider (§2.3, §2.7, D23,
 * D28). The message stays in tm8; only the provider copy is refused.
 */
export type BridgeRefusalReason =
  | 'bridge_paused' | 'bridge_ended' | 'direction_in' | 'worker_posting_off'
  | 'rate_limited' | 'not_connected' | 'credential_text';

/**
 * The `bridge.delivery` badge of a message that crosses a bridge (§2.3): the
 * delivery ledger's words, plus `refused` for a post the outbox turned away.
 * `rate_limited` carries `retryAfterMs` (§2.7: never silently queued).
 */
export interface BridgeDelivery {
  messageId: string;
  bridgeId: string;
  status: 'pending' | 'sent' | 'failed_retryable' | 'failed_permanent' | 'refused';
  reason?: BridgeRefusalReason;
  retryAfterMs?: number;
  externalMessageId?: string;
  detail?: string;
  at: string;
}

export const BRIDGE_PURPOSE_MAX = 300;
export const BRIDGE_STYLE_MAX = 300;
export const BRIDGE_HANDLE_TITLE_MAX_WORDS = 4;
export const BRIDGE_LOG_LIMIT_MAX = 200;

export interface BridgePolicy {
  /** Which inbound messages reach the target as a turn or delivery. Everything is still logged. */
  trigger: 'mention' | 'every' | 'none';
  direction: 'both' | 'in' | 'out';
  /** Which tm8-side messages cross: replies to bridged messages (and turn answers), or every message on the target. */
  outbound: 'replies' | 'all';
  whoMayTrigger: 'linked' | 'anyone';
  /** How outbound text is signed on providers with one sender identity. */
  voice: 'named' | 'plain';
  /** One line, at most 300 characters, riding every inbound envelope. */
  style: string | null;
}

export interface BridgeFacts {
  provider: BridgeProvider;
  /** The node-level connection (the number) this bridge rides on. */
  connectionId: string;
  /**
   * The space credential (shape `connection`) offered for that connection.
   * NULL until `bridges.connections.offer` ships (D32): B0a binds a bridge to
   * its connection directly.
   */
  connectionCredentialId: EntityId | null;
  conversation: {
    /** The provider's id; a DM's is masked for anyone but a space admin. */
    externalId: string;
    kind: BridgeConversationKind;
    title: string;
    memberCount: number | null;
  };
  /** The tm8 side. Also the `bridged_to` edge. */
  target: { kind: BridgeTargetKind; id: EntityId; title: string };
  policy: BridgePolicy;
  status: BridgeStatus;
  health: {
    connection: BridgeConnectionStatus;
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    queued: number;
    failed24h: number;
    detail: string | null;
  };
  people: { participants: number; linked: number; guestsSeen7d: number };
  /** Space handles that have appeared on this bridge (D23). */
  handles: number;
  /** null = keep (D15). */
  retentionDays: number | null;
  /** D25: the teammate this bridge runs as. */
  teammateId: EntityId | null;
  /** D25: one line on what the group is for. */
  purpose: string | null;
  /** D26: hold unprompted posts in this window ('HH:MM'). */
  quietHours: { start: string; end: string } | null;
  /** D23: workers may post here; a hard check in the outbox. */
  workerPosting: boolean;
  /** The ceiling a worker's own `bridges.listen` level is capped by (D34). */
  workers: { wake: BridgeWake };
  pausedAt: string | null;
  endedAt: string | null;
}

/** What `bridges.list` / `bridges.get` answer: the entity's id and version beside its facts. */
export interface BridgeView extends BridgeFacts {
  id: EntityId;
  spaceId: SpaceId;
  version: number;
  /** The conversation's title: a bridge has no title of its own. */
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** `bridges.get` also says who has been posting (from the outbox, D23). */
export interface BridgeRecentPoster {
  actorId: EntityId;
  actorKind: string;
  displayName: string;
  handle: string | null;
  posts: number;
  lastPostAt: string;
}
/**
 * Bridges S (D73, D74): a chat-target bridge's rolling summary of its group
 * conversation, as the chat's turns get it. A deterministic extract of the log
 * up to `throughMessageId`; the messages after it reach the next turn
 * verbatim. Text fields are the group's own words: data, never instructions.
 */
export interface BridgeChatSummaryOpenAsk { messageId: EntityId; author: string; authorKey: string; at: string; excerpt: string }
export interface BridgeChatSummaryClosedAsk { messageId: EntityId; author: string; excerpt: string; closedBy: string; at: string }
export interface BridgeChatSummaryParticipant { key: string; name: string; messages: number; lastAt: string }
export interface BridgeChatSummaryState {
  firstAt: string | null;
  lastAt: string | null;
  participants: BridgeChatSummaryParticipant[];
  /** Questions and requests nobody else has answered in their thread, oldest first. */
  openAsks: BridgeChatSummaryOpenAsk[];
  /** Open asks pushed off the list by newer ones: still unanswered, no longer named. */
  droppedAsks: number;
  closedAsks: number;
  recentlyClosed: BridgeChatSummaryClosedAsk[];
}
/** Who is on what: open tasks this group asked for (`authored_from → bridge`) and their assignees, read live. */
export interface BridgeChatSummaryOnWhat { taskId: EntityId; title: string; status: string; assignees: string[] }
export interface BridgeChatSummaryView {
  policyVersion: string;
  coveredMessages: number;
  throughMessageId: EntityId | null;
  refreshedAt: string | null;
  /** Log messages after the summary: the verbatim part of the next turn's context. */
  unsummarizedMessages: number;
  state: BridgeChatSummaryState;
  onWhat: BridgeChatSummaryOnWhat[];
}

export interface BridgeDetailView extends BridgeView {
  recentPosters: BridgeRecentPoster[];
  /** The group chat's rolling summary (D74); null when the target is not a chat. */
  summary: BridgeChatSummaryView | null;
}

export interface BridgeListResult { items: BridgeView[] }

export interface BridgeHandle {
  spaceId: SpaceId;
  handle: string;
  entityId: EntityId;
  kind: 'chat' | 'work_session';
  title: string | null;
  status: 'live' | 'ended';
  createdAt: string;
}
export interface BridgeHandleAppearance extends BridgeHandle { firstAt: string; lastAt: string }
export interface BridgeHandleListResult { items: BridgeHandleAppearance[] }

export interface BridgeListenResult { bridgeId: EntityId; sessionId: EntityId; wake: BridgeWake; ceiling: BridgeWake }

/** How far a bridged sender is taken at their word (§2.4, D4). */
export type BridgeTrust = 'linked' | 'asserted' | 'guest';

/**
 * A message that crossed a bridge, or is crossing (§4.5, D4): read for the
 * message itself or its batch twin, so a routed message's chat copy and log
 * copy carry the same mark. Absent on a message that never touched a bridge.
 */
export interface MessageBridgeView {
  bridgeId: EntityId;
  provider: BridgeProvider;
  /** The provider conversation's title (`Infra`); null when unreadable. */
  conversation: string | null;
  direction: 'in' | 'out';
  /** Inbound only: the participant's name as the provider sent it; never a phone number. */
  participant: string | null;
  /** Inbound only: linked (verified), asserted (an admin's *This is…*), guest (unlinked, authored by the bridge). */
  trust: BridgeTrust | null;
  /**
   * Outbound only: the outbox ledger's state, or the refusal (398's badge).
   * There is no `delivered` or `read`: the runtime protocol carries no
   * receipts (D64).
   */
  delivery: BridgeDelivery | null;
}

/** One row of `bridges.log.read`: a message on the bridge's log anchor. Rows within a page are oldest first. */
export interface BridgeLogEntry {
  id: EntityId;
  createdAt: string;
  authorId: EntityId | null;
  authorKind: string | null;
  authorName: string;
  body: string;
  parentMessageId: EntityId | null;
  rootMessageId: EntityId | null;
  /** Present when the message crossed the bridge (in or out). */
  origin: {
    direction: 'in' | 'out';
    externalMessageId: string;
    /** The participant's display name for an inbound message; never a phone number. */
    participant: string | null;
  } | null;
  /** The poster's handle, when a session with one wrote it. */
  handle: string | null;
  /** The outbound delivery badge (sent, queued, failed, refused), when this message crosses. */
  delivery: BridgeDelivery | null;
}
export interface BridgeLogResult {
  bridgeId: EntityId;
  /** Where the conversation is stored: the channel for a channel target, else the bridge (§2.2). */
  logAnchorId: EntityId;
  items: BridgeLogEntry[];
  /** Pass as `since` to read on. Null when the page was empty. */
  lastMessageId: EntityId | null;
  /** True when more messages follow this page. */
  more: boolean;
  /**
   * Pass as `before` to read the page just older than this one (the id of this
   * page's oldest row). Null when this page starts at the beginning of the log
   * (or is empty).
   */
  olderCursor: EntityId | null;
}

interface BridgeCommand { clientMutationId: string; actorId?: EntityId }
export interface BridgeCreateInput extends BridgeCommand {
  spaceId?: SpaceId;
  /** The bridge_connections id of the caller's own number (D28, D32). */
  connectionId: string;
  conversation: { externalId: string; kind: BridgeConversationKind; title: string; memberCount?: number | null };
  targetId: EntityId;
  /** Overlaid on the defaults for the target and conversation kind (§2.2). */
  policy?: Partial<BridgePolicy>;
  teammateId?: EntityId | null;
  purpose?: string | null;
  quietHours?: { start: string; end: string } | null;
  workerPosting?: boolean;
  retentionDays?: number | null;
}
export interface BridgeUpdateInput extends BridgeCommand {
  bridgeId?: EntityId;
  expectedVersion: number;
  patch: {
    policy?: Partial<BridgePolicy>;
    purpose?: string | null;
    teammateId?: EntityId | null;
    quietHours?: { start: string; end: string } | null;
    workerPosting?: boolean;
    workerWake?: BridgeWake;
    retentionDays?: number | null;
    conversationTitle?: string;
  };
}
export interface BridgeRetargetInput extends BridgeCommand { bridgeId?: EntityId; expectedVersion: number; targetId: EntityId }
export interface BridgeStateInput extends BridgeCommand { bridgeId?: EntityId; expectedVersion: number }
export interface BridgeHandleClaimInput { spaceId?: SpaceId; title?: string }
export interface BridgeListenInput { bridgeId?: EntityId; wake: BridgeWake }

/** `bridges.work.start` (v2 §4.3): the agent's door to `/work`, the same server path. */
export const BRIDGE_WORK_ITEMS_MAX = 5;
export type BridgeWorkEffort = 'low' | 'high' | 'max';
export interface BridgeWorkStartInput {
  clientMutationId: string;
  bridgeId?: EntityId;
  /** One line each; one child task and one worker per item. */
  items: string[];
  options?: { teammate?: string; project?: string; effort?: BridgeWorkEffort };
}
export interface BridgeWorkStartItem {
  taskId: EntityId;
  sessionId: EntityId | null;
  handle: string | null;
  /** Why the worker did not start; the task stays. */
  error: string | null;
}
export interface BridgeWorkStartResult {
  bridgeId: EntityId;
  /** The parent task, when there are two items or more. */
  parentTaskId: EntityId | null;
  items: BridgeWorkStartItem[];
  /** The announcement posted to the group (absent when the outbox refused it). */
  noticeMessageId: EntityId | null;
}

const Id = z.string().uuid();
const Command = { clientMutationId: z.string().min(1), actorId: Id.optional() };
const Versioned = { ...Command, bridgeId: Id.optional(), expectedVersion: z.number().int().positive() };
const OneLine = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\r\n]*$/, 'must be one line');
const Hhmm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'must be HH:MM');

export const BridgeProviderSchema = z.enum(BRIDGE_PROVIDERS);
export const BridgeDeliverySchema: z.ZodType<BridgeDelivery> = z.object({
  messageId: z.string().min(1),
  bridgeId: z.string().min(1),
  status: z.enum(['pending', 'sent', 'failed_retryable', 'failed_permanent', 'refused']),
  reason: z.enum(['bridge_paused', 'bridge_ended', 'direction_in', 'worker_posting_off', 'rate_limited',
    'not_connected', 'credential_text']).optional(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  externalMessageId: z.string().min(1).optional(),
  detail: z.string().min(1).optional(),
  at: z.string().min(1),
}).strict();
export const MessageBridgeViewSchema: z.ZodType<MessageBridgeView> = z.object({
  bridgeId: Id,
  provider: BridgeProviderSchema,
  conversation: z.string().nullable(),
  direction: z.enum(['in', 'out']),
  participant: z.string().nullable(),
  trust: z.enum(['linked', 'asserted', 'guest']).nullable(),
  delivery: BridgeDeliverySchema.nullable(),
}).strict();
export const BridgeWakeSchema = z.enum(['directed', 'thread', 'all']);
export const BridgePolicySchema: z.ZodType<BridgePolicy> = z.object({
  trigger: z.enum(['mention', 'every', 'none']),
  direction: z.enum(['both', 'in', 'out']),
  outbound: z.enum(['replies', 'all']),
  whoMayTrigger: z.enum(['linked', 'anyone']),
  voice: z.enum(['named', 'plain']),
  style: OneLine(BRIDGE_STYLE_MAX).nullable(),
}).strict();
const BridgePolicyPatchSchema = z.object({
  trigger: z.enum(['mention', 'every', 'none']).optional(),
  direction: z.enum(['both', 'in', 'out']).optional(),
  outbound: z.enum(['replies', 'all']).optional(),
  whoMayTrigger: z.enum(['linked', 'anyone']).optional(),
  voice: z.enum(['named', 'plain']).optional(),
  style: OneLine(BRIDGE_STYLE_MAX).nullable().optional(),
}).strict();
const QuietHoursSchema = z.object({ start: Hhmm, end: Hhmm }).strict()
  .refine(q => q.start !== q.end, 'start and end must differ');

const BridgeFactsShape = {
  provider: BridgeProviderSchema,
  connectionId: Id,
  connectionCredentialId: Id.nullable(),
  conversation: z.object({
    externalId: z.string(), kind: z.enum(['group', 'channel', 'dm']), title: z.string(),
    memberCount: z.number().int().nonnegative().nullable(),
  }).strict(),
  target: z.object({ kind: z.enum(['chat', 'work_session', 'channel']), id: Id, title: z.string() }).strict(),
  policy: BridgePolicySchema,
  status: z.enum(['live', 'degraded', 'paused', 'ended']),
  health: z.object({
    connection: z.enum(['linked', 'connecting', 'logged_out', 'offline']),
    lastInboundAt: z.string().nullable(), lastOutboundAt: z.string().nullable(),
    queued: z.number().int().nonnegative(), failed24h: z.number().int().nonnegative(),
    detail: z.string().nullable(),
  }).strict(),
  people: z.object({
    participants: z.number().int().nonnegative(), linked: z.number().int().nonnegative(),
    guestsSeen7d: z.number().int().nonnegative(),
  }).strict(),
  handles: z.number().int().nonnegative(),
  retentionDays: z.number().int().positive().nullable(),
  teammateId: Id.nullable(),
  purpose: z.string().nullable(),
  quietHours: z.object({ start: z.string(), end: z.string() }).strict().nullable(),
  workerPosting: z.boolean(),
  workers: z.object({ wake: BridgeWakeSchema }).strict(),
  pausedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
};
export const BridgeFactsSchema: z.ZodType<BridgeFacts> = z.object(BridgeFactsShape).strict();
/** The `bridge` arm of the entity state and content unions. */
export const BridgeEntitySchema = z.object({ kind: z.literal('bridge'), ...BridgeFactsShape }).strict();

export const BridgeCreateInputSchema = z.object({
  ...Command,
  spaceId: Id.optional(),
  connectionId: Id,
  conversation: z.object({
    externalId: z.string().min(1).max(256),
    kind: z.enum(['group', 'channel', 'dm']),
    title: z.string().trim().min(1).max(200),
    memberCount: z.number().int().nonnegative().nullable().optional(),
  }).strict(),
  targetId: Id,
  policy: BridgePolicyPatchSchema.optional(),
  teammateId: Id.nullable().optional(),
  purpose: OneLine(BRIDGE_PURPOSE_MAX).nullable().optional(),
  quietHours: QuietHoursSchema.nullable().optional(),
  workerPosting: z.boolean().optional(),
  retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
}).strict();

export const BridgeUpdateInputSchema = z.object({
  ...Versioned,
  patch: z.object({
    policy: BridgePolicyPatchSchema.optional(),
    purpose: OneLine(BRIDGE_PURPOSE_MAX).nullable().optional(),
    teammateId: Id.nullable().optional(),
    quietHours: QuietHoursSchema.nullable().optional(),
    workerPosting: z.boolean().optional(),
    workerWake: BridgeWakeSchema.optional(),
    retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
    conversationTitle: z.string().trim().min(1).max(200).optional(),
  }).strict().refine(p => Object.keys(p).length > 0, 'patch names at least one field'),
}).strict();

export const BridgeRetargetInputSchema = z.object({ ...Versioned, targetId: Id }).strict();
export const BridgeStateInputSchema = z.object(Versioned).strict();
export const BridgeHandleClaimInputSchema = z.object({
  spaceId: Id.optional(),
  title: z.string().trim().min(1).max(80)
    .refine(t => t.split(/\s+/).length <= BRIDGE_HANDLE_TITLE_MAX_WORDS, 'at most four words').optional(),
}).strict();
export const BridgeListenInputSchema = z.object({ bridgeId: Id.optional(), wake: BridgeWakeSchema }).strict();
export const BridgeWorkStartInputSchema = z.object({
  clientMutationId: z.string().min(1),
  bridgeId: Id.optional(),
  items: z.array(OneLine(500)).min(1).max(BRIDGE_WORK_ITEMS_MAX),
  options: z.object({
    teammate: OneLine(200).optional(),
    project: OneLine(200).optional(),
    effort: z.enum(['low', 'high', 'max']).optional(),
  }).strict().optional(),
}).strict();

// ---------------------------------------------------------------------------
// `/remember` proposals (D29, D61-D63; migration 416). A proposal is made from
// the group by the command executor and decided only here, in tm8, by a human.
// ---------------------------------------------------------------------------
export const BRIDGE_MEMORY_PROPOSAL_STATUSES = ['pending', 'accepted', 'dropped', 'expired'] as const;
export type BridgeMemoryProposalStatus = typeof BRIDGE_MEMORY_PROPOSAL_STATUSES[number];
export const BRIDGE_MEMORY_PROPOSAL_TTL_DAYS = 14;

export interface BridgeMemoryProposal {
  id: string;
  spaceId: SpaceId;
  bridgeId: EntityId;
  statement: string;
  /** The member who sent `/remember`, and whether their link was verified (code, invite) or admin-asserted. */
  proposedBy: EntityId;
  proposerName: string;
  proposerTrust: 'linked' | 'asserted';
  /** The `/remember` message on the bridge's log, when known. */
  messageId: EntityId | null;
  /** The text names a secret (a password, a token): accept only if it holds none. */
  mentionsSecret: boolean;
  status: BridgeMemoryProposalStatus;
  /** The memory an accept made. */
  memoryId: EntityId | null;
  decidedBy: EntityId | null;
  decidedAt: string | null;
  decisionNote: string | null;
  expiresAt: string;
  /** Whether the caller may accept or drop it now (D62). */
  canDecide: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}
export interface BridgeMemoryProposalListResult { items: BridgeMemoryProposal[] }
export interface BridgeMemoryProposalResolveInput {
  bridgeId?: EntityId;
  proposalId?: string;
  decision: 'accept' | 'drop';
  /** accept only: the corrected text to remember instead. */
  statement?: string;
  note?: string;
}

export const BridgeMemoryProposalResolveInputSchema = z.object({
  bridgeId: Id.optional(),
  proposalId: Id.optional(),
  decision: z.enum(['accept', 'drop']),
  statement: z.string().trim().min(1).max(4000).optional(),
  note: z.string().trim().min(1).max(1000).optional(),
}).strict().refine(i => i.decision === 'accept' || i.statement === undefined, 'statement is for accept only');

// ---------------------------------------------------------------------------
// B3 (417, §2.4, §4.6, D5, D58-D60): code and invite links.
// ---------------------------------------------------------------------------

/** A link code: `TM8-` and six characters, ten minutes, one use (D58). */
export interface BridgeLinkCode { code: string; provider: BridgeProvider; expiresAt: string; createdAt: string }

/** One of the caller's links: who a provider id IS (§2.4). */
export interface BridgeIdentityLink {
  id: string;
  provider: BridgeProvider;
  externalId: string;
  /** '…0001': the last four characters only. */
  masked: string;
  method: 'code' | 'invite' | 'admin';
  /** linked = identity-scoped (code, invite); asserted = an admin's, for one space (D5). */
  trust: 'linked' | 'asserted';
  spaceId: string | null;
  spaceName: string | null;
  verifiedAt: string;
  revokedAt: string | null;
}

/** A live code, as the list shows it: never the code itself, which only begin answers (D58). */
export interface BridgeLinkPending { id: string; provider: BridgeProvider; expiresAt: string; createdAt: string }

export interface BridgeLinksList { items: BridgeIdentityLink[]; pending: BridgeLinkPending[] }

export interface BridgeLinkBeginInput { provider: BridgeProvider; clientMutationId?: string }
export interface BridgeLinkRevokeInput { linkId?: string; clientMutationId?: string }

/** A participant pinned to `spaces.invites.create` (D60): redeeming links the joiner. */
export interface BridgeInviteParticipant { bridgeId: EntityId; externalId: string }

export const BridgeLinkBeginInputSchema = z.object({
  provider: BridgeProviderSchema, clientMutationId: z.string().min(1).optional(),
}).strict();
export const BridgeLinkRevokeInputSchema = z.object({
  linkId: Id.optional(), clientMutationId: z.string().min(1).optional(),
}).strict();
export const BridgeInviteParticipantSchema = z.object({
  bridgeId: Id, externalId: z.string().min(1).max(256),
}).strict();

/** The `/link` code shape, as the parser and the CLI check it (395's column check). */
export const BRIDGE_LINK_CODE_PATTERN = /^TM8-[A-Z0-9]{4,8}$/i;
