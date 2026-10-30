import type {
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
  BridgeLogResult,
  BridgeUpdateInput,
  BridgeView,
  CommandResult,
  EdgeView,
  EntityKind,
  EntitySummary,
  OperationName,
} from '@tm8/contract';
import { getOperation, isOperationName } from '@tm8/contract';
import { nextMutationId } from '../authoring/commands';
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
  };
}

/**
 * The port over a client and the seam's own nouns. `served` is the set of
 * operation names the node's catalog declares; the real seam passes the
 * contract catalog, the fixture passes the same.
 */
export function bridgesPortFromSeam(
  client: BridgesClient,
  seam: Pick<Seam, 'query' | 'connections' | 'commands'>,
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
    linkMemory: (bridgeId, memoryId) =>
      seam.commands.createEdge({ srcId: bridgeId, dstId: memoryId, type: 'remembers', ...mutation() }),
    unlinkMemory: (edgeId) => seam.commands.deleteEdge(edgeId, mutation()),
    serves: served,
    ...(onConnectionAuth ? { onConnectionAuth } : {}),
  };
}

/** The contract catalog's answer: an operation is served when it is declared and not `reserved`. */
export function catalogServes(op: string): boolean {
  return isOperationName(op) && getOperation(op).status !== 'reserved';
}
