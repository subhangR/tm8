import type { BridgePeoplePort } from './people';
import type { CreateInviteInput, SpaceId, SpaceInviteView } from '@tm8/contract';
import type {
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
  /** Lane P's roster port (`bridges.participants.*`); absent on surfaces that do not serve it. */
  people?: BridgePeoplePort;
  /** B3's *Invite to space* door (`seam.commands.createInvite`); absent where invites are not wired. */
  createInvite?: (spaceId: SpaceId, input: CreateInviteInput) => Promise<SpaceInviteView>;
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
  };
}

/** The contract catalog's answer: an operation is served when it is declared and not `reserved`. */
export function catalogServes(op: string): boolean {
  return isOperationName(op) && getOperation(op).status !== 'reserved';
}
