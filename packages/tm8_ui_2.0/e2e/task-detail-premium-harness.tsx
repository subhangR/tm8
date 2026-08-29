import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  ActorSummary,
  EntityDetail,
  EntityFeedPage,
  EntityId,
  FeedItem,
  MessageView,
} from '@tm8/contract';
import { ChannelScreen } from '../src/channel-screen/ChannelScreen';
import type { ActionContext } from '../src/domain';
import {
  FIXTURE_SPACE_ID,
  ada,
  fixtureDetails,
  forge,
  messageAgentNullProvenance,
  messageInThread,
  sessionExited,
  sessionLive,
  sessionStale,
  taskUuidTitle,
} from '../src/fixtures';
import type { AttachmentsPort } from '../src/files';
import { EntityDetailPanel, type ControlHost, type DetailReasons, type LaunchSources } from '../src/panels';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';

/**
 * Browser-only composition fixture for the complete task surface.
 *
 * The production panel remains seam-owned. This harness composes the same
 * ports with deterministic fixture data so Playwright can measure layout,
 * focus, motion preferences and both themes without writing to a real space.
 */

const REASONS: DetailReasons = {
  presenceHollow: 'Presence is not measured yet.',
  versionHistory: 'Version history is deferred.',
  provenanceHollow: 'Session provenance is not recorded yet.',
  shareUnavailable: 'Sharing is not available in this fixture.',
  withdrawUnavailable: 'Withdrawal is not available in this fixture.',
};

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const roster: readonly ActorSummary[] = [ada, forge];

function messageView(source: typeof messageInThread, body: string): MessageView {
  return {
    ...source,
    content: {
      ...fixtureDetails[messageInThread.id]!.content,
      body,
      mentions: [],
      attachments: [],
    },
    replyCount: 0,
  } as MessageView;
}

function messageFeedItem(message: MessageView): FeedItem {
  return {
    itemId: `feed-${message.id}`,
    createdAt: message.createdAt,
    sortId: `${message.createdAt}#${message.id}`,
    via: ['anchored'],
    actor: message.state.author,
    sourceWorkSessionId: null,
    anchor: null,
    logicalOperationId: null,
    itemKind: 'message',
    message,
    delivery: [],
  };
}

const HUMAN_MESSAGE = messageView(
  messageInThread,
  'The crash is reproducible at narrow desktop widths. I added the zoom matrix to the review checklist.',
);
const AGENT_MESSAGE = messageView(
  { ...messageAgentNullProvenance, createdAt: '2026-07-28T11:59:00.000Z' },
  'The focused regression is green. The remaining criterion is a human review of the final interaction pass.',
);

const DISCUSSION_PAGE: EntityFeedPage = {
  resolvedScope: 'direct_v1',
  predicates: ['anchored'],
  items: [
    messageFeedItem(HUMAN_MESSAGE),
    {
      itemId: 'feed-activity-work-changed',
      createdAt: '2026-07-28T11:58:40.000Z',
      sortId: '2026-07-28T11:58:40.000Z#work-changed',
      via: ['caused'],
      actor: forge,
      sourceWorkSessionId: sessionLive.id,
      anchor: null,
      logicalOperationId: null,
      itemKind: 'activity',
      activity: {
        id: 'activity-work-changed',
        entityId: taskUuidTitle.id,
        actor: forge,
        verb: 'work.changed',
        summary: { status: 'in review' },
        createdAt: '2026-07-28T11:58:40.000Z',
        workSessionId: sessionLive.id,
      },
    },
    messageFeedItem(AGENT_MESSAGE),
  ],
  nextCursor: null,
};

const attachments: AttachmentsPort = {
  downloadHref: (id) => `/fixture-files/${encodeURIComponent(id)}`,
  startUpload: () => ({
    cancel: () => undefined,
    result: new Promise(() => undefined),
  }),
  detach: async () => undefined,
};

const launch: LaunchSources = {
  spaceId: FIXTURE_SPACE_ID,
  teammates: [{ id: forge.id, label: forge.displayName, agentTool: 'codex', model: 'gpt-5' }],
  projects: [],
  onSpawn: () => undefined,
  onFullOptions: () => undefined,
  mutationId: (entityId) => `browser-evidence:${entityId}`,
};

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
  const requestedWidth = Number(params.get('width') ?? 720);
  const panelWidth = Number.isFinite(requestedWidth) ? Math.max(320, Math.min(requestedWidth, 960)) : 720;
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState<'content' | 'discussion' | 'connections'>('content');

  const base = fixtureDetails[taskUuidTitle.id]!;
  const unresolvedRun = {
    ...sessionLive,
    id: 'ws-liveness-pending' as EntityId,
    title: 'orbit · containment audit',
    parentId: taskUuidTitle.id,
    state: { ...sessionLive.state, model: 'gpt-5' },
  };
  const detail: EntityDetail = {
    ...base,
    hierarchy: {
      ...base.hierarchy,
      children: {
        items: [
          { ...sessionLive, parentId: taskUuidTitle.id },
          sessionStale,
          { ...sessionExited, parentId: taskUuidTitle.id },
          unresolvedRun,
        ],
        nextCursor: null,
        total: 4,
      },
    },
  };

  const controls: ControlHost = {
    kind: detail.kind,
    ctx,
    capabilitiesOf: () => detail.capabilities,
    onSetState: () => undefined,
    onSetValue: () => undefined,
    onAssign: () => undefined,
    onArchive: () => undefined,
    assignableActors: roster,
  };

  const discussion = (
    <ChannelScreen
      anchorId={detail.id}
      anchorNoun="this task"
      anchorTitle={detail.title}
      viewerActorId={ada.id}
      page={DISCUSSION_PAGE}
      connection={{ phase: 'live' }}
      draft={draft}
      onDraftChange={setDraft}
      onPost={() => setDraft('')}
    />
  );

  return (
    <main
      className="cv2-root"
      data-astryx-theme="neutral"
      data-theme={theme === 'dark' ? 'dark' : undefined}
      data-testid="task-detail-harness"
      style={{ minHeight: '100%', padding: 16 }}
    >
      <section
        data-testid="harness-panel"
        style={{ inlineSize: panelWidth, maxInlineSize: '100%', blockSize: 820, marginInline: 'auto' }}
      >
        <EntityDetailPanel
          detail={detail}
          reasons={REASONS}
          ctx={ctx}
          activeTab={tab}
          onTabChange={setTab}
          controls={controls}
          attachments={attachments}
          launch={launch}
          onAction={() => undefined}
          wiredActions={['edit']}
          livenessOf={(id) => {
            if (id === sessionLive.id) return 'live';
            if (id === sessionStale.id) return 'stale';
            if (id === sessionExited.id) return 'not-running';
            return 'unknown';
          }}
          discussionSurface={discussion}
          onOpenEntity={() => undefined}
        />
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
