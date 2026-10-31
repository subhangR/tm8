import type { BridgePeoplePort } from './people';
import type { CreateInviteInput, SpaceId, SpaceInviteView } from '@tm8/contract';
import type {
  ActorSummary,
  BridgeConnectionAuthFlow,
  BridgeConnectionAuthFrame,
  BridgeConnectionBeginResult,
  BridgeConnectionListResult,
  BridgeConnectionOfferResult,
  BridgeConnectionRemoveResult,
  BridgeConnectionView,
  BridgeConnectionWithdrawResult,
  BridgeConversationListResult,
  BridgeCreateInput,
  BridgeDetailView,
  BridgeHandleAppearance,
  BridgeHandoverResult,
  BridgeLogResult,
  BridgeUpdateInput,
  BridgeView,
  AttentionRequest,
  CommandResult,
  EntityId,
  EdgeView,
  EntityKind,
  EntitySummary,
  OperationName,
} from '@tm8/contract';
import { getOperation, isOperationName } from '@tm8/contract';
import { nextMutationId } from '../authoring/commands';
import { readEntityOpenAttention } from '../attention/entity-open-attention';
import type { HttpClient } from '../data/real/http';
import type { Seam } from '../data/seam';

/*
 * THE BRIDGES CLIENT — the one place the UI reaches `bridges.*` (B0a, migration
 * 395; BRIDGE-ENTITY-DESIGN §3.4).
 *
 * Settings → Bridges and the bridge panel talk through `BridgesPort`, never
 * through `entities.patch`: a bridge's status and health are DERIVED on the
 * server (`internal.bridge_view`), so nothing here computes them. The ops are
 * a 1:1 mirror of the catalog rows; the types are the contract's.
 *
 * Who may do what is the server's answer. create, retarget and remove are
 * human-only at the facade and again in SQL; a refusal reaches the surface as
 * a `CollabError` and is drawn as a refusal, never swallowed.
 */

export type BridgePatch = BridgeUpdateInput['patch'];

export interface BridgeLogQuery {
  since?: string;
  thread?: string;
  limit?: number;
  /** #1446: the newest page (rows still oldest first within it). Never moves an unread cursor. */
  latest?: boolean;
  /** #1446: the page just older than this message id (exclusive): pass the last answer's `olderCursor`. */
  before?: string;
}

/** The `bridges.*` operations, by catalog name. */
export interface BridgesClient {
  list(spaceId: string, opts?: { includeEnded?: boolean }): Promise<BridgeView[]>;
  get(bridgeId: string): Promise<BridgeDetailView>;
  update(bridgeId: string, expectedVersion: number, patch: BridgePatch): Promise<BridgeView>;
  retarget(bridgeId: string, expectedVersion: number, targetId: string): Promise<BridgeView>;
  pause(bridgeId: string, expectedVersion: number): Promise<BridgeView>;
  resume(bridgeId: string, expectedVersion: number): Promise<BridgeView>;
  remove(bridgeId: string, expectedVersion: number): Promise<BridgeView>;
  handles(bridgeId: string): Promise<BridgeHandleAppearance[]>;
  log(bridgeId: string, query?: BridgeLogQuery): Promise<BridgeLogResult>;
  /** `bridges.create` (human-only): the wizard's step 3 commit. */
  create(spaceId: string, input: Omit<BridgeCreateInput, 'clientMutationId' | 'spaceId'>): Promise<BridgeView>;
  /** The caller's OWN connections (B1b-5, `/v2/me/…`): numbers they linked, and where each is offered. */
  connections: {
    list(): Promise<BridgeConnectionView[]>;
    /** Link a number (or relink one with `connectionId`); the QR or code arrives on `onConnectionAuth`. */
    begin(input: { label?: string; connectionId?: string; authFlow?: BridgeConnectionAuthFlow }): Promise<BridgeConnectionBeginResult>;
    offer(connectionId: string, spaceId: string): Promise<BridgeConnectionOfferResult>;
    withdraw(connectionId: string, spaceId: string): Promise<BridgeConnectionWithdrawResult>;
    remove(connectionId: string): Promise<BridgeConnectionRemoveResult>;
  };
  /** The owner's live group list for one connection (B1b-7, D28): asked of the runtime, never stored. */
  conversations(connectionId: string): Promise<BridgeConversationListResult>;
  /**
   * Hand-over (D55, D56; #1455): move a bridge onto another member's number,
   * keeping its id, history, handles and loops. Offered by the connection's
   * owner or a space admin, settled only by the receiving number's owner;
   * nothing moves until they accept. All four are human-only.
   */
  handover: {
    offer(bridgeId: string, toConnectionId: string): Promise<BridgeHandoverResult>;
    accept(handoverId: string): Promise<BridgeHandoverResult>;
    decline(handoverId: string): Promise<BridgeHandoverResult>;
    withdraw(handoverId: string): Promise<BridgeHandoverResult>;
  };
}

/**
 * An open hand-over offer on a bridge, as its attention item shows it. There
 * is no `bridges.handover.list`: the offer raises one attention item on the
 * bridge (`bridge.handover:<id>`), assigned to the receiver, and settling it
 * clears the item. So the open item IS the pending offer.
 */
export interface PendingHandover {
  handoverId: string;
  /** The item's text without the CLI hint: who offers what, onto which number. */
  summary: string;
  offeredBy: ActorSummary;
  /** The receiving member; null on a server that does not assign it. */
  receiverId: EntityId | null;
  createdAt: string;
}

/*
 * The item carries the hand-over id only inside its reason, as the CLI hint
 * the server writes LAST (`… Accept in tm8: tm8 bridge handover accept <id>
 * (or decline <id>)`, migration 411). Anchored on that whole tail, to the end
 * of the string, with the id repeated: the group's own title comes earlier in
 * the same reason and any member can rename the group, so a title carrying
 * the phrase must never be what matches. A reason without the tail is some
 * other item on the bridge. Interim until the item exposes the signal key or
 * the id as a field.
 */
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HANDOVER_HINT = new RegExp(`\\s*Accept in tm8: tm8 bridge handover accept (${UUID_RE}) \\(or decline \\1\\)$`);

export function pendingHandoverOf(item: AttentionRequest): PendingHandover | null {
  if (item.status !== 'open' && item.status !== 'acknowledged') return null;
  const hit = HANDOVER_HINT.exec(item.reason);
  if (!hit) return null;
  return {
    handoverId: hit[1]!,
    summary: item.reason.slice(0, hit.index).trim(),
    offeredBy: item.requestedBy,
    receiverId: item.assigneeId ?? null,
    createdAt: item.createdAt,
  };
}

/** What a bridge may be bound to (§2.2): a chat, a work session or a channel in the space. */
export const BRIDGE_TARGET_KINDS = ['chat', 'work_session', 'channel'] as const;

/**
 * The client plus the seam reads the bridge surfaces need around it: target
 * and memory pickers (`collections.query`) and the bridge's `remembers` edges
 * (v2 §2.1: no new table; the same edge a teammate or a task uses).
 */
export interface BridgesPort extends BridgesClient {
  /** Chats, work sessions and channels in the space, for Retarget. */
  targets(spaceId: string): Promise<EntitySummary[]>;
  /** Teammates in the space: who a new session for a bridge runs as (R11). */
  teammates(spaceId: string): Promise<EntitySummary[]>;
  /**
   * R11: start a session for a bridge to land in (`execution.spawn`, no task)
   * and answer its id. Absent where spawn is not wired; the New session
   * choice is then not offered.
   */
  startSession?(spaceId: string, input: { teamMemberId: string; title: string }): Promise<string>;
  /**
   * Start a chat for a bridge to land in (`chat.start`, human-only, which is
   * why the wizard does it in the person's own request) and answer its id.
   * A chat is never empty: `body` is its opening turn. Absent where chats are
   * not wired; the New chat choice is then not offered.
   */
  startChat?(spaceId: string, input: { teammateId: string; model: string; title: string; body: string }): Promise<string>;
  /** The memories this bridge `remembers`, as edges (the edge id is what Unlink deletes). */
  memories(bridgeId: string): Promise<EdgeView[]>;
  /** Memories in the space, for *Link a memory*. */
  memoryCandidates(spaceId: string): Promise<EntitySummary[]>;
  linkMemory(bridgeId: string, memoryId: string): Promise<CommandResult>;
  unlinkMemory(edgeId: string): Promise<CommandResult>;
  /**
   * Is this operation served by the node? The catalog says what exists; a
   * control for an op that does not exist yet is drawn disabled with the
   * reason (`bridges.test`, `bridges.history.import`, the connection ops).
   */
  serves(op: string): boolean;
  /** Lane P's roster port (`bridges.participants.*`); absent on surfaces that do not serve it. */
  people?: BridgePeoplePort;
  /** B3's *Invite to space* door (`seam.commands.createInvite`); absent where invites are not wired. */
  createInvite?: (spaceId: SpaceId, input: CreateInviteInput) => Promise<SpaceInviteView>;
  /** The bridge's open hand-over offers (at most one, D56), from its open attention items. */
  pendingHandovers(spaceId: string, bridgeId: string): Promise<PendingHandover[]>;
  /**
   * The QR or pairing code for this member's own `connections.begin`, pushed
   * on their socket and never stored (§2.5). Absent on a seam with no socket:
   * the link flow then says the code cannot be shown here.
   */
  onConnectionAuth?(cb: (frame: BridgeConnectionAuthFrame) => void): () => void;
}

const mutation = () => ({ clientMutationId: nextMutationId() });

export function createBridgesClient(http: HttpClient): BridgesClient {
  const call = <T>(op: OperationName, bridgeId: string, body: Record<string, unknown>) =>
    http.call<T>(op, { params: { bridgeId }, body: { ...mutation(), ...body } });
  const settle = (op: OperationName, handoverId: string) =>
    http.call<BridgeHandoverResult>(op, { params: { handoverId }, body: mutation() });
  return {
    list: async (spaceId, opts = {}) => (await http.call<{ items: BridgeView[] }>('bridges.list', {
      params: { spaceId },
      ...(opts.includeEnded ? { query: { includeEnded: 'true' } } : {}),
    })).items,
    get: (bridgeId) => http.call<BridgeDetailView>('bridges.get', { params: { bridgeId } }),
    update: (bridgeId, expectedVersion, patch) => call('bridges.update', bridgeId, { expectedVersion, patch }),
    retarget: (bridgeId, expectedVersion, targetId) => call('bridges.retarget', bridgeId, { expectedVersion, targetId }),
    pause: (bridgeId, expectedVersion) => call('bridges.pause', bridgeId, { expectedVersion }),
    resume: (bridgeId, expectedVersion) => call('bridges.resume', bridgeId, { expectedVersion }),
    remove: (bridgeId, expectedVersion) => call('bridges.remove', bridgeId, { expectedVersion }),
    handles: async (bridgeId) =>
      (await http.call<{ items: BridgeHandleAppearance[] }>('bridges.handles.list', { params: { bridgeId } })).items,
    log: (bridgeId, query = {}) => http.call<BridgeLogResult>('bridges.log.read', {
      params: { bridgeId },
      query: Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])),
    }),
    create: (spaceId, input) => http.call<BridgeView>('bridges.create', { params: { spaceId }, body: { ...mutation(), ...input } }),
    connections: {
      list: async () => (await http.call<BridgeConnectionListResult>('bridges.connections.list')).items,
      begin: (input) => http.call<BridgeConnectionBeginResult>('bridges.connections.begin', {
        body: { ...mutation(), provider: 'whatsapp', ...input },
      }),
      offer: (connectionId, spaceId) => http.call<BridgeConnectionOfferResult>('bridges.connections.offer', {
        params: { connectionId }, body: { ...mutation(), spaceId },
      }),
      withdraw: (connectionId, spaceId) => http.call<BridgeConnectionWithdrawResult>('bridges.connections.withdraw', {
        params: { connectionId }, body: { ...mutation(), spaceId },
      }),
      remove: (connectionId) => http.call<BridgeConnectionRemoveResult>('bridges.connections.remove', {
        params: { connectionId }, body: mutation(),
      }),
    },
    conversations: (connectionId) => http.call<BridgeConversationListResult>('bridges.conversations.list', { params: { connectionId } }),
    handover: {
      offer: (bridgeId, toConnectionId) => call('bridges.handover.offer', bridgeId, { toConnectionId }),
      accept: (handoverId) => settle('bridges.handover.accept', handoverId),
      decline: (handoverId) => settle('bridges.handover.decline', handoverId),
      withdraw: (handoverId) => settle('bridges.handover.withdraw', handoverId),
    },
  };
}

/**
 * The port over a client and the seam's own nouns. `served` is the set of
 * operation names the node's catalog declares; the real seam passes the
 * contract catalog, the fixture passes the same.
 */
export function bridgesPortFromSeam(
  client: BridgesClient,
  seam: Pick<Seam, 'query' | 'connections' | 'commands' | 'attentionRequests'>,
  served: (op: string) => boolean,
  onConnectionAuth?: BridgesPort['onConnectionAuth'],
): BridgesPort {
  const kindsQuery = async (spaceId: string, kinds: readonly string[]) =>
    (await seam.query({ spaceId, kinds: [...kinds] as EntityKind[], limit: 200 })).page.items;
  return {
    ...client,
    targets: (spaceId) => kindsQuery(spaceId, BRIDGE_TARGET_KINDS),
    memories: async (bridgeId) =>
      (await seam.connections(bridgeId, { types: ['remembers'], direction: 'outgoing' })).items
        .filter((edge) => edge.source.id === bridgeId),
    memoryCandidates: (spaceId) => kindsQuery(spaceId, ['memory']),
    teammates: (spaceId) => kindsQuery(spaceId, ['team_member']),
    startSession: async (spaceId, input) => {
      const result = await seam.commands.spawn({
        ...mutation(), spaceId, teamMemberId: input.teamMemberId as EntityId, title: input.title,
      });
      if (!result.entity) throw new Error('The server did not return the session it started.');
      return result.entity.id;
    },
    startChat: async (spaceId, input) => {
      const result = await seam.commands.startChat({
        ...mutation(), spaceId: spaceId as SpaceId, teammateId: input.teammateId as EntityId, model: input.model,
        mode: 'ask', workdirMode: 'scratch', title: input.title, body: input.body,
      });
      return result.chat.id;
    },
    linkMemory: (bridgeId, memoryId) =>
      seam.commands.createEdge({ srcId: bridgeId, dstId: memoryId, type: 'remembers', ...mutation() }),
    unlinkMemory: (edgeId) => seam.commands.deleteEdge(edgeId, mutation()),
    serves: served,
    pendingHandovers: async (spaceId, bridgeId) =>
      (await readEntityOpenAttention(seam, spaceId, bridgeId))
        .flatMap((item) => pendingHandoverOf(item) ?? []),
    ...(onConnectionAuth ? { onConnectionAuth } : {}),
  };
}

/** The contract catalog's answer: an operation is served when it is declared and not `reserved`. */
export function catalogServes(op: string): boolean {
  return isOperationName(op) && getOperation(op).status !== 'reserved';
}
