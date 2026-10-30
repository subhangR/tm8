import type {
  BridgeDetailView,
  BridgeFacts,
  BridgeHandleAppearance,
  BridgeLogEntry,
  BridgeView,
  EntitySummary,
} from '@tm8/contract';
import { CollabError } from '@tm8/contract';
import type { BridgesClient } from './api';

/*
 * THE FIXTURE SEAM'S BRIDGES CLIENT — an in-memory store with the server's
 * shapes, for the fixture app, the e2e harness and tests. It does NOT derive
 * status or health (the server's `internal.bridge_view` does): pause sets
 * `paused`, resume sets `live`, remove sets `ended`, and the seeded health is
 * whatever the fixture row says.
 */

/** The view of a fixture bridge ENTITY, so the client answers for the bridges the entity list shows. */
export function fixtureBridgeViewOf(row: EntitySummary): BridgeView | null {
  const state = row.state;
  if (state.kind !== 'bridge') return null;
  const { kind: _kind, ...facts } = state;
  return {
    ...(facts as BridgeFacts),
    id: row.id, spaceId: row.spaceId, version: row.version,
    title: facts.conversation.title, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

const at = (minute: number) => new Date(Date.UTC(2026, 6, 28, 10, minute)).toISOString();

function seedLog(view: BridgeView): BridgeLogEntry[] {
  if (view.conversation.kind !== 'group') return [];
  const entry = (n: number, over: Partial<BridgeLogEntry>): BridgeLogEntry => ({
    id: `${view.id}-msg-${n}`, createdAt: at(40 + n), authorId: view.id, authorKind: 'bridge', authorName: '',
    body: '', parentMessageId: null, rootMessageId: null, origin: null, handle: null, delivery: null, ...over,
  });
  return [
    entry(1, {
      authorName: 'Rahul', body: '@tm8 is the deploy done?',
      origin: { direction: 'in', externalMessageId: 'wa-1', participant: 'Rahul' },
    }),
    entry(2, {
      authorId: '019f0000-0000-7000-8000-0000000000b2', authorKind: 'team_member', authorName: 'Infra main (forge)',
      body: 'Yes — 1.4.2 is live since 10:30. Nothing failed.', parentMessageId: `${view.id}-msg-1`,
      origin: { direction: 'out', externalMessageId: 'wa-2', participant: null },
      delivery: { messageId: `${view.id}-msg-2`, bridgeId: view.id, status: 'sent', externalMessageId: 'wa-2', at: at(42) },
    }),
    entry(3, {
      authorName: 'Ada', authorId: 'mem-ada', authorKind: 'member', body: 'nice, ship the changelog too',
      origin: { direction: 'in', externalMessageId: 'wa-3', participant: 'Ada' },
    }),
    entry(4, {
      authorId: '019f0000-0000-7000-8000-000000000031', authorKind: 'work_session', authorName: 'Release notes',
      body: 'Changelog is up: 1.4.2 adds the bridge panel.', handle: 'keen-otter',
      origin: { direction: 'out', externalMessageId: 'wa-4', participant: null },
      delivery: { messageId: `${view.id}-msg-4`, bridgeId: view.id, status: 'sent', externalMessageId: 'wa-4', at: at(44) },
    }),
  ];
}

function seedHandles(view: BridgeView): BridgeHandleAppearance[] {
  if (view.handles === 0) return [];
  const one = (handle: string, entityId: string, kind: 'chat' | 'work_session', title: string, status: 'live' | 'ended') => ({
    spaceId: view.spaceId, handle, entityId, kind, title, status,
    createdAt: at(0), firstAt: at(10), lastAt: at(44),
  });
  return [
    one('keen-otter', '019f0000-0000-7000-8000-000000000031', 'work_session', 'Release notes', 'live'),
    one('quiet-heron', view.target.id, 'chat', view.target.title, 'live'),
  ].slice(0, view.handles);
}

export function createFixtureBridgesClient(seed: readonly BridgeView[] = []): BridgesClient & { readonly bridges: Map<string, BridgeView> } {
  const bridges = new Map(seed.map((b) => [b.id, b]));
  const logs = new Map(seed.map((b) => [b.id, seedLog(b)]));
  const handles = new Map(seed.map((b) => [b.id, seedHandles(b)]));
  const find = (id: string) => {
    const bridge = bridges.get(id);
    if (!bridge) throw new CollabError('not_found', 'Bridge is unavailable');
    return bridge;
  };
  const write = (id: string, expectedVersion: number, change: (b: BridgeView) => BridgeView) => {
    const bridge = find(id);
    if (bridge.version !== expectedVersion) {
      return Promise.reject(new CollabError('version_conflict', 'The bridge changed since it was read.'));
    }
    if (bridge.status === 'ended') return Promise.reject(new CollabError('conflict', 'The bridge has been removed.'));
    const next = { ...change(bridge), version: bridge.version + 1, updatedAt: new Date().toISOString() };
    bridges.set(id, next);
    return Promise.resolve(next);
  };
  return {
    bridges,
    list: async (spaceId, opts = {}) =>
      [...bridges.values()].filter((b) => b.spaceId === spaceId && (opts.includeEnded || b.status !== 'ended')),
    get: async (bridgeId): Promise<BridgeDetailView> => {
      const view = find(bridgeId);
      const posters = (logs.get(bridgeId) ?? []).filter((m) => m.origin?.direction === 'out');
      return {
        ...view,
        recentPosters: posters.map((m) => ({
          actorId: m.authorId ?? '', actorKind: m.authorKind ?? 'team_member', displayName: m.authorName,
          handle: m.handle, posts: 1, lastPostAt: m.createdAt,
        })),
        summary: null, // #1438 (D74): the fixture has no rolling summary.
      };
    },
    update: (id, v, patch) => write(id, v, (b) => {
      const { policy, workerWake, conversationTitle, ...rest } = patch;
      return {
        ...b, ...rest,
        policy: { ...b.policy, ...policy },
        workers: workerWake ? { wake: workerWake } : b.workers,
        ...(conversationTitle ? { title: conversationTitle, conversation: { ...b.conversation, title: conversationTitle } } : {}),
      };
    }),
    retarget: (id, v, targetId) => write(id, v, (b) => ({ ...b, target: { ...b.target, id: targetId } })),
    pause: (id, v) => write(id, v, (b) => ({ ...b, status: 'paused', pausedAt: new Date().toISOString() })),
    resume: (id, v) => write(id, v, (b) => ({ ...b, status: 'live', pausedAt: null })),
    remove: (id, v) => write(id, v, (b) => ({ ...b, status: 'ended', endedAt: new Date().toISOString() })),
    handles: async (id) => { find(id); return handles.get(id) ?? []; },
    log: async (id) => {
      const view = find(id);
      const items = logs.get(id) ?? [];
      return { bridgeId: id, logAnchorId: view.target.kind === 'channel' ? view.target.id : id, items, lastMessageId: items[items.length - 1]?.id ?? null, more: false, olderCursor: null }; // olderCursor: #1446's paging
    },
  };
}
