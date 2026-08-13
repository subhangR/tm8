import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import { Avatar, Timestamp } from '../kit';
import { mergeChatTurnFrame } from './turn-model';
import type { ChatEntityResolver } from './EntityChip';
import { TurnParts } from './TurnParts';
import type {
  ChatHomePort,
  ChatModelOption,
  ChatTeammateOption,
  ChatThreadDetail,
  ChatThreadSummary,
  ChatTurnFrame,
} from './types';
import './chat-home.css';

export interface ChatHomeScreenProps {
  port: ChatHomePort;
  spaceId: SpaceId | string;
  /** Bare Home defaults to the space entity. A contextual host passes its entity instead. */
  anchorId?: EntityId;
  models: readonly ChatModelOption[];
  spaceLabel?: string;
  newMutationId?: (prefix: string) => string;
  /** Opens the entity detail panel for an entity a tool call referenced. */
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  /** Lazily resolves title/kind for bare entity ids in tool payloads. */
  resolveEntity?: ChatEntityResolver | undefined;
}

type ComposerPhase =
  | 'idle'
  | 'posting-root'
  | 'configuring'
  | 'posting-turn'
  | 'streaming'
  | 'stopped-continuable';

export function ChatHomeScreen({
  port,
  spaceId,
  anchorId = spaceId as EntityId,
  models,
  spaceLabel,
  newMutationId = defaultMutationId,
  onOpenEntity,
  resolveEntity,
}: ChatHomeScreenProps) {
  const [threads, setThreads] = useState<readonly ChatThreadSummary[]>([]);
  const [teammates, setTeammates] = useState<readonly ChatTeammateOption[]>([]);
  const [selectedRootId, setSelectedRootId] = useState<EntityId | null>(null);
  const [detail, setDetail] = useState<ChatThreadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [phase, setPhase] = useState<ComposerPhase>('idle');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [teammateId, setTeammateId] = useState<EntityId | ''>('');
  const [modelId, setModelId] = useState(models[0]?.model ?? '');
  const activeRootRef = useRef<EntityId | null>(null);
  const stoppedRootRef = useRef<EntityId | null>(null);
  const detailRef = useRef<ChatThreadDetail | null>(null);
  /** Rolling cache of the active thread's recent frames, replayed over every
   *  snapshot read. A snapshot races the stream two ways — frames landing while
   *  the read is in flight, and a refresh whose snapshot predates frames already
   *  merged on screen — and replay heals both because the merge is idempotent
   *  (per-message seq dedupe). Reset on thread switch; bounded as a leak guard. */
  const recentFramesRef = useRef<ChatTurnFrame[]>([]);
  const refreshingDetailRef = useRef(false);

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  const refreshThreads = useCallback(async (preferRoot?: EntityId) => {
    const next = await port.listThreads(spaceId);
    setThreads(next);
    setSelectedRootId((current) => preferRoot ?? current ?? next[0]?.rootId ?? null);
  }, [port, spaceId]);

  /** Read a thread snapshot and replay every frame that streamed in while the
   *  read was in flight. `streamed` reports what the replay concluded about the
   *  live turn (null when nothing streamed), so callers set an honest phase
   *  instead of assuming the agent is still working. */
  const loadDetail = useCallback(
    async (
      rootId: EntityId,
      /** Frames before this index still replay into the detail, but only newer
       *  ones speak for the live phase — an old turn's `done` must not settle a
       *  turn posted after it. Callers pass the cache length from before their
       *  write; the default considers every cached frame. */
      sinceIndex = 0,
    ): Promise<{ detail: ChatThreadDetail; streamed: 'streaming' | 'idle' | null }> => {
      let next = await port.readThread(rootId);
      let streamed: 'streaming' | 'idle' | null = null;
      for (const [index, frame] of recentFramesRef.current.entries()) {
        if (frame.threadRootId !== rootId) continue;
        next = mergeChatTurnFrame(next, frame);
        if (index >= sinceIndex) streamed = frame.type === 'chat.turn.done' ? 'idle' : 'streaming';
      }
      return { detail: next, streamed };
    },
    [port],
  );

  /** Single-flight re-read of the active thread — used when a frame references
   *  a message we do not have yet (another participant posted). */
  const refreshDetail = useCallback(
    (rootId: EntityId) => {
      if (refreshingDetailRef.current) return;
      refreshingDetailRef.current = true;
      void loadDetail(rootId)
        .then(({ detail: next }) => {
          if (activeRootRef.current === rootId) setDetail(next);
        })
        .catch(() => {
          // The next frame or thread switch retries; a missed refresh only
          // delays another participant's message, it never corrupts state.
        })
        .finally(() => {
          refreshingDetailRef.current = false;
        });
    },
    [loadDetail],
  );

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    void Promise.all([port.listThreads(spaceId), port.listTeammates(spaceId)])
      .then(([nextThreads, nextTeammates]) => {
        if (!alive) return;
        setThreads(nextThreads);
        setTeammates(nextTeammates);
        setSelectedRootId(nextThreads[0]?.rootId ?? null);
        setTeammateId(nextTeammates[0]?.id ?? '');
      })
      .catch((error: unknown) => {
        if (alive) setLoadError(describeError(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [port, spaceId]);

  useEffect(() => {
    activeRootRef.current = selectedRootId;
    recentFramesRef.current = [];
    if (!selectedRootId) {
      setDetail(null);
      return;
    }
    let alive = true;
    setLoadError(null);
    setDetailLoading(true);
    void loadDetail(selectedRootId)
      .then(({ detail: next, streamed }) => {
        if (!alive) return;
        setDetail(next);
        stoppedRootRef.current =
          next.summary.state === 'stopped-continuable' ? selectedRootId : null;
        setPhase(streamed ?? phaseForThreadState(next.summary.state));
      })
      .catch((error: unknown) => {
        if (alive) setLoadError(describeError(error));
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [loadDetail, selectedRootId]);

  useEffect(
    () =>
      port.subscribe((frame) => {
        if (frame.threadRootId === activeRootRef.current) {
          recentFramesRef.current.push(frame);
          if (recentFramesRef.current.length > 500) {
            recentFramesRef.current = recentFramesRef.current.slice(-250);
          }
        }
        // Any thread's activity keeps the sidebar honest, active or not.
        setThreads((current) =>
          current.map((thread) =>
            thread.rootId === frame.threadRootId
              ? { ...thread, state: frame.type === 'chat.turn.done' ? 'idle' : 'streaming' }
              : thread,
          ),
        );
        if (frame.threadRootId !== activeRootRef.current) return;
        // A delta for a message we have never seen means another participant
        // started this turn — pull their message in alongside the stream.
        if (
          frame.type === 'chat.turn.delta' &&
          detailRef.current &&
          !detailRef.current.turns.some((turn) => turn.messageId === frame.messageId)
        ) {
          refreshDetail(frame.threadRootId);
        }
        const stopped = frame.threadRootId === stoppedRootRef.current;
        setDetail((current) => {
          if (!current) return current;
          const merged = mergeChatTurnFrame(current, frame);
          return stopped
            ? { ...merged, summary: { ...merged.summary, state: 'stopped-continuable' } }
            : merged;
        });
        if (stopped) setPhase('stopped-continuable');
        else if (frame.type === 'chat.turn.done') setPhase('idle');
        else setPhase('streaming');
      }),
    [port, refreshDetail],
  );

  /** This thread's own message ids: never chip them — they are already the
   *  transcript. Messages from OTHER sessions/threads keep their chips. */
  const ownMessageIds = useMemo(() => {
    if (!detail) return undefined;
    const ids = new Set<string>(detail.turns.map((turn) => turn.messageId));
    ids.add(detail.summary.rootId);
    return ids;
  }, [detail]);

  const activeConfig = detail?.summary.config ?? null;
  const selectedModel = useMemo(
    () => models.find((model) => model.model === modelId) ?? null,
    [modelId, models],
  );
  const busy = isBusyPhase(phase);
  const newThread = selectedRootId === null;
  const startUnavailable = newThread ? port.startThread.unavailableReason : null;
  const selectionUnavailable =
    teammateId === ''
      ? 'No agent teammate is available in this space.'
      : !selectedModel
        ? 'No model is available from the launch catalog.'
        : null;
  const refusal = startUnavailable ?? selectionUnavailable;
  const sendDisabled = busy || draft.trim() === '' || refusal !== null;

  const send = useCallback(async () => {
    const body = draft.trim();
    if (body === '' || busy || refusal || teammateId === '' || !selectedModel) return;
    const continuingStoppedRoot =
      selectedRootId && phase === 'stopped-continuable' ? selectedRootId : null;
    setSubmitError(null);
    try {
      if (selectedRootId) {
        stoppedRootRef.current = null;
        setPhase('posting-turn');
        const framesBeforePost = recentFramesRef.current.length;
        await port.postTurn({
          threadRootId: selectedRootId,
          body,
          clientMutationId: newMutationId('chat-turn'),
        });
        setDraft('');
        const posted = await loadDetail(selectedRootId, framesBeforePost);
        setDetail(posted.detail);
        setPhase(posted.streamed ?? 'streaming');
        await refreshThreads(selectedRootId);
        return;
      }

      setPhase('posting-root');
      const root = await port.startThread.createRoot({
        spaceId,
        anchorId,
        body,
        clientMutationId: newMutationId('chat-root'),
      });
      setPhase('configuring');
      const configured = await port.startThread.configure({
        rootMessageId: root.threadRootId,
        teammateId,
        model: selectedModel.model,
        clientMutationId: newMutationId('chat-config'),
      });
      if (
        configured.threadRootId !== root.threadRootId ||
        configured.teammateId !== teammateId ||
        configured.model !== selectedModel.model
      ) {
        throw new Error('The node returned a different thread configuration than the one selected.');
      }
      setDraft('');
      setSelectedRootId(root.threadRootId);
      activeRootRef.current = root.threadRootId;
      recentFramesRef.current = [];
      const started = await loadDetail(root.threadRootId);
      setDetail(started.detail);
      setPhase(started.streamed ?? 'streaming');
      await refreshThreads(root.threadRootId);
    } catch (error) {
      if (continuingStoppedRoot) {
        stoppedRootRef.current = continuingStoppedRoot;
        setPhase('stopped-continuable');
      } else {
        setPhase('idle');
      }
      setSubmitError(describeError(error));
    }
  }, [
    anchorId,
    busy,
    draft,
    loadDetail,
    newMutationId,
    port,
    phase,
    refreshThreads,
    refusal,
    selectedModel,
    selectedRootId,
    spaceId,
    teammateId,
  ]);

  const interrupt = useCallback(async () => {
    if (!selectedRootId || !port.interrupt) return;
    stoppedRootRef.current = selectedRootId;
    try {
      await port.interrupt(selectedRootId);
      const stoppedDetail = await port.readThread(selectedRootId);
      setDetail({
        ...stoppedDetail,
        summary: { ...stoppedDetail.summary, state: 'stopped-continuable' },
      });
      setThreads((current) =>
        current.map((thread) =>
          thread.rootId === selectedRootId
            ? { ...thread, ...stoppedDetail.summary, state: 'stopped-continuable' }
            : thread,
        ),
      );
      setPhase('stopped-continuable');
    } catch (error) {
      stoppedRootRef.current = null;
      setPhase('streaming');
      setSubmitError(describeError(error));
    }
  }, [port, selectedRootId]);

  return (
    <main className="tch-root" data-testid="chat-home-screen">
      <aside className="tch-sidebar" aria-label="Chat threads">
        <header className="tch-sidebar__head">
          <span>
            <strong>Chat</strong>
            <small>{spaceLabel ?? 'this space'}</small>
          </span>
          <button
            type="button"
            className="tch-new"
            onClick={() => {
              setSelectedRootId(null);
              setDetail(null);
              stoppedRootRef.current = null;
              setPhase('idle');
              setSubmitError(null);
            }}
          >
            <span aria-hidden>＋</span> New
          </button>
        </header>
        <div className="tch-thread-list">
          {loading ? <p className="tch-hollow">Reading conversations…</p> : null}
          {!loading && threads.length === 0 ? (
            <p className="tch-hollow">No conversations yet. Start with the composer.</p>
          ) : null}
          {port.threadListUnavailableReason ? (
            <p className="tch-thread-refusal">{port.threadListUnavailableReason}</p>
          ) : null}
          {threads.map((thread) => (
            <button
              type="button"
              key={thread.rootId}
              className="tch-thread"
              data-active={thread.rootId === selectedRootId || undefined}
              onClick={() => setSelectedRootId(thread.rootId)}
            >
              <span className="tch-thread__title">
                {thread.state === 'streaming' ? (
                  <span className="tch-thread__live" title="Agent is working" aria-label="Agent is working" />
                ) : null}
                {thread.title}
              </span>
              <span className="tch-thread__preview">{thread.preview}</span>
              <span className="tch-thread__meta">
                <span>{thread.config.teammateLabel}</span>
                <span aria-hidden>·</span>
                <span>{thread.config.modelLabel}</span>
                <Timestamp at={thread.updatedAt} />
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="tch-conversation" aria-label="Conversation">
        <header className="tch-conversation__head">
          <div className="tch-title">
            <strong>{detail?.summary.title ?? 'New conversation'}</strong>
            <span>{activeConfig ? `with ${activeConfig.teammateLabel}` : 'Work with your graph from one place'}</span>
          </div>
          <Selector
            teammates={teammates}
            models={models}
            teammateId={activeConfig?.teammateId ?? teammateId}
            modelId={activeConfig?.model ?? modelId}
            provider={
              models.find((model) => model.model === (activeConfig?.model ?? modelId))?.provider ?? ''
            }
            pinned={activeConfig !== null}
            onTeammate={(id) => setTeammateId(id)}
            onModel={setModelId}
          />
        </header>

        <div className="tch-transcript" aria-live="polite">
          {loadError ? (
            <div className="tch-load-error" role="alert">
              <strong>Chat could not be read.</strong>
              <span>{loadError}</span>
            </div>
          ) : detailLoading ? (
            <div className="tch-loading" role="status" data-testid="chat-detail-loading">
              <span className="tch-dots" aria-hidden><i /><i /><i /></span>
              Reading this conversation…
            </div>
          ) : detail ? (
            <>
              {detail.turns.map((turn) => (
                <Turn
                  key={turn.messageId}
                  turn={turn}
                  onOpenEntity={onOpenEntity}
                  resolveEntity={resolveEntity}
                  suppressEntityIds={ownMessageIds}
                />
              ))}
              {showThinking(phase, detail) ? (
                <div className="tch-thinking" role="status" data-testid="chat-thinking">
                  <span className="tch-dots" aria-hidden><i /><i /><i /></span>
                  {phase === 'streaming' ? 'Agent is thinking…' : 'Sending your message…'}
                </div>
              ) : null}
            </>
          ) : (
            <div className="tch-welcome">
              <span className="tch-welcome__mark" aria-hidden>⌁</span>
              <h1>What should we work on?</h1>
              <p>Ask about this space, shape a plan, or delegate work. The agent uses graph tools and keeps every turn in the thread.</p>
            </div>
          )}
        </div>

        <div className="tch-composer-wrap" data-phase={phase}>
          {submitError ? <p className="tch-submit-error" role="alert">{submitError}</p> : null}
          {refusal ? <p className="tch-refusal" id="tch-compose-refusal">{refusal}</p> : null}
          {phase === 'stopped-continuable' ? (
            <p className="tch-continuable" role="status">
              Turn stopped · this thread is continuable. Send another message to resume.
            </p>
          ) : null}
          <div className="tch-composer">
            <textarea
              value={draft}
              aria-label="Message the chat agent"
              aria-describedby={refusal ? 'tch-compose-refusal' : undefined}
              disabled={busy}
              placeholder={newThread ? 'Ask anything about this space…' : 'Reply in this thread…'}
              rows={2}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="tch-composer__foot">
              <span className="tch-phase" role="status">{phaseLabel(phase)}</span>
              <span className="tch-hint">Enter to send · Shift+Enter for a new line</span>
              {phase === 'streaming' && port.interrupt ? (
                <button type="button" className="tch-stop" onClick={() => void interrupt()}>
                  <span aria-hidden>■</span> Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="tch-send"
                  aria-disabled={sendDisabled}
                  onClick={() => void send()}
                  title={refusal ?? undefined}
                >
                  Send <span aria-hidden>↑</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function Selector({
  teammates,
  models,
  teammateId,
  modelId,
  provider,
  pinned,
  onTeammate,
  onModel,
}: {
  teammates: readonly ChatTeammateOption[];
  models: readonly ChatModelOption[];
  teammateId: EntityId | '';
  modelId: string;
  provider: string;
  pinned: boolean;
  onTeammate(id: EntityId): void;
  onModel(id: string): void;
}) {
  return (
    <div className="tch-selector" data-pinned={pinned || undefined}>
      <label>
        <span>Teammate</span>
        <select
          aria-label="Chat teammate"
          disabled={pinned || teammates.length === 0}
          value={teammateId}
          onChange={(event) => onTeammate(event.target.value as EntityId)}
        >
          {teammates.map((teammate) => (
            <option key={teammate.id} value={teammate.id}>{teammate.label}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Model</span>
        <select
          aria-label="Chat model"
          disabled={pinned || models.length === 0}
          value={modelId}
          onChange={(event) => onModel(event.target.value)}
        >
          {models.map((model) => (
            <option key={`${model.agentTool}:${model.model}`} value={model.model}>
              {model.label}
            </option>
          ))}
        </select>
      </label>
      <span className="tch-selector__provider">{provider || 'provider unavailable'}</span>
      {pinned ? <span className="tch-selector__pin">pinned for this thread</span> : null}
    </div>
  );
}

function Turn({
  turn,
  onOpenEntity,
  resolveEntity,
  suppressEntityIds,
}: {
  turn: ChatThreadDetail['turns'][number];
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  resolveEntity?: ChatEntityResolver | undefined;
  suppressEntityIds?: ReadonlySet<string> | undefined;
}) {
  const label = turn.author?.displayName ?? (turn.role === 'assistant' ? 'Agent' : 'You');
  const actorId = turn.author?.id ?? `chat-${turn.role}`;
  const agent = turn.author?.isAgent ?? turn.role === 'assistant';
  return (
    <article className="tch-turn" data-role={turn.role}>
      <header className="tch-turn__byline">
        <Avatar
          actorId={actorId}
          provenance={agent ? 'agent' : 'human'}
          label={label}
          size={20}
          src={turn.author?.avatar}
        />
        <strong>{label}</strong>
        <Timestamp at={turn.createdAt} />
      </header>
      {turn.body ? <div className="tch-user-body">{turn.body}</div> : null}
      <TurnParts
        parts={turn.parts}
        onOpenEntity={onOpenEntity}
        resolveEntity={resolveEntity}
        suppressEntityIds={suppressEntityIds}
      />
    </article>
  );
}

function phaseLabel(phase: ComposerPhase): string {
  switch (phase) {
    case 'posting-root': return 'Saving the first prompt…';
    case 'configuring': return 'Starting the agent…';
    case 'posting-turn': return 'Saving your message…';
    case 'streaming': return 'Agent is working';
    case 'stopped-continuable': return 'Stopped · continuable';
    default: return '';
  }
}

/** The transcript shows a pulse whenever work is pending but nothing visible is
 *  arriving yet — a queued post, or a streaming turn whose assistant message
 *  has produced no parts. Once parts render, the stream itself is the signal. */
function showThinking(phase: ComposerPhase, detail: ChatThreadDetail): boolean {
  if (phase === 'posting-root' || phase === 'configuring' || phase === 'posting-turn') return true;
  if (phase !== 'streaming') return false;
  const last = detail.turns[detail.turns.length - 1];
  return !last || last.role !== 'assistant' || last.parts.length === 0;
}

function phaseForThreadState(state: ChatThreadSummary['state']): ComposerPhase {
  if (state === 'streaming') return 'streaming';
  if (state === 'stopped-continuable') return 'stopped-continuable';
  return 'idle';
}

function isBusyPhase(phase: ComposerPhase): boolean {
  return phase !== 'idle' && phase !== 'stopped-continuable';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultMutationId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}
