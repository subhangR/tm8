import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ChannelTab,
  CollectionResult,
  EntityDetail,
  EntityId,
  EntitySummary,
} from '@tm8/contract';
import { LazyChannelScreen } from '../channel-screen/LazyChannelScreen';
import { useChannelFeed } from '../channel-screen/useChannelFeed';
import { channelFeedPortFromGateData } from './channel-feed-port';
import { getKind } from '../domain';
import { screenKeyOf, useScreenStack } from '../stores/screenStackStore';
import { EntityDetailPanel, type DetailReasons } from '../panels';
import type { GateData } from './useGateData';
import './channel-view.css';
import { debugSurfaceFor } from './debugSurface';

const FEED_KEY = 'feed';

export interface ChannelViewProps {
  data: GateData & { pull?: (id: string) => void };
  channelId: EntityId;
  serverBaseUrl?: string;
  reasons: DetailReasons;
}

type DetailMode = 'aside' | 'full';

/**
 * The Collab v2 channel destination in the new UI: channel header, pinned
 * shelf, projected tabs, the real entities.feed surface, and its composer.
 */
export function ChannelView({ data, channelId, serverBaseUrl, reasons }: ChannelViewProps) {
  const [activeTab, setActiveTab] = useState(FEED_KEY);
  /* ONE feed implementation, shared with the panel-hosted ChannelChatSurface
     (channel-screen/useChannelFeed). This view used to own it inline; the
     2026-08-01 ruling gave channels a second host, and two copies of the @tag
     dispatch — which can SPAWN a teammate — is not a thing to keep. */
  const feedPort = useMemo(() => channelFeedPortFromGateData(data), [data]);
  const feed = useChannelFeed(feedPort, channelId);
  /*
   * Per-CHANNEL stack (user ruling 2026-07-31): each channel keeps its own
   * history, not one shared "channels" stack. Held outside the component
   * because switching rail items unmounts this view — see screenStackStore.
   */
  const screen = useScreenStack(screenKeyOf.channel(channelId));
  const selectedId = screen.selected;
  const setSelectedId = useCallback(
    (id: EntityId | null) => {
      if (id === null) screen.clear();
      else screen.open(id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channelId],
  );
  const [detailMode, setDetailMode] = useState<DetailMode>('aside');

  const detail = data.detailOf(channelId);
  const content = channelContent(detail);
  const tabs = useMemo(
    () => content.autoTabs.filter((tab) => tab.key !== FEED_KEY),
    [content.autoTabs],
  );

  useEffect(() => {
    setActiveTab(FEED_KEY);
    /* NOT `setSelectedId(null)`: the stack is keyed per channel, so entering a
       channel must RESTORE its selection rather than wipe it. Clearing here
       would empty the very stack this effect's channel just brought back. */
    setDetailMode('aside');
    data.pull?.(channelId);
    // The feed itself reloads inside useChannelFeed, keyed on channelId.
  }, [channelId]);

  useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      if (detailMode === 'full') setDetailMode('aside');
      // One rung down is the entity this one was opened FROM; with nothing
      // beneath it, popping closes the detail exactly as before.
      else screen.pop();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, detailMode, channelId]);

  const selectedDetail = selectedId ? data.detailOf(selectedId) : undefined;
  const selectedMessages = selectedId ? data.messagesOf(selectedId) : undefined;
  if (selectedId && (
    !selectedDetail
    || selectedMessages === undefined
    || selectedMessages.length < selectedDetail.counters.messages
  )) data.pull?.(selectedId);

  const entityPanel = selectedId ? (
    <EntityDetailPanel
      detail={selectedDetail ?? null}
      serverBaseUrl={serverBaseUrl}
      loading={!selectedDetail}
      host="stack"
      reasons={reasons}
      ctx={{ spaceId: data.spaceId, entityId: selectedId }}
      pinned={false}
      pinRefusal="Pinning lives in the Workspace — this channel keeps the entity beside its feed already"
      liveness={data.livenessOf(selectedId)}
      debugSurface={debugSurfaceFor(data.seam, selectedId, data.livenessOf)}
      livenessOf={data.livenessOf}
      messages={selectedMessages}
      connections={data.connectionsOf(selectedId)}
      onPostMessage={(body) => data.postMessage({
        clientMutationId: `entity-post:${selectedId}:${Date.now()}`,
        anchorIds: [selectedId],
        body,
      })}
      commands={data.seam.commands}
      onSaved={data.reconcileCommand}
      streaming={data.activity[selectedId] ?? false}
      onOpenEntity={(id) => setSelectedId(id as EntityId)}
      onPromote={() => setDetailMode((mode) => mode === 'aside' ? 'full' : 'aside')}
      onClose={() => {
        setSelectedId(null);
        setDetailMode('aside');
      }}
    />
  ) : null;

  if (selectedId && detailMode === 'full') {
    return (
      <div className="chv-root chv-root--full" data-testid="channel-view" data-channel={channelId}>
        <div className="chv-full__head">
          <button type="button" className="chv-collapse" onClick={() => setDetailMode('aside')}>
            ⇲ collapse
          </button>
          <span>channel · entity full view</span>
          <span className="chv-spacer" />
          <span>esc</span>
        </div>
        <div className="chv-full__body">{entityPanel}</div>
      </div>
    );
  }

  return (
    <div className="chv-root" data-testid="channel-view" data-channel={channelId} data-mode={selectedId ? 'aside' : 'feed'}>
      <div className="chv-split">
        <section className="chv-main" aria-label={detail ? `${detail.title} channel` : 'Channel'}>
          <ChannelHeader detail={detail} />

          {content.pinned.length > 0 ? (
            <section className="chv-shelf" aria-label="Pinned entities">
              <span className="chv-eyebrow">{`PINNED · ${content.pinned.length}`}</span>
              <div className="chv-shelf__items">
                {content.pinned.map((item) => (
                  <button key={item.id} type="button" className="chv-chip" onClick={() => setSelectedId(item.id)}>
                    <span aria-hidden>{getKind(item.kind).chip.glyph}</span>
                    {item.title}
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <div className="chv-tabs" role="tablist" aria-label="Channel tabs">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === FEED_KEY}
              className={activeTab === FEED_KEY ? 'chv-tab chv-tab--active' : 'chv-tab'}
              onClick={() => setActiveTab(FEED_KEY)}
            >
              {`Feed · ${detail?.counters.messages ?? 0}`}
            </button>
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.key}
                className={activeTab === tab.key ? 'chv-tab chv-tab--active' : 'chv-tab'}
                onClick={() => setActiveTab(tab.key)}
              >
                {`${tab.label} · ${tab.count}`}
              </button>
            ))}
          </div>

          <div className="chv-pane">
            {activeTab === FEED_KEY ? (
              feed.error ? (
                <div className="chv-error" role="alert">
                  <strong>The channel feed could not be read.</strong>
                  <span>{feed.error}</span>
                  <button type="button" onClick={() => void feed.reload()}>Retry feed</button>
                </div>
              ) : (
          <LazyChannelScreen
                  anchorId={channelId}
                  anchorNoun="this channel"
                  page={feed.page}
                  loading={feed.loading}
                  loadingEarlier={feed.loadingEarlier}
                  refusal={feed.refusal}
                  connection={data.connection}
                  onPost={feed.post}
                  mentionOptions={feed.mentionOptions}
                  attachEntityOptions={feed.attachEntityOptions}
                  onStartAttachmentUpload={feed.startAttachmentUpload}
                  onLoadEarlier={feed.loadEarlier}
                  onOpenEntity={(id) => setSelectedId(id)}
                />
              )
            ) : (
              <ChannelCollectionPane
                key={`${channelId}:${activeTab}`}
                seam={data.seam}
                tab={tabs.find((tab) => tab.key === activeTab) ?? null}
                onOpen={(id) => setSelectedId(id)}
              />
            )}
          </div>
        </section>

        {selectedId ? (
          <aside className="chv-aside" aria-label="Entity details">{entityPanel}</aside>
        ) : null}
      </div>
    </div>
  );
}

function ChannelHeader({ detail }: { detail?: EntityDetail }) {
  const content = channelContent(detail);
  const state = (detail?.state ?? {}) as { unreadCount?: number; workingAgentCount?: number };
  return (
    <header className="chv-header">
      <span className="chv-header__hash" aria-hidden>#</span>
      <div className="chv-header__copy">
        <h1>{detail?.title ?? 'Loading channel…'}</h1>
        {content.topic ? <p>{content.topic}</p> : null}
      </div>
      <div className="chv-header__status">
        {(state.workingAgentCount ?? 0) > 0 ? <span>{`● ${state.workingAgentCount} working`}</span> : null}
        {(state.unreadCount ?? 0) > 0 ? <span>{`${state.unreadCount} unread`}</span> : null}
      </div>
    </header>
  );
}

function ChannelCollectionPane({
  seam,
  tab,
  onOpen,
}: {
  seam: GateData['seam'];
  tab: ChannelTab | null;
  onOpen(id: EntityId): void;
}) {
  const [result, setResult] = useState<CollectionResult>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(undefined);
    setError(null);
    if (!tab) return () => { cancelled = true; };
    void seam.query(tab.query)
      .then((next) => { if (!cancelled) setResult(next); })
      .catch((reason: unknown) => { if (!cancelled) setError(errorMessage(reason, 'This channel tab could not be read.')); });
    return () => { cancelled = true; };
  }, [seam, tab]);

  if (!tab) return <p className="chv-collection__state">That channel tab is no longer available.</p>;
  if (error) return <p className="chv-collection__state" role="alert">{error}</p>;
  if (!result) return <p className="chv-collection__state">{`Loading ${tab.label.toLowerCase()}…`}</p>;
  if (result.page.items.length === 0) return <p className="chv-collection__state">{`No ${tab.label.toLowerCase()} attached yet.`}</p>;

  return (
    <ul className="chv-collection" aria-label={tab.label}>
      {result.page.items.map((item) => (
        <li key={item.id}>
          <button type="button" onClick={() => onOpen(item.id)}>
            <span className="chv-collection__glyph" aria-hidden>{getKind(item.kind).chip.glyph}</span>
            <span className="chv-collection__title">{item.title}</span>
            <span className="chv-collection__kind">{getKind(item.kind).label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function channelContent(detail?: EntityDetail): {
  topic: string;
  pinned: EntitySummary[];
  autoTabs: ChannelTab[];
} {
  const content = (detail?.content ?? {}) as {
    topic?: unknown;
    pinned?: unknown;
    autoTabs?: unknown;
  };
  return {
    topic: typeof content.topic === 'string' ? content.topic : '',
    pinned: Array.isArray(content.pinned) ? content.pinned as EntitySummary[] : [],
    autoTabs: Array.isArray(content.autoTabs) ? content.autoTabs as ChannelTab[] : [],
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
