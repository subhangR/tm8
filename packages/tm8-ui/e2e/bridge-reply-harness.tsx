/**
 * THE COMPOSER UNDER A BRIDGED MESSAGE, IN A BROWSER (§4.5, D77).
 *
 * Mounts the shipping `ChannelScreen` on a WhatsApp-bridged channel with the
 * thread of a guest's bridged message open, so the thread composer shows
 * `BridgeReplyTarget`: *Reply in WhatsApp* by default, *Reply here only* one
 * tap away. A post is recorded on `document.body.dataset.posted`, so the
 * capture can show what the composer sent. That the server never enqueues a
 * here-only reply is held by
 * `packages/server/test/db/bridge-message-badges.pg.test.ts`.
 *
 * `e2e/capture-bridge-reply.mjs` drives it and saves the screenshots.
 */
import { createRoot } from 'react-dom/client';
import type { ActorSummary, EntityFeedPage, FeedItem, MessageBridgeView, MessageView } from '@tm8/contract';
import { ChannelScreen } from '../src/channel-screen/ChannelScreen';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';

const ANCHOR = '019f0000-0000-7000-8000-0000000b3001';
const BRIDGE = '019f0000-0000-7000-8000-0000000b3b01';
const VIEWER: ActorSummary = { id: '019f0000-0000-7000-8000-0000000b3a01', kind: 'member', displayName: 'Subhang', avatar: null, isAgent: false };
const BRIDGE_AUTHOR: ActorSummary = { id: BRIDGE, kind: 'bridge' as ActorSummary['kind'], displayName: 'Infra · WhatsApp', avatar: null, isAgent: false };
const PRIYA: ActorSummary = { id: '019f0000-0000-7000-8000-0000000b3a02', kind: 'member', displayName: 'Priya', avatar: null, isAgent: false };

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const inbound = (participant: string, trust: MessageBridgeView['trust']): MessageBridgeView => ({
  bridgeId: BRIDGE, provider: 'whatsapp', conversation: 'Infra', direction: 'in', participant, trust, delivery: null,
});

function msg(id: string, author: ActorSummary, body: string, ago: number, over: Partial<MessageView> = {}): MessageView {
  return {
    id, kind: 'message', title: '', spaceId: 'sp-1', parentId: null,
    createdAt: minutesAgo(ago), updatedAt: minutesAgo(ago), deletedAt: null, version: 1, createdBy: author,
    state: { kind: 'message', anchorId: ANCHOR, author, messageBatchId: null },
    content: { kind: 'message', body, mentions: [], attachments: [] },
    replyCount: 0,
    ...over,
  } as unknown as MessageView;
}
const item = (message: MessageView): FeedItem => ({
  itemId: `feed-${message.id}`, createdAt: message.createdAt, sortId: `${message.createdAt}#${message.id}`,
  via: ['anchored'], actor: message.state.author, sourceWorkSessionId: null, anchor: null,
  logicalOperationId: null, itemKind: 'message', message, delivery: [],
} as FeedItem);

const root = msg('019f0000-0000-7000-8000-0000000b3d01', BRIDGE_AUTHOR, '@tm8 is the deploy done? the dashboard still says 1.4.1', 12,
  { bridge: inbound('Rahul Mehta', 'guest'), replyCount: 1, lastReplyAt: minutesAgo(8), replyParticipants: [PRIYA] } as Partial<MessageView>);
const replyFromPriya = msg('019f0000-0000-7000-8000-0000000b3d02', PRIYA, 'it rolled at 10:30, the dashboard caches for 15m', 8,
  { bridge: inbound('Priya', 'linked'), state: { kind: 'message', anchorId: ANCHOR, author: PRIYA, messageBatchId: null, rootMessageId: root.id } } as Partial<MessageView>);
const local = msg('019f0000-0000-7000-8000-0000000b3d03', VIEWER, 'Release train for Friday: changelog owner is Priya.', 4);

const page: EntityFeedPage = { resolvedScope: 'channel_threads_v1', predicates: ['anchored', 'subject'], items: [item(root), item(local)], nextCursor: null };

createRoot(document.getElementById('root')!).render(
  <main className="cv2-root" style={{ height: '100vh' }}>
    <ChannelScreen
      anchorId={ANCHOR}
      anchorNoun="#infra"
      anchorTitle="#infra"
      threads
      viewerActorId={VIEWER.id}
      page={page}
      thread={{ root, replies: { items: [replyFromPriya], nextCursor: null } }}
      onCloseThread={() => undefined}
      onPost={(input) => { document.body.dataset.posted = JSON.stringify(input); }}
      onOpenEntity={(entity) => { document.body.dataset.opened = entity; }}
    />
  </main>,
);
