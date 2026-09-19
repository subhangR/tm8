/**
 * THE CHAT SURFACE'S MEASURE RAIL, IN THE HOST THAT REPORTED IT.
 *
 * Subhang's defect is a WIDTH defect, and jsdom cannot see one: the suite that
 * pins `.chs-*` geometry reads the stylesheet as text and never lays anything
 * out. So this mounts the real `ChannelScreen` inside the real host chain the
 * entity detail panel gives it — `.cv2-root` → `.pn-panel` → `.pn-hub-feed`
 * (channels, the hub archetype) or `.pn-conversation-body` (chats) — and
 * `e2e/capture-chat-rail.mjs` reads the boxes back out of a browser.
 *
 * `?rows=` exists for the composer/feed band question: the reported overlap
 * only has a chance to appear once the feed OVERFLOWS its scroller, which the
 * four-item presentation fixture never does.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EntityFeedPage, FeedItem, MessageView } from '@tm8/contract';
import { FIXTURE_SPACE_ID, ada, sessionLive } from '../src/fixtures';
import { ChannelScreen } from '../src/channel-screen/ChannelScreen';
import '../src/styles/tokens.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/panels/panels.css';
import '../src/panels/bodies/hub-body.css';
/* TurnParts' own styles ship with Chat Home's sheet, which only ChatHomeScreen
   imports; the app bundle always has it, this harness must ask. */
import '../src/chat-home/chat-home.css';

function railMessage(index: number, body: string, asTurn = false): MessageView {
  const createdAt = new Date(Date.UTC(2026, 6, 30, 10, index)).toISOString();
  /* An agent turn, because the reported screenshot's covered line was the
     trailing `USAGE | … tokens` card — which only exists on a message that
     carries parts (`FeedRow` branches on `parts.length`). A plain body cannot
     reproduce what Subhang photographed. */
  const parts: MessageView['parts'] = asTurn
    ? [
        { seq: 1, createdAt, kind: 'text', payload: { text: body } },
        {
          seq: 2,
          createdAt,
          kind: 'usage',
          payload: { input_tokens: 18_412, output_tokens: 963, total_cost_usd: 0.114 },
        },
        { seq: 3, createdAt, kind: 'done', payload: { reason: 'success' } },
      ]
    : undefined;
  return {
    ...(parts ? { parts } : {}),
    id: `rail-message-${index}`,
    kind: 'message',
    title: body.slice(0, 80),
    spaceId: FIXTURE_SPACE_ID,
    parentId: sessionLive.id,
    position: 0,
    visibility: 'space',
    version: 1,
    activityAt: createdAt,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    createdBy: ada,
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    badges: {},
    state: {
      kind: 'message',
      anchorId: sessionLive.id,
      rootMessageId: null,
      author: ada,
      messageBatchId: null,
      editedAt: null,
      redactedAt: null,
    },
    content: { kind: 'message', body, mentions: [], attachments: [] },
    replyCount: 0,
  };
}

function railItem(message: MessageView): FeedItem {
  return {
    itemId: `feed-${message.id}`,
    createdAt: message.createdAt,
    sortId: `${message.createdAt}#${message.id}`,
    via: ['anchored'],
    actor: message.state.author,
    sourceWorkSessionId: null,
    anchor: sessionLive,
    logicalOperationId: null,
    itemKind: 'message',
    message,
    delivery: [],
  };
}

/* Long enough to wrap at 1100px, so the rail reads as a rail rather than as a
   short line that happens to fit inside it. */
const PROSE =
  'The readable measure and the composer have to sit on one rail: a cap with no centring is exactly what pins the transcript to the left edge and grows a gutter on the right as the panel widens.';

function RailScenario() {
  const params = new URLSearchParams(location.search);
  const rows = Math.max(1, Number(params.get('rows') ?? '3'));
  const host = params.get('host') === 'conversation' ? 'conversation' : 'hub';
  const [opened, setOpened] = useState('');
  const page: EntityFeedPage = {
    resolvedScope: 'session_chat_v1',
    predicates: ['anchored'],
    /* Every third row is an agent turn, so the trailing USAGE card lands both
       mid-transcript and — the case that was reported — as the LAST row. */
    items: Array.from({ length: rows }, (_, i) =>
      railItem(railMessage(i, `${i + 1}. ${PROSE}`, (i + 1) % 3 === 0)),
    ),
    nextCursor: null,
  };

  const screen = (
    <ChannelScreen
      anchorId={sessionLive.id}
      anchorNoun="this channel"
      page={page}
      connection={{ phase: 'live' }}
      onOpenEntity={setOpened}
    />
  );

  /* The panel's own chain, class for class. The hub arm keeps the front-door
     sibling (`.hub-body--with-feed`, capped at 38%) because that cap is what
     decides how much height the feed slot actually gets — drop it and the
     composer band question is answered against the wrong box. */
  return (
    <main className="cv2-root" style={{ height: '100vh', display: 'flex', padding: 12 }}>
      <section className="pn-panel" style={{ flex: 1, minWidth: 0 }}>
        {host === 'hub' ? (
          <>
            <div className="pn-body hub-body hub-body--with-feed">
              <p>Front door: the hub's regions sit above the feed and keep their own ceiling.</p>
            </div>
            <div className="pn-hub-feed">{screen}</div>
          </>
        ) : (
          <div className="pn-conversation-body">{screen}</div>
        )}
      </section>
      <output data-testid="rail-opened-entity">{opened}</output>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<RailScenario />);
