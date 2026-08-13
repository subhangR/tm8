import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import { Avatar, Timestamp } from '../kit';
import { mergeChatTurnFrame } from './turn-model';
import { TurnParts } from './TurnParts';
import type {
  ChatHomePort,
  ChatModelOption,
  ChatTeammateOption,
  ChatThreadDetail,
  ChatThreadSummary,
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
}

type ComposerPhase = 'idle' | 'posting-root' | 'configuring' | 'posting-turn' | 'streaming';

export function ChatHomeScreen({
  port,
  spaceId,
  anchorId = spaceId as EntityId,
  models,
  spaceLabel,
  newMutationId = defaultMutationId,
}: ChatHomeScreenProps) {
  const [threads, setThreads] = useState<readonly ChatThreadSummary[]>([]);
  const [teammates, setTeammates] = useState<readonly ChatTeammateOption[]>([]);
  const [selectedRootId, setSelectedRootId] = useState<EntityId | null>(null);
  const [detail, setDetail] = useState<ChatThreadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [phase, setPhase] = useState<ComposerPhase>('idle');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [teammateId, setTeammateId] = useState<EntityId | ''>('');
  const [modelId, setModelId] = useState(models[0]?.model ?? '');
  const activeRootRef = useRef<EntityId | null>(null);

  const refreshThreads = useCallback(async (preferRoot?: EntityId) => {
    const next = await port.listThreads(spaceId);
    setThreads(next);
    setSelectedRootId((current) => preferRoot ?? current ?? next[0]?.rootId ?? null);
  }, [port, spaceId]);

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
    if (!selectedRootId) {
      setDetail(null);
      return;
    }
    let alive = true;
    setLoadError(null);
    void port
      .readThread(selectedRootId)
      .then((next) => {
        if (alive) setDetail(next);
      })
      .catch((error: unknown) => {
        if (alive) setLoadError(describeError(error));
      });
    return () => {
      alive = false;
    };
  }, [port, selectedRootId]);

  useEffect(
    () =>
      port.subscribe((frame) => {
        if (frame.threadRootId !== activeRootRef.current) return;
        setDetail((current) => (current ? mergeChatTurnFrame(current, frame) : current));
        if (frame.type === 'chat.turn.done') setPhase('idle');
        else setPhase('streaming');
      }),
    [port],
  );

  const activeConfig = detail?.summary.config ?? null;
  const selectedModel = useMemo(
    () => models.find((model) => model.model === modelId) ?? null,
    [modelId, models],
  );
  const busy = phase !== 'idle';
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
    setSubmitError(null);
    try {
      if (selectedRootId) {
        setPhase('posting-turn');
        await port.postTurn({
          threadRootId: selectedRootId,
          body,
          clientMutationId: newMutationId('chat-turn'),
        });
        setDraft('');
        setDetail(await port.readThread(selectedRootId));
        setPhase('streaming');
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
      setDetail(await port.readThread(root.threadRootId));
      setPhase('streaming');
      await refreshThreads(root.threadRootId);
    } catch (error) {
      setPhase('idle');
      setSubmitError(describeError(error));
    }
  }, [
    anchorId,
    busy,
    draft,
    newMutationId,
    port,
    refreshThreads,
    refusal,
    selectedModel,
    selectedRootId,
    spaceId,
    teammateId,
  ]);

  const interrupt = useCallback(async () => {
    if (!selectedRootId || !port.interrupt) return;
    try {
      await port.interrupt(selectedRootId);
      setPhase('idle');
    } catch (error) {
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
              <span className="tch-thread__title">{thread.title}</span>
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
          ) : detail ? (
            detail.turns.map((turn) => <Turn key={turn.messageId} turn={turn} />)
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
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="tch-composer__foot">
              <span className="tch-phase" role="status">{phaseLabel(phase)}</span>
              <span className="tch-hint">⌘ Enter to send</span>
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

function Turn({ turn }: { turn: ChatThreadDetail['turns'][number] }) {
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
      <TurnParts parts={turn.parts} />
    </article>
  );
}

function phaseLabel(phase: ComposerPhase): string {
  switch (phase) {
    case 'posting-root': return 'Saving the first prompt…';
    case 'configuring': return 'Starting the agent…';
    case 'posting-turn': return 'Saving your message…';
    case 'streaming': return 'Agent is working';
    default: return '';
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultMutationId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}
