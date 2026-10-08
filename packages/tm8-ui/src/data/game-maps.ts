/** Authenticated read adapter for Game. No fixture substitution or map mutations. */
import type { CollectionQuery, Cursor, EdgeView, EntitySummary, Page } from '@tm8/contract';
import { fromProjection, type MapEdge, type MapEntity, type MapScope } from '../story/game/map-model';
import type { Seam } from './seam';

import type { GameMapLoader } from '../game/types';
export type { GameMapLoader, GameMapResult } from '../game/types';
type GameReadPort = Pick<Seam, 'query' | 'entity' | 'connections' | 'spaces' | 'liveness'>;

const MAP_KINDS: CollectionQuery['kinds'] = [
  'story', 'task', 'work_session', 'member', 'team_member', 'skill',
  'doc', 'drawing', 'artifact', 'file', 'project', 'pull_request', 'commit', 'worktree',
];
const MAP_EDGE_TYPES = ['depends_on', 'working_on', 'produces'];
const PAGE_LIMIT = 200;
// Fail explicitly instead of returning a silently partial map on runaway paging.
const MAX_PAGES = 100;
const READ_CONCURRENCY = 4;

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
    pendingAttention: row.badges.attention?.pendingCount ?? 0,
    mailbox: { count: row.counters.messages },
    ...(liveness ? { live: liveness === 'live' } : {}),
  };
}

function edgeOf(row: EdgeView): MapEdge {
  return {
    id: row.id, type: row.type, fromId: row.source.id, toId: row.target.id,
    endedAt: typeof row.props.endedAt === 'string' ? row.props.endedAt : null,
    status: typeof row.props.status === 'string' ? row.props.status : null,
  };
}

export function createGameMapLoader(seam: GameReadPort, spaceId: string): GameMapLoader {
  const query = async (shape: Omit<CollectionQuery, 'spaceId' | 'cursor' | 'limit'>, signal?: AbortSignal) => {
    const rows = await pages((cursor) => seam.query({ spaceId, ...shape, cursor, limit: PAGE_LIMIT }).then(r => r.page), signal);
    rows.forEach(row => assertSpace(row, spaceId));
    return rows;
  };

  return async (scope, signal) => {
    checkCancelled(signal);
    if (!spaceId || (scope.kind !== 'space' && scope.kind !== 'story') || !scope.id ||
      (scope.kind === 'space' && scope.id !== spaceId)) throw new Error('Map scope does not belong to the active space');

    const entities = new Map<string, MapEntity>();
    const edges = new Map<string, MapEdge>();
    let title: string;
    let warnings: readonly string[] = [];
    if (scope.kind === 'space') {
      const spaces = await read(() => seam.spaces(), signal);
      const space = spaces.find(s => s.id === spaceId);
      if (!space) throw Object.assign(new Error('Game space is unavailable'), { code: 'not_found' });
      title = space.name;
      for (const row of await query({ kinds: MAP_KINDS }, signal)) {
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
      for (const row of snapshot.entities) entities.set(row.id, { ...row, spaceId });
      for (const session of page.sessions) {
        const mapped = entities.get(session.id);
        const status = session.runtimeStatus;
        const recorded = status === 'spawning' || status === 'running' || status === 'idle' || status === 'exited' || status === 'failed' ? status : null;
        if (mapped) mapped.live = seam.liveness.statusOf({ id: session.id, status: recorded }) === 'live';
      }
      for (const edge of snapshot.edges) edges.set(edge.id, edge);
      // StoryPage's child-story preview is bounded separately from its trail.
      for (const row of await query({ kinds: ['story'], parentId: story.id }, signal)) {
        entities.set(row.id, summaryOf(row, seam));
      }
      // Fill contained hierarchy beyond the trail preview, using the server's
      // same-kind subtree read. Followed sideways trail rows stay authoritative.
      for (const root of page.roots) {
        const kind = MAP_KINDS!.find(kind => kind === root.kind);
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

    // Dependencies/deliverables originate from tasks; walking robots use session
    // claims. Library and factory records need no outgoing connection reads.
    const ids = [...entities.values()].filter(row => row.kind === 'task' || row.kind === 'work_session').map(row => row.id);
    let next = 0;
    let failed = false;
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, ids.length) }, async () => {
      try {
        while (!failed && next < ids.length) {
          const id = ids[next++]!;
          const rows = await pages(cursor => seam.connections(id, {
            types: MAP_EDGE_TYPES, direction: 'outgoing', cursor, limit: PAGE_LIMIT,
          }), signal);
          for (const row of rows) {
            // A connection must never pull an unrelated or hidden peer into scope.
            if (row.source.spaceId !== spaceId || row.target.spaceId !== spaceId) continue;
            if (entities.has(row.source.id) && entities.has(row.target.id)) edges.set(row.id, edgeOf(row));
          }
        }
      } catch (error) { failed = true; throw error; }
    }));
    checkCancelled(signal);
    return {
      title,
      input: { scope: { ...scope }, entities: [...entities.values()],
        edges: [...edges.values()].filter(e => entities.has(e.fromId) && entities.has(e.toId)), warnings },
    };
  };
}
