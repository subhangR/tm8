/** Authenticated read adapter for Game. No fixture substitution or map mutations. */
import type { CollectionQuery, Cursor, EntitySummary, GraphEdgeView, Page } from '@tm8/contract';
import { fromProjection, type MapEdge, type MapEntity, type MapInput, type MapType } from '../story/game/map-model';
import type { Seam } from './seam';
import { applyGameMailboxCounts, createGameMailboxReader } from './game-mailboxes';

import type { GameMapLoader } from '../game/types';
export type { GameMapLoader, GameMapResult } from '../game/types';
type GameReadPort = Pick<Seam, 'query' | 'entity' | 'graph' | 'spaces' | 'liveness' | 'unreadCounts'>;

const MAP_KINDS: CollectionQuery['kinds'] = [
  'story', 'task', 'work_session', 'member', 'team_member', 'skill',
  'doc', 'drawing', 'artifact', 'file', 'project', 'pull_request', 'commit', 'worktree',
];
const MAP_EDGE_TYPES = ['depends_on', 'working_on', 'produces'];
const PAGE_LIMIT = 200;
// Fail explicitly instead of returning a silently partial map on runaway paging.
const MAX_PAGES = 100;
const GRAPH_NODE_LIMIT = 200;
const GRAPH_EDGE_LIMIT = 1000;
const KINDS_BY_TYPE: Record<MapType, NonNullable<CollectionQuery['kinds']>> = {
  hub: ['story'], taskland: ['task', 'work_session'],
  office: ['member', 'team_member', 'work_session', 'skill'],
  library: ['doc', 'drawing', 'artifact', 'file'],
  factory: ['project', 'pull_request', 'commit', 'worktree'], town: MAP_KINDS!,
};

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Map loading cancelled', 'AbortError');
}

/** Seam reads do not accept a signal. Race cancellation and ignore late responses. */
function read<T>(get: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  checkCancelled(signal);
  if (!signal) return get();
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new DOMException('Map loading cancelled', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => { checkCancelled(signal); return get(); }).then(
      (result) => { signal.removeEventListener('abort', cancel); if (!signal.aborted) resolve(result); },
      (error) => { signal.removeEventListener('abort', cancel); reject(error); },
    );
  });
}

async function pages<T>(get: (cursor?: Cursor) => Promise<Page<T>>, signal?: AbortSignal): Promise<T[]> {
  const rows: T[] = [], seen = new Set<Cursor>();
  let cursor: Cursor | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await read(() => get(cursor), signal);
    rows.push(...result.items);
    if (!result.nextCursor) return rows;
    if (seen.has(result.nextCursor)) throw new Error('Map read returned a repeated cursor');
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error('Map read exceeded the pagination limit');
}

function assertSpace(row: Pick<EntitySummary, 'spaceId'>, spaceId: string): void {
  if (row.spaceId !== spaceId) throw new Error('Map read returned an entity from another space');
}

function summaryOf(row: EntitySummary, seam: GameReadPort): MapEntity {
  const mapped = fromProjection({ entities: [row], edges: [] }).entities[0]!;
  const liveness = row.state.kind === 'work_session' ? seam.liveness.statusOf({ id: row.id, status: row.state.status }) : null;
  return {
    ...mapped,
    statusCategory: row.category ?? null,
    ...(row.state.kind === 'task' ? {
      acceptance: { ...row.state.acceptance },
      estimateTent: row.state.progress?.tent,
      ownProgress: row.state.progress?.own ?? null,
    } : {}),
    pendingAttention: row.badges.attention?.pendingCount ?? 0,
    // The read port has message totals, not a viewer-specific unread cursor.
    mailbox: { count: row.counters.messages, basis: 'messages' },
    ...(liveness ? { live: liveness === 'live' } : {}),
  };
}

function edgeOf(row: GraphEdgeView): MapEdge {
  return {
    id: row.id, type: row.type, fromId: row.sourceId, toId: row.targetId,
    updatedAt: row.updatedAt ?? null,
    endedAt: typeof row.props.endedAt === 'string' ? row.props.endedAt : null,
    status: typeof row.props.status === 'string' ? row.props.status : null,
  };
}

export function createGameMapLoader(seam: GameReadPort, spaceId: string): GameMapLoader {
  const readMailboxes = createGameMailboxReader(seam, spaceId);
  const query = async (shape: Omit<CollectionQuery, 'spaceId' | 'cursor' | 'limit'>, signal?: AbortSignal) => {
    const rows = await pages((cursor) => seam.query({ spaceId, ...shape, cursor, limit: PAGE_LIMIT }).then(r => r.page), signal);
    rows.forEach(row => assertSpace(row, spaceId));
    return rows;
  };

  return async (scope, signal, type?: MapType) => {
    checkCancelled(signal);
    if (!spaceId || (scope.kind !== 'space' && scope.kind !== 'story') || !scope.id ||
      (scope.kind === 'space' && scope.id !== spaceId)) throw new Error('Map scope does not belong to the active space');

    const kinds = type ? KINDS_BY_TYPE[type] : MAP_KINDS!;
    const entities = new Map<string, MapEntity>();
    const edges = new Map<string, MapEdge>();
    let title: string;
    let warnings: readonly string[] = [];
    if (scope.kind === 'space') {
      const spaces = await read(() => seam.spaces(), signal);
      const space = spaces.find(s => s.id === spaceId);
      if (!space) throw Object.assign(new Error('Game space is unavailable'), { code: 'not_found' });
      title = space.name;
      for (const row of await query({ kinds }, signal)) {
        entities.set(row.id, summaryOf(row, seam));
      }
    } else {
      const story = await read(() => seam.entity(scope.id), signal);
      assertSpace(story, spaceId);
      if (story.kind !== 'story' || story.content.kind !== 'story' || !story.content.page) {
        throw Object.assign(new Error('Game story is unavailable'), { code: 'not_found' });
      }
      title = story.title;
      const page = story.content.page;
      const snapshot = fromProjection({ id: story.id, kind: 'story', page }, scope);
      warnings = snapshot.warnings ?? [];
      for (const row of snapshot.entities) if (kinds.some(kind => kind === row.kind)) entities.set(row.id, { ...row, spaceId });
      for (const session of page.sessions) {
        const mapped = entities.get(session.id);
        const status = session.runtimeStatus;
        const recorded = status === 'spawning' || status === 'running' || status === 'idle' || status === 'exited' || status === 'failed' ? status : null;
        if (mapped) mapped.live = seam.liveness.statusOf({ id: session.id, status: recorded }) === 'live';
      }
      if (!type || type === 'taskland' || type === 'town') for (const edge of snapshot.edges) edges.set(edge.id, edge);
      // StoryPage's child-story preview is bounded separately from its trail.
      if (!type || type === 'hub') for (const row of await query({ kinds: ['story'], parentId: story.id }, signal)) {
        entities.set(row.id, summaryOf(row, seam));
      }
      // Fill contained hierarchy beyond the trail preview, using the server's
      // same-kind subtree read. Followed sideways trail rows stay authoritative.
      for (const root of page.roots) {
        const kind = kinds.find(kind => kind === root.kind);
        if (!kind) continue;
        const descendants = await query({ subtreeOf: root.id, kinds: [kind] }, signal);
        const byId = new Map(descendants.map(row => [row.id, row]));
        const reachesLimit = descendants.some(row => {
          let parent = row.parentId, depth = 1;
          const seen = new Set([row.id]);
          while (parent && parent !== root.id && !seen.has(parent)) {
            seen.add(parent); parent = byId.get(parent)?.parentId ?? null; depth++;
          }
          return parent === root.id && depth >= 32;
        });
        if (reachesLimit && !warnings.some(warning => warning.includes('depth 32'))) {
          warnings = [...warnings, 'Contained hierarchy reaches depth 32; deeper descendants may be absent'];
        }
        for (const row of descendants) {
          entities.set(row.id, summaryOf(row, seam));
        }
      }
    }

    // Trail nodes may contain sessions absent from StoryPage.sessions' bounded
    // preview. Apply the same liveness authority to every admitted session.
    for (const entity of entities.values()) if (entity.kind === 'work_session' && entity.live === undefined) {
      const state = entity.processState ?? entity.status;
      const recorded = state === 'spawning' || state === 'running' || state === 'idle' || state === 'exited' || state === 'failed' ? state : null;
      entity.live = seam.liveness.statusOf({ id: entity.id, status: recorded }) === 'live';
    }

    // The bounded graph contributes relations only. Cursor-paged primary rows
    // and authoritative StoryPage membership decide which entities are admitted.
    if ((!type || type === 'taskland' || type === 'town') && entities.size) {
      try {
        const graph = await read(() => seam.graph({ spaceId, kinds, edgeTypes: MAP_EDGE_TYPES,
          limit: GRAPH_NODE_LIMIT }), signal);
        const peers = new Map(graph.nodes.filter(row => row.spaceId === spaceId).map(row => [row.id, row]));
        for (const row of graph.edges) {
          if (peers.has(row.sourceId) && peers.has(row.targetId) &&
            entities.has(row.sourceId) && entities.has(row.targetId)) edges.set(row.id, edgeOf(row));
        }
        const missingAdmittedPeer = [...entities.keys()].some(id => !peers.has(id));
        if ((graph.nodes.length >= GRAPH_NODE_LIMIT && (scope.kind === 'space' || missingAdmittedPeer)) ||
          graph.edges.length >= GRAPH_EDGE_LIMIT) {
          warnings = [...warnings, 'Map relations reached their read budget; some roads, workers or deliverables may be absent'];
        }
      } catch (error) {
        checkCancelled(signal);
        if (error instanceof Error && error.name === 'AbortError') throw error;
        warnings = [...warnings, 'Map relations could not be loaded; places and their hierarchy remain available'];
      }
    }
    checkCancelled(signal);
    const input: MapInput = { scope: { ...scope }, entities: [...entities.values()], taskHierarchyComplete: scope.kind === 'space',
      edges: [...edges.values()].filter(e => entities.has(e.fromId) && entities.has(e.toId)), warnings };
    const hasMailboxes = input.entities.some(entity => entity.kind === 'task' || entity.kind === 'work_session' || entity.kind === 'story');
    const snapshot = hasMailboxes ? await readMailboxes(signal) : null;
    checkCancelled(signal);
    return {
      title,
      input: hasMailboxes ? applyGameMailboxCounts(input, snapshot, spaceId) : input,
    };
  };
}
