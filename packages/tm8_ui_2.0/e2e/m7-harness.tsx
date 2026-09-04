import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CollabError,
  type CommandResult,
  type DurableWorkspaceEvent,
  type EntityFeedPage,
  type FeedItem,
  type MessageBatchResult,
  type MessageView,
  type PostMessageInput,
  type WorkSessionInteractionProfileProjection,
} from '@tm8/contract';
import { createFixtureSeam } from '../src/data/fixtures/seam-fixture';
import type { ConnectionState, FixtureSeam } from '../src/data/seam';
import { FIXTURE_SPACE_ID, ada, docLayoutSpec, forge, sessionLive } from '../src/fixtures';
import { ChannelScreen } from '../src/channel-screen/ChannelScreen';
import { SessionChatSurface, type SessionChatSeam } from '../src/channel-screen/SessionChatSurface';
import { WorkSessionContent } from '../src/panels/bodies/WorkSessionContent';
import { LiveTerminal } from '../src/terminal/LiveTerminal';
import '../src/styles/tokens.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/panels/panels.css';
import '../src/terminal/terminal.css';

const PROFILE: WorkSessionInteractionProfileProjection = {
  pinRevision: 1,
  templateKey: 'chat.agent.canonical',
  templateVersion: 1,
  compatibility: 'supported',
  chatEnabled: true,
  initialContentSurface: 'chat',
  feedPolicy: {
    scope: 'session_chat_v1',
    pageSize: 50,
    bodyExcerptBytes: 1_024,
  },
  composerPolicy: {
    schemaRef: 'tm8.composer.v1',
    supportsReply: true,
    supportsAttachments: true,
    allowedAttachmentKinds: ['file'],
    operationBindings: [
      'messages.post',
      'files.uploadInit',
      'files.uploadComplete',
      'files.uploadAbort',
      'messages.attachments.add',
      'messages.attachments.remove',
    ],
  },
};

function ProfilesScenario() {
  const explicitSessionId = 'm7-explicit-session';
  localStorage.setItem(
    `tm8:work-session-surface:v1:m7-viewer:${explicitSessionId}`,
    'chat',
  );
  const unknown = {
    ...PROFILE,
    templateKey: 'chat.future.unknown',
    templateVersion: 99,
    compatibility: 'unknown_template' as const,
  };

  return (
    <main className="cv2-root">
      <section data-testid="profile-none">
        <WorkSessionContent
          sessionId="m7-no-profile-session"
          viewerMemberId="m7-viewer"
          profile={null}
          terminal={<p>native terminal</p>}
          chat={<p>provider-neutral Chat</p>}
        />
      </section>
      <section data-testid="profile-explicit">
        <WorkSessionContent
          sessionId={explicitSessionId}
          viewerMemberId="m7-viewer"
          profile={PROFILE}
          requestedSurface="terminal"
          terminal={<p>explicit native terminal</p>}
          chat={<p>explicit provider-neutral Chat</p>}
        />
      </section>
      <section data-testid="profile-default">
        <WorkSessionContent
          sessionId="m7-profile-default-session"
          viewerMemberId="m7-viewer"
          profile={PROFILE}
          terminal={<p>profile-default terminal</p>}
          chat={<p>profile-default Chat</p>}
        />
      </section>
      <section data-testid="profile-saved">
        <SavedPreferenceSurface />
      </section>
      <section data-testid="profile-unknown">
        <WorkSessionContent
          sessionId="m7-unknown-session"
          viewerMemberId="m7-viewer"
          profile={unknown}
          terminal={<p>unknown-template terminal</p>}
          chat={<p>core-safe Chat</p>}
        />
      </section>
    </main>
  );
}

function SavedPreferenceSurface() {
  const sessionId = 'm7-saved-session';
  localStorage.setItem(`tm8:work-session-surface:v1:m7-viewer:${sessionId}`, 'terminal');
  return (
    <WorkSessionContent
      sessionId={sessionId}
      viewerMemberId="m7-viewer"
      profile={PROFILE}
      terminal={<p>saved terminal</p>}
      chat={<p>saved Chat</p>}
    />
  );
}

const STORED_FIRST_BODY = 'Stored-first browser message';
const AGENT_REPLY_BODY = 'Persona reply through tm8 message reply';
const INVALID_CURSOR = 'm7-invalid-cursor';

interface M7SurfaceSeam extends SessionChatSeam {
  base: FixtureSeam;
  releaseStoredMessage(): void;
  postAgentReply(): Promise<void>;
}

function withAgentPersona(message: MessageView): MessageView {
  if (message.content.body !== AGENT_REPLY_BODY) return message;
  return {
    ...message,
    createdBy: forge,
    state: { ...message.state, author: forge },
  };
}

function decorateEvent(event: DurableWorkspaceEvent): DurableWorkspaceEvent {
  if (event.type !== 'message.created' && event.type !== 'message.updated') return event;
  return { ...event, message: withAgentPersona(event.message) };
}

function deliveryFacets(): Extract<FeedItem, { itemKind: 'message' }>['delivery'] {
  const statuses = [
    'pending',
    'dispatching',
    'delivered',
    'failed_retryable',
    'failed_permanent',
    'unknown',
    'expired',
    'cancelled',
  ] as const;
  return statuses.map((status, index) => ({
    deliveryId: `m7-delivery-${status}`,
    targetWorkSessionId: `m7-target-${index + 1}`,
    status,
    attemptNo: 1,
    failureReason: status === 'failed_retryable' ? 'session_not_live' : null,
    updatedAt: '2026-07-30T10:00:00.000Z',
  }));
}

async function createSurfaceSeam(): Promise<M7SurfaceSeam> {
  const base = createFixtureSeam();
  await base.openSpace(FIXTURE_SPACE_ID);
  for (let index = 1; index <= 18; index += 1) {
    await base.commands.postMessage({
      clientMutationId: `m7-seed-${index}`,
      anchorIds: [sessionLive.id],
      body: `Deterministic history ${String(index).padStart(2, '0')}`,
      parentMessageId: null,
    });
  }

  let releasePost: (() => void) | null = null;
  let lastStoredMessageId: string | null = null;
  let invalidCursorObserved = false;

  const commands: M7SurfaceSeam['commands'] = {
    postMessage(input: PostMessageInput): Promise<CommandResult | MessageBatchResult> {
      if (!input.body.startsWith(STORED_FIRST_BODY)) return base.commands.postMessage(input);
      return new Promise((resolve, reject) => {
        releasePost = () => {
          releasePost = null;
          void base.commands.postMessage(input).then((result) => {
            if ('messages' in result) lastStoredMessageId = result.messages[0]?.id ?? null;
            else if (result.entity?.kind === 'message') lastStoredMessageId = result.entity.id;
            resolve(result);
          }, reject);
        };
      });
    },
  };

  return {
    base,
    commands,
    query: base.query,
    files: base.files,
    async feed(id, opts): Promise<EntityFeedPage> {
      if (opts?.cursor === INVALID_CURSOR) {
        invalidCursorObserved = true;
        throw new CollabError('invalid_cursor', 'The deterministic history cursor expired.');
      }
      const page = await base.feed(id, opts);
      const items = page.items.map((item): FeedItem => {
        if (item.itemKind !== 'message') return item;
        const message = withAgentPersona(item.message);
        return {
          ...item,
          actor: message.state.author,
          sourceWorkSessionId: message.content.body === AGENT_REPLY_BODY ? sessionLive.id : null,
          message,
          delivery: message.content.body.startsWith(STORED_FIRST_BODY)
            ? deliveryFacets()
            : item.delivery,
        };
      });
      return {
        ...page,
        items,
        nextCursor: invalidCursorObserved ? null : INVALID_CURSOR,
      };
    },
    onEvent(callback) {
      return base.onEvent((event) => callback(decorateEvent(event)));
    },
    onConnection: base.onConnection,
    onResync: base.onResync,
    releaseStoredMessage() {
      releasePost?.();
    },
    async postAgentReply() {
      await base.commands.postMessage({
        clientMutationId: 'm7-agent-reply',
        anchorIds: [sessionLive.id],
        body: AGENT_REPLY_BODY,
        parentMessageId: lastStoredMessageId,
      });
    },
  };
}

let terminalInstanceSequence = 0;

function RetainedTerminal() {
  const instance = useMemo(() => ++terminalInstanceSequence, []);
  return (
    <div data-testid="terminal-instance" data-instance={instance} style={{ minHeight: 300 }}>
      <LiveTerminal sessionId={sessionLive.id} live />
    </div>
  );
}

function SurfaceScenario({ seam }: { seam: M7SurfaceSeam }) {
  const [surface, setSurface] = useState<'terminal' | 'chat'>('terminal');
  const [connection, setConnection] = useState<ConnectionState>(seam.base.getConnection());
  const [exited, setExited] = useState(false);

  useEffect(() => seam.base.onConnection(setConnection), [seam]);

  return (
    <main className="cv2-root" style={{ height: 760, padding: 12 }}>
      <div className="m7-controls" aria-label="Deterministic server controls">
        <button type="button" onClick={() => seam.releaseStoredMessage()}>Commit stored message</button>
        <button type="button" onClick={() => void seam.postAgentReply()}>Agent reply through tm8</button>
        <button
          type="button"
          onClick={() => seam.base.fixtureControls.setConnection({
            phase: 'polling',
            disconnectedSince: '2026-07-30T10:00:00.000Z',
          })}
        >Disconnect events</button>
        <button type="button" onClick={() => seam.base.fixtureControls.setConnection({ phase: 'live' })}>
          Reconnect events
        </button>
        <button type="button" onClick={() => seam.base.fixtureControls.triggerResync(FIXTURE_SPACE_ID)}>
          Force snapshot recovery
        </button>
        <button type="button" onClick={() => setExited(true)}>Mark session exited</button>
      </div>
      <div style={{ height: 700, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <WorkSessionContent
          sessionId={sessionLive.id}
          viewerMemberId="m7-viewer"
          profile={PROFILE}
          requestedSurface={surface}
          onSurfaceChange={setSurface}
          terminal={<RetainedTerminal />}
          chat={(
            <SessionChatSurface
              seam={seam}
              sessionId={sessionLive.id}
              spaceId={FIXTURE_SPACE_ID}
              viewerMemberId="m7-viewer"
              connection={connection}
              sessionExited={exited}
              defaultLimit={PROFILE.feedPolicy.pageSize}
              composerPolicy={PROFILE.composerPolicy}
              onOpenEntity={() => undefined}
              onSwitchToTerminal={() => setSurface('terminal')}
            />
          )}
        />
      </div>
    </main>
  );
}

function presentationMessage({
  id,
  body,
  createdAt,
  rootMessageId = null,
  editedAt = null,
  redactedAt = null,
  mentions = [],
  attachments = [],
}: {
  id: string;
  body: string;
  createdAt: string;
  rootMessageId?: string | null;
  editedAt?: string | null;
  redactedAt?: string | null;
  mentions?: MessageView['content']['mentions'];
  attachments?: MessageView['content']['attachments'];
}): MessageView {
  return {
    id,
    kind: 'message',
    title: body.slice(0, 80),
    spaceId: FIXTURE_SPACE_ID,
    parentId: sessionLive.id,
    position: 0,
    visibility: 'space',
    version: 1,
    activityAt: createdAt,
    createdAt,
    updatedAt: editedAt ?? createdAt,
    deletedAt: null,
    createdBy: ada,
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    badges: {},
    state: {
      kind: 'message',
      anchorId: sessionLive.id,
      rootMessageId,
      author: ada,
      messageBatchId: null,
      editedAt,
      redactedAt,
    },
    content: { kind: 'message', body, mentions, attachments },
    replyCount: 0,
  };
}

function presentationMessageItem(message: MessageView): FeedItem {
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

function PresentationScenario() {
  const [opened, setOpened] = useState('');
  const parent = presentationMessage({
    id: 'm7-parent-message',
    body: 'Parent message for focus',
    createdAt: '2026-07-30T10:00:00.000Z',
  });
  const reply = presentationMessage({
    id: 'm7-rich-reply',
    body: 'Reply with canonical references',
    createdAt: '2026-07-30T10:01:00.000Z',
    rootMessageId: parent.id,
    editedAt: '2026-07-30T10:02:00.000Z',
    mentions: [{ entityId: forge.id, kind: 'team_member', display: forge.displayName }],
    attachments: [{ fileEntityId: 'm7-file', name: 'browser-proof.txt', mime: 'text/plain' }],
  });
  const redacted = presentationMessage({
    id: 'm7-redacted-message',
    body: 'M7_SECRET_BODY_MUST_NOT_RENDER',
    createdAt: '2026-07-30T10:03:00.000Z',
    redactedAt: '2026-07-30T10:04:00.000Z',
    mentions: [{ entityId: forge.id, kind: 'team_member', display: 'M7_SECRET_MENTION' }],
    attachments: [{ fileEntityId: 'm7-secret-file', name: 'M7_SECRET_FILE.txt', mime: 'text/plain' }],
  });
  const artifact: FeedItem = {
    itemId: 'm7-artifact-activity',
    createdAt: '2026-07-30T10:05:00.000Z',
    sortId: '2026-07-30T10:05:00.000Z#m7-artifact-activity',
    via: ['caused'],
    actor: forge,
    sourceWorkSessionId: sessionLive.id,
    anchor: docLayoutSpec,
    logicalOperationId: null,
    itemKind: 'activity',
    activity: {
      id: 'm7-artifact-activity',
      entityId: docLayoutSpec.id,
      actor: forge,
      verb: 'created',
      summary: { kind: 'doc' },
      createdAt: '2026-07-30T10:05:00.000Z',
      refId: docLayoutSpec.id,
      workSessionId: sessionLive.id,
    },
  };
  const page: EntityFeedPage = {
    resolvedScope: 'session_chat_v1',
    predicates: ['anchored'],
    items: [
      presentationMessageItem(parent),
      presentationMessageItem(reply),
      presentationMessageItem(redacted),
      artifact,
    ],
    nextCursor: null,
  };

  return (
    <main className="cv2-root" style={{ height: 720 }}>
      <ChannelScreen
        anchorId={sessionLive.id}
        anchorNoun="this session"
        page={page}
        connection={{ phase: 'live' }}
        onOpenEntity={setOpened}
      />
      <output data-testid="m7-opened-entity">{opened}</output>
    </main>
  );
}

function Harness({ surfaceSeam }: { surfaceSeam: M7SurfaceSeam }) {
  const scenario = new URLSearchParams(location.search).get('scenario');
  if (scenario === 'profiles') return <ProfilesScenario />;
  if (scenario === 'surface') return <SurfaceScenario seam={surfaceSeam} />;
  if (scenario === 'presentation') return <PresentationScenario />;
  return <p role="alert">Unknown M7 scenario.</p>;
}

const surfaceSeam = await createSurfaceSeam();
createRoot(document.getElementById('root')!).render(<Harness surfaceSeam={surfaceSeam} />);
