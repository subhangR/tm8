/**
 * Bridges B1b-4: what the command executor needs from the rest of the server,
 * as one seam. The composition root (main.ts) binds each to the real code:
 *
 * - `postNotice` / `react`: B1b-2's `bridges/outbox.ts` (postBridgeNotice,
 *   reactBridgeMessage). A notice is authored as the bridge, signed `tm8: …`,
 *   quotes the command and is idempotent on its key.
 * - `claim` / `settle`: B1b-2's command state on message_origins
 *   (internal.bridge_command_claim / bridge_command_settle). B1b-2 marks a
 *   command pending in the inbound tx; the executor claims, runs, answers
 *   and settles it, and its sweep re-runs what a crash left behind.
 * - `recordOrigin`: B1b-3's `bridges/provenance.ts` recordBridgeOrigin, the
 *   authored_from -> bridge (and -> message) edges for an entity the executor
 *   creates, in the create's own transaction (D22, D31).
 * - `spawnWorker` / `stopWorker`: SpawnService.spawn with the bridge origins
 *   as a SERVER fact (B1b-3: written in the spawn's own transaction), and the
 *   `execution.terminate` path.
 * - `workerHandle`: B1b-3's public.bridge_poster_handle(bridge, session),
 *   minting the worker's space handle at request time (D23, v2 §4.3).
 *
 * Kept as a seam, not imports, so the executor is testable against a scratch
 * database with fakes for the PTY host and the outbox.
 */
import type {
  BridgeGroupForkInput, BridgeGroupForkResult, BridgeWorkStartInput, BridgeWorkStartResult, GroupMemberResult, GroupMemberIdentity,
} from '@tm8/contract';
import type { Db, DbClaims, Querier } from '../../db/types.js';
import type { BridgeDeliveryResult } from '../outbox.js';
import type { BridgeAuthor } from '../runtime/command-hook.js';

/** §2.8's origin, as B1b-3's recorder takes it (inherited/viaSessionId/depth are the recorder's). */
export interface BridgeCommandOrigin {
  bridgeId: string;
  messageId: string | null;
  providerMessageId: string | null;
  sender: { memberId?: string; participant?: string; handle?: string };
  command: string | null;
  loopId?: string;
}

export interface BridgeNoticeInput {
  bridgeId: string;
  text: string;
  replyToMessageId?: string | null;
  idempotencyKey: string;
}

export interface SpawnWorkerRequest {
  spaceId: string;
  teamMemberId: string;
  /** Null for a session with no task: the bridge's own session (/new, the session keeper). */
  taskId: string | null;
  projectId: string | null;
  effort: 'low' | 'high' | 'max' | null;
  title: string;
  clientMutationId: string;
  origins: BridgeCommandOrigin[];
  /** The session's brief, after its launch context (a fork's topic, D83). */
  promptExtra?: string | null;
}

export type { BridgeAuthor, BridgeCommandDetectContext, BridgeCommandHook } from '../runtime/command-hook.js';

/** One stored command, as public.bridge_command_input loads it (401). */
export interface BridgeCommandInput {
  bridgeId: string;
  spaceId: string;
  connectionId: string;
  messageId: string;
  externalMessageId: string;
  senderExternalId: string;
  /** Native provider mentions, preserving PN/LID domains. */
  mentions?: string[];
  author: BridgeAuthor;
  text: string;
  replyTo?: { externalMessageId: string; text?: string } | null;
  edited?: boolean;
}

/** bridges.work.start's door into the executor (v2 §4.3): the /work path, as the caller. */
export interface BridgeWorkStarter {
  workStart(claims: DbClaims, input: BridgeWorkStartInput & { bridgeId: string }): Promise<BridgeWorkStartResult>;
  /** bridges.groups.fork (D83, 432): /split's path, for the session the bridge lands on. */
  forkStart?(claims: DbClaims, input: BridgeGroupForkInput & { bridgeId: string }): Promise<BridgeGroupForkResult>;
  /** bridges.conversations.create with no target: a new session for a teammate, as the caller. */
  startSession?(claims: DbClaims, input: { spaceId: string; teamMemberId: string; title: string; clientMutationId: string }): Promise<{ sessionId: string }>;
  /** Ends a session startSession made whose bridge was then refused. */
  stopSession?(claims: DbClaims, sessionId: string, input: { reason: string; clientMutationId: string }): Promise<void>;
}

/** What WhatsApp did on a group request (426): the group, and each person asked in. */
export interface BridgeGroupResult {
  conversationId: string;
  subject: string;
  results: GroupMemberResult[];
  inviteLink: string | null;
  community?: { id: string; name: string } | null;
}

/** 426: the number's group powers, through its runtime. Absent where no runtime is wired. */
export interface BridgeGroupPort {
  members(input: { connectionId: string; conversationId: string; requestId: string }): Promise<{ members: GroupMemberIdentity[]; self: string[] }>;
  create(input: { connectionId: string; subject: string; participants: string[]; requestId: string; sourceConversationId: string }): Promise<BridgeGroupResult>;
  add(input: { connectionId: string; conversationId: string; participants: string[]; requestId: string }): Promise<BridgeGroupResult>;
}

export interface BridgeCommandPorts {
  readonly db: Db;
  /** Claims for the executor's server-only doors: bridgesWorkerClaims() ('bridges.runtime'). */
  readonly executorClaims: () => Promise<DbClaims>;
  postNotice(db: Db, input: BridgeNoticeInput): Promise<{ messageId: string; delivery: BridgeDeliveryResult }>;
  react?(db: Db, input: { bridgeId: string; messageId: string; emoji: string; idempotencyKey?: string }): Promise<BridgeDeliveryResult>;
  /** pending -> running (or a stale running row); false when settled or held fresh. */
  claim(messageId: string): Promise<boolean>;
  settle(messageId: string, outcome: 'done' | 'failed' | 'pending'): Promise<void>;
  recordOrigin(q: Querier, entityId: string, origin: BridgeCommandOrigin): Promise<void>;
  spawnWorker(claims: DbClaims, request: SpawnWorkerRequest): Promise<{ sessionId: string }>;
  stopWorker(claims: DbClaims, sessionId: string, input: { reason: string; clientMutationId: string }): Promise<void>;
  /** `session resume`: the same session, relaunched (/retry). */
  resumeWorker(claims: DbClaims, sessionId: string, input: { clientMutationId: string }): Promise<{ sessionId: string }>;
  workerHandle(claims: DbClaims, bridgeId: string, sessionId: string): Promise<{ handle: string; title: string | null } | null>;
  /** 426: /split and /invite. Absent: both answer that this node cannot make groups. */
  readonly groups?: BridgeGroupPort;
  readonly logger?: { warn(message: string): void; debug?(message: string): void };
  readonly now?: () => Date;
}
