/**
 * Thread test helpers: a latency-0 seeded facade, provider wrapping, and a
 * synthetic message factory for the volume tests (the graph store's live-tail
 * cache is deliberately bounded, so 10k rows come from the facade, not it).
 */
import type { ReactNode } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { PopoverProvider } from '../../kit';
import { createSeededWorld, MockFacade } from '../../mock';
import { CollabFacadeProvider } from '../../entity';
import {
  useCollectionsStore, useGraphStore, useNavStore, usePresenceStore,
} from '../../stores';
import type { CollabFacade } from '../../facade';
import type {
  ActorSummary, EntityId, MessageView, Page, SpaceNavigation,
} from '../../types/contract';

export function createFacade(): MockFacade {
  return new MockFacade(createSeededWorld(), { latency: 0 });
}

export function resetStores(): void {
  useGraphStore.getState().reset();
  useCollectionsStore.getState().reset();
  usePresenceStore.getState().reset();
  useNavStore.getState().reset();
}

export function renderWith(facade: CollabFacade, ui: ReactNode): RenderResult {
  return render(
    <CollabFacadeProvider facade={facade}>
      <PopoverProvider>{ui}</PopoverProvider>
    </CollabFacadeProvider>,
  );
}

/** Counts message rows actually mounted in the DOM. */
export function renderedMessageCount(): number {
  return document.querySelectorAll('[data-cv2-msg]').length;
}

const ACTOR: ActorSummary = {
  id: 'mem_1', kind: 'member', displayName: 'Volume Tester', avatar: '🧪',
  role: 'member', isAgent: false,
};

/** One synthetic root message; cheap enough to build ten thousand of them. */
export function fakeMessage(anchorId: EntityId, i: number): MessageView {
  const at = new Date(1_700_000_000_000 + i * 1000).toISOString();
  return {
    id: `msg_${i}`,
    spaceId: 'spc_volume',
    kind: 'message',
    title: `message ${i}`,
    parentId: null,
    position: i,
    visibility: 'space',
    version: 1,
    activityAt: at,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    createdBy: ACTOR,
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    state: { kind: 'message', anchorId, rootMessageId: null, author: ACTOR, editedAt: null },
    badges: {},
    content: { kind: 'message', body: `line ${i}`, mentions: [], attachments: [] },
    replyCount: 0,
  } as MessageView;
}

/**
 * The smallest facade the Thread will run against: history, an anchor, and a
 * subscription that never fires. Anything the Thread calls beyond this it must
 * tolerate failing — which is the point of the test.
 */
export function volumeFacade(anchorId: EntityId, count: number): CollabFacade {
  const items = Array.from({ length: count }, (_, i) => fakeMessage(anchorId, i));
  const anchor = {
    id: anchorId, spaceId: 'spc_volume', kind: 'channel', title: 'volume',
    parentId: null, position: 0, visibility: 'space', version: 1,
    activityAt: items[0].createdAt, createdAt: items[0].createdAt,
    updatedAt: items[0].createdAt, deletedAt: null, createdBy: ACTOR,
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: count, viewerReaction: null },
    state: { kind: 'channel', topic: 'volume', unreadCount: 0, workingAgentCount: 0 },
    badges: {},
  };
  const stub = {
    getMessages: (): Promise<Page<MessageView>> => Promise.resolve({ items, nextCursor: null, total: count }),
    getEntity: () => Promise.resolve({
      ...anchor,
      content: { kind: 'channel', topic: 'volume', pinned: [], autoTabs: [] },
      hierarchy: { parent: null, children: { items: [], nextCursor: null }, path: [] },
      connections: { outgoing: [], incoming: [], unresolvedHardDependencyCount: 0 },
      capabilities: {
        canEdit: true, canDelete: false, canAddChild: true, canLink: true,
        canPull: false, canReact: true, canGrantPoints: true, canComplete: false,
      },
    }),
    getActivity: () => Promise.resolve({ items: [], nextCursor: null }),
    getNavigation: (): Promise<SpaceNavigation> => Promise.resolve({
      spaceId: 'spc_volume', viewer: ACTOR, unreadTotal: 0, channels: [],
    }),
    subscribe: () => () => {},
  };
  return stub as unknown as CollabFacade;
}
