/**
 * BRIDGED MESSAGES AND DELIVERY TICKS, IN A BROWSER (BRIDGE-ENTITY-DESIGN §4.5).
 *
 * Mounts the shipping `ChatHomeScreen` over the fixture port with one chat a
 * WhatsApp bridge targets: the header chip, a guest's bubble, a linked and an
 * asserted member's, and an agent answer in each outbox state (pending, sent,
 * retrying, failed, refused: paused / rate limited / worker posting off).
 * The data is `MessageView.bridge` as 406 serves it; the server read is held
 * by `packages/server/test/db/bridge-message-badges.pg.test.ts`.
 *
 * `e2e/capture-bridge-ticks.mjs` drives it and saves the screenshots.
 */
import { createRoot } from 'react-dom/client';
import type { ActorSummary, BridgeDelivery, EntityId, MessageBridgeView } from '@tm8/contract';
import { ChatHomeScreen } from '../src/chat-home/ChatHomeScreen';
import { createChatHomeFixturePort } from '../src/chat-home/fixtures';
import type { ChatThreadDetail, ChatTurn } from '../src/chat-home/types';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';

const SPACE = '019f0000-0000-7000-8000-000000000090';
const CHAT = '019f0000-0000-7000-8000-0000000b2001' as EntityId;
const BRIDGE = '019f0000-0000-7000-8000-0000000b2b01' as EntityId;

const VIEWER: ActorSummary = { id: '019f0000-0000-7000-8000-0000000b2a01', kind: 'member', displayName: 'Subhang', avatar: null, isAgent: false };
const PRIYA: ActorSummary = { id: '019f0000-0000-7000-8000-0000000b2a02', kind: 'member', displayName: 'Priya', avatar: null, isAgent: false };
const BRIDGE_AUTHOR: ActorSummary = { id: BRIDGE, kind: 'bridge' as ActorSummary['kind'], displayName: 'Infra · WhatsApp', avatar: null, isAgent: false };
const AGENT: ActorSummary = { id: '019f0000-0000-7000-8000-0000000b2c01', kind: 'team_member', displayName: 'Infra Bot', avatar: null, isAgent: true };

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
let n = 0;
const id = () => `019f0000-0000-7000-8000-0000000b2d${(++n).toString().padStart(2, '0')}` as EntityId;

const inbound = (participant: string, trust: MessageBridgeView['trust']): MessageBridgeView => ({
  bridgeId: BRIDGE, provider: 'whatsapp', conversation: 'Infra', direction: 'in', participant, trust, delivery: null,
});
const out = (d: Omit<BridgeDelivery, 'messageId' | 'bridgeId' | 'at'> & { at?: string }): MessageBridgeView => ({
  bridgeId: BRIDGE, provider: 'whatsapp', conversation: 'Infra', direction: 'out', participant: null, trust: null,
  delivery: { messageId: 'x', bridgeId: BRIDGE, at: d.at ?? minutesAgo(1), ...d },
});

function userTurn(author: ActorSummary, body: string, bridge: MessageBridgeView, ago: number): ChatTurn {
  return { messageId: id(), role: 'user', author, createdAt: minutesAgo(ago), body, parts: [], bridge };
}
function answer(body: string, bridge: MessageBridgeView, ago: number): ChatTurn {
  return {
    messageId: id(), role: 'assistant', author: AGENT, createdAt: minutesAgo(ago), body,
    parts: [{ seq: 1, kind: 'text', text: body }], bridge,
  };
}

const thread: ChatThreadDetail = {
  summary: {
    rootId: CHAT,
    aboutId: null,
    bridgedFrom: { bridgeId: BRIDGE, provider: 'whatsapp', conversation: 'Infra', status: 'live' },
    title: 'Infra main',
    preview: 'Yes — 1.4.2 is live since 10:30.',
    updatedAt: minutesAgo(1),
    replyCount: 12,
    config: { teammateId: AGENT.id as EntityId, teammateLabel: 'Infra Bot', model: 'claude-opus-5', modelLabel: 'Opus 5', mode: 'ask' },
    state: 'idle',
  },
  turns: [
    userTurn(BRIDGE_AUTHOR, '@tm8 is the deploy done?', inbound('Rahul Mehta', 'guest'), 30),
    answer('Yes — 1.4.2 is live since 10:30. Nothing failed.', out({ status: 'sent', externalMessageId: 'BAE5A1', at: minutesAgo(29) }), 29),
    userTurn(VIEWER, '@tm8 ship the changelog too', inbound('Subhang', 'linked'), 25),
    answer('Queued the changelog post; WhatsApp is reconnecting.', out({ status: 'pending' }), 24),
    userTurn(PRIYA, '@tm8 how big is the release note?', inbound('Priya (work phone)', 'asserted'), 20),
    answer('It is 5,200 words — sending it anyway.', out({ status: 'failed_retryable', detail: 'connection closed' }), 19),
    answer('Here is the full release note: …', out({ status: 'failed_permanent', detail: 'too long', at: minutesAgo(18) }), 18),
    userTurn(BRIDGE_AUTHOR, '@tm8 status?', inbound('Asha', 'guest'), 12),
    answer('The bridge is paused, so this stays in tm8.', out({ status: 'refused', reason: 'bridge_paused' }), 11),
    answer('Seventh unprompted update in ten minutes.', out({ status: 'refused', reason: 'rate_limited', retryAfterMs: 42_000 }), 6),
    answer('A worker posting while worker posting is off.', out({ status: 'refused', reason: 'worker_posting_off' }), 2),
  ],
};

const { port } = createChatHomeFixturePort([thread]);

createRoot(document.getElementById('root')!).render(
  <main className="cv2-root" style={{ height: '100vh' }}>
    <ChatHomeScreen
      port={port}
      spaceId={SPACE as never}
      models={[{ model: 'claude-opus-5', label: 'Opus 5', provider: 'Anthropic', agentTool: 'claude-code' }]}
      viewerId={VIEWER.id}
      routeThreadId={CHAT}
      onOpenEntity={(entity) => { document.body.dataset.opened = entity; }}
    />
  </main>,
);
