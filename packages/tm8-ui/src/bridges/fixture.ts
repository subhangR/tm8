import type {
  BridgeConnectionAuthFrame,
  BridgeConnectionView,
  BridgeDetailView,
  BridgeFacts,
  BridgeHandleAppearance,
  BridgeLogEntry,
  BridgeView,
  EntitySummary,
} from '@tm8/contract';
import { CollabError } from '@tm8/contract';
import type { BridgesClient } from './api';
import type { ConversationItem } from '@tm8/contract';

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
    body: '', parentMessageId: null, rootMessageId: null, origin: null, handle: null, delivery: null, trust: null, ...over,
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


/**
 * A stand-in QR for the fixture: a 25x25 pattern with the three finder squares,
 * drawn so a screenshot shows what the dialog looks like. It is NOT a scannable
 * code and links nothing — the real one comes from the runtime, base64 PNG.
 */
export const FIXTURE_QR_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABkAAAAZCAAAAADhgtq/AAAAiklEQVR4nF1SCQLAIAji/59mKwWxdlSKBhqgwf857wyecT1n2ZMshb8Te51focu3PFSqsLatJv24eGBZ9oEixUabu6MeWZPVDDBY0uFwSkZUkEWBByM9iORgOPc2sw1lywZdX7pg0hqt0M5WV6kZPj1lCsNg1GmJRfQpTlP4eLjyr5vidq6mem3VH+1iKOZ5SJ1xAAAAAElFTkSuQmCC';

const FIXTURE_SPACE = 'sp-atelier';
const NOW = '2026-07-28T10:40:00.000Z';

/** The viewer's own numbers: one offered here (carrying Infra and Rahul), one linked but not offered here. */
function seedConnections(views: readonly BridgeView[]): BridgeConnectionView[] {
  const wa = views.find((v) => v.provider === 'whatsapp');
  return [
    {
      id: wa?.connectionId ?? '0b9f3c1e-6b1a-4c55-9a51-7d3a0c1b9494', provider: 'whatsapp', ownerAccountId: 'acct-ada',
      label: 'Ada · work phone', externalAccountId: '+91 ···· 9494', status: 'linked', runtimeId: 'rt-1',
      createdAt: NOW, lastSeenAt: NOW,
      offers: [{
        credentialId: '019f0000-0000-7000-8000-0000000000c1', spaceId: FIXTURE_SPACE, visibility: 'private',
        status: 'active', createdAt: NOW, bridges: views.filter((v) => v.provider === 'whatsapp' && v.status !== 'ended').length,
      }],
    },
    {
      id: '6f1e2d3c-4b5a-4968-8776-655443322110', provider: 'whatsapp', ownerAccountId: 'acct-ada',
      label: 'Ada · personal', externalAccountId: '+91 ···· 1999', status: 'linked', runtimeId: 'rt-1',
      createdAt: NOW, lastSeenAt: NOW, offers: [],
    },
  ];
}

/** The live group list a runtime would answer for a linked number. */
function seedConversations(views: readonly BridgeView[]): ConversationItem[] {
  const infra = views.find((v) => v.conversation.kind === 'group');
  return [
    { conversationId: infra?.conversation.externalId ?? '1203630xxxx@g.us', kind: 'group', name: 'Infra', size: 14, canSend: true, reason: null },
    { conversationId: '1203631gaming@g.us', kind: 'group', name: 'Gaming', size: 31, canSend: true, reason: null },
    { conversationId: '1203632family@g.us', kind: 'group', name: 'Family', size: 9, canSend: false, reason: 'admins_only' },
    { conversationId: '1203633release@g.us', kind: 'group', name: 'Release 1.4', size: 6, canSend: true, reason: null },
    { conversationId: '919800000094@s.whatsapp.net', kind: 'self', name: 'Ada (you)', size: 1, canSend: true, reason: null },
  ];
}

export function createFixtureBridgesClient(
  seed: readonly BridgeView[] = [],
  /** Resolves a target id to its row, so a created bridge names its target. */
  targetOf: (id: string) => EntitySummary | undefined = () => undefined,
): BridgesClient & {
  readonly bridges: Map<string, BridgeView>;
  readonly connectionsById: Map<string, BridgeConnectionView>;
  /** The socket's auth frames, for a fixture seam's `onConnectionAuth`. */
  onConnectionAuth(cb: (frame: BridgeConnectionAuthFrame) => void): () => void;
} {
  const bridges = new Map(seed.map((b) => [b.id, b]));
  const logs = new Map(seed.map((b) => [b.id, seedLog(b)]));
  const handles = new Map(seed.map((b) => [b.id, seedHandles(b)]));
  const connectionsById = new Map(seedConnections(seed).map((c) => [c.id, c]));
  const conversationList = seedConversations(seed);
  const authSubs = new Set<(frame: BridgeConnectionAuthFrame) => void>();
  const connection = (id: string) => {
    const c = connectionsById.get(id);
    if (!c) throw new CollabError('not_found', 'Connection is unavailable');
    return c;
  };
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
    connectionsById,
    onConnectionAuth: (cb) => { authSubs.add(cb); return () => { authSubs.delete(cb); }; },
    create: async (spaceId, input) => {
      const taken = [...bridges.values()].find((b) => b.spaceId === spaceId && b.status !== 'ended'
        && b.conversation.externalId === input.conversation.externalId);
      if (taken) throw new CollabError('conflict', `already connected → ${taken.target.title}`, { details: { reason: 'conversation_connected' } });
      if (input.targetId === 'none') throw new CollabError('invalid_input', 'pick a target');
      const base = [...bridges.values()][0]!;
      const id = `ent-bridge-${bridges.size + 1}`;
      const view: BridgeView = {
        ...base, id, spaceId, version: 1, title: input.conversation.title,
        connectionId: input.connectionId,
        conversation: { externalId: input.conversation.externalId, kind: input.conversation.kind, title: input.conversation.title, memberCount: input.conversation.memberCount ?? null },
        target: (() => {
          const t = targetOf(input.targetId);
          const kind = t && (t.kind === 'chat' || t.kind === 'work_session' || t.kind === 'channel') ? t.kind : 'chat';
          return { kind, id: input.targetId, title: t?.title ?? input.targetId };
        })(),
        policy: { ...base.policy, ...input.policy },
        status: 'live', pausedAt: null, endedAt: null, handles: 0,
        people: { participants: 0, linked: 0, guestsSeen7d: 0 },
        purpose: input.purpose ?? null, retentionDays: input.retentionDays ?? null,
        health: { ...base.health, queued: 0, failed24h: 0, detail: null },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      bridges.set(id, view);
      logs.set(id, []);
      handles.set(id, []);
      return view;
    },
    connections: {
      list: async () => [...connectionsById.values()].filter((c) => c.status !== 'removed'),
      begin: async (input) => {
        const id = input.connectionId ?? `0c0c0c0c-0000-4000-8000-${String(connectionsById.size + 1).padStart(12, '0')}`;
        const prev = connectionsById.get(id);
        const next: BridgeConnectionView = {
          id, provider: 'whatsapp', ownerAccountId: 'acct-ada', label: input.label ?? prev?.label ?? 'New number',
          externalAccountId: prev?.externalAccountId ?? null, status: 'connecting', runtimeId: 'rt-1',
          createdAt: prev?.createdAt ?? new Date().toISOString(), lastSeenAt: null, offers: prev?.offers ?? [],
        };
        connectionsById.set(id, next);
        const expiresAt = new Date(Date.now() + 120_000).toISOString();
        const frame: BridgeConnectionAuthFrame = input.authFlow?.kind === 'pairing'
          ? { type: 'bridge.connection.auth', connectionId: id, pairingCode: 'K7Q2-9MXD', expiresAt }
          : { type: 'bridge.connection.auth', connectionId: id, qrPng: FIXTURE_QR_PNG, expiresAt };
        setTimeout(() => { for (const cb of authSubs) cb(frame); }, 50);
        return { connection: next, runtime: 'connecting' };
      },
      offer: async (connectionId, spaceId) => {
        const c = connection(connectionId);
        const credentialId = `019f0000-0000-7000-8000-${String(c.offers.length + 200).padStart(12, '0')}`;
        const next = { ...c, offers: [...c.offers, { credentialId, spaceId, visibility: 'private' as const, status: 'active' as const, createdAt: new Date().toISOString(), bridges: 0 }] };
        connectionsById.set(connectionId, next);
        return { connection: next, credentialId };
      },
      withdraw: async (connectionId, spaceId) => {
        const c = connection(connectionId);
        const offer = c.offers.find((o) => o.spaceId === spaceId);
        if (!offer) throw new CollabError('not_found', 'not offered to that space');
        const next = { ...c, offers: c.offers.filter((o) => o !== offer) };
        connectionsById.set(connectionId, next);
        return { connection: next, credentialId: offer.credentialId, pausedBridgeIds: [] };
      },
      remove: async (connectionId) => {
        const c = connection(connectionId);
        const ended = [...bridges.values()].filter((b) => b.connectionId === connectionId && b.status !== 'ended');
        for (const b of ended) bridges.set(b.id, { ...b, status: 'ended', endedAt: new Date().toISOString() });
        const next = { ...c, status: 'removed' as const, offers: [] };
        connectionsById.set(connectionId, next);
        return { connection: next, endedBridgeIds: ended.map((b) => b.id), revokedCredentialIds: c.offers.map((o) => o.credentialId), runtime: 'logged_out' };
      },
    },
    conversations: async (connectionId) => {
      const c = connection(connectionId);
      if (c.status !== 'linked') throw new CollabError('conflict', 'the number is not linked: link it first', { details: { reason: 'not_linked' } });
      return { connectionId, items: conversationList };
    },
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
    /* #1446's paging, closely enough for a fixture: pages of two, newest
       first by page; `before` answers the page just older than that id. */
    log: async (id, query = {}) => {
      const view = find(id);
      const all = logs.get(id) ?? [];
      const size = 2;
      const end = query.before ? Math.max(0, all.findIndex((m) => m.id === query.before)) : all.length;
      const start = Math.max(0, end - size);
      const items = all.slice(start, end);
      const olderCursor = start > 0 ? items[0]!.id : null;
      return { bridgeId: id, logAnchorId: view.target.kind === 'channel' ? view.target.id : id, items, lastMessageId: items[items.length - 1]?.id ?? null, more: false, olderCursor }; // olderCursor: #1446's paging
    },
  };
}
