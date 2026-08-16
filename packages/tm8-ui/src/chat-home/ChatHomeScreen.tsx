import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMode, EntityId, SpaceId } from '@tm8/contract';
import { Avatar, Timestamp } from '../kit';
import { ChooseFilesControl } from '../files/ChooseFilesControl';
import type { FileUploadTask } from '../files/upload';
import { DisabledIconControl } from '../panels/honesty/DisabledWithReason';
import {
  AttachmentChips,
  TriggerPopover,
  skillReference,
  useRichInput,
  type TriggerOption,
} from '../rich-input';
import { LiveGraphStrip } from '../channel-screen/LiveToolGraph';
import { mergeChatTurnFrame, projectTurnParts, reconcileDetails } from './turn-model';
import { foldTurnGraph } from './turn-graph';
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
  /**
   * Starts one upload against the anchor this chat writes to.
   *
   * TAKES THE ANCHOR RATHER THAN BEING BOUND TO IT — same signature as
   * `AttachmentsPort.startUpload`, so a host assigns that verb with no
   * adapter. The screen resolves its own anchor (bare Home falls back to the
   * seeded default channel), and binding the port outside would mean the
   * default lived in two places, free to disagree.
   *
   * UPLOADS START IMMEDIATELY, against the ANCHOR, not against the thread: a
   * new conversation has no root message until Send, and holding a pasted
   * file until then would mean the writer watches nothing happen. The anchor
   * exists before the first word is typed.
   *
   * Absent ⇒ paste and drop stay inert and the attach control says why.
   */
  attach?: (file: File, anchorId: EntityId) => FileUploadTask;
  /**
   * Skills `/` can REFERENCE (R1 — the agent reads the link and decides;
   * nothing is invoked). `undefined` ⇒ `/` types plain text.
   */
  skillOptions?: readonly TriggerOption[];
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
  attach,
  skillOptions,
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
  const [chatMode, setChatMode] = useState<ChatMode>('ask');
  const activeRootRef = useRef<EntityId | null>(null);
  const stoppedRootRef = useRef<EntityId | null>(null);
  const detailRef = useRef<ChatThreadDetail | null>(null);
  /** Rolling cache of the active thread's recent frames, replayed over every
   *  snapshot read so a frame published after the read began is never lost
   *  (parts are durable server-side before frames publish, so the snapshot is
   *  authoritative for everything older; the merge is idempotent via per-message
   *  seq dedupe). A message's frames are pruned once its `done` is merged —
   *  they are in the durable snapshot by then — so the cap is a backstop, not
   *  a content-loss cliff. Reset on thread switch. */
  const recentFramesRef = useRef<ChatTurnFrame[]>([]);
  /** Message ids of the active thread's turns that are streaming right now
   *  (delta seen, done not yet). The single source of truth for `streaming`. */
  const liveTurnsRef = useRef<Set<string>>(new Set());
  /** Monotonic frame counter + first-seen index per message, so a done can be
   *  attributed to a turn that STARTED before or after our own post — another
   *  participant's finishing turn must not settle our still-queued one. */
  const frameSeqRef = useRef(0);
  const firstSeenRef = useRef<Map<string, number>>(new Map());
  /** Thread we just posted into and expect to start streaming, plus the frame
   *  counter at post time. Cleared only by a done for a turn that started
   *  after the post (ours or a successor), or by leaving the thread. */
  const expectingRootRef = useRef<EntityId | null>(null);
  const expectingMarkRef = useRef(0);
  /** The turns already on screen when we posted, or null when we have not
   *  posted into this thread. Nothing in that snapshot can be the turn our
   *  pulse stands in for — the server writes the placeholder when it CLAIMS
   *  the turn, strictly after our post — and with no snapshot at all there is
   *  nothing to identify a placeholder by. */
  const preTurnIdsRef = useRef<Set<string> | null>(null);
  /** Per-root single-flight for participant-message refreshes — one thread's
   *  pending refresh must not swallow another thread's. */
  const refreshingRootsRef = useRef<Set<string>>(new Set());
  /** Roots currently known to the sidebar — a frame for an unknown root means
   *  another member started a thread and the list must re-read. */
  const knownRootsRef = useRef<Set<string>>(new Set());
  const refreshingThreadsRef = useRef(false);

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  const refreshThreads = useCallback(async (preferRoot?: EntityId) => {
    const next = await port.listThreads(spaceId);
    knownRootsRef.current = new Set(next.map((thread) => thread.rootId));
    setThreads(next);
    setSelectedRootId((current) => preferRoot ?? current ?? next[0]?.rootId ?? null);
  }, [port, spaceId]);

  /** Read a thread snapshot and replay every cached frame over it, so frames
   *  published after the read began are never lost. Phase is NOT derived here —
   *  `liveTurnsRef`/`turnsDoneRef` are the phase authority, keyed by message
   *  id rather than frame position. */
  const loadDetail = useCallback(
    async (rootId: EntityId): Promise<ChatThreadDetail> => {
      let next = await port.readThread(rootId);
      for (const frame of recentFramesRef.current) {
        if (frame.threadRootId !== rootId) continue;
        next = mergeChatTurnFrame(next, frame);
      }
      return next;
    },
    [port],
  );

  /** Single-flight re-read of the active thread — used when a frame references
   *  a message we do not have yet (another participant posted). */
  const refreshDetail = useCallback(
    (rootId: EntityId) => {
      if (refreshingRootsRef.current.has(rootId)) return;
      refreshingRootsRef.current.add(rootId);
      void loadDetail(rootId)
        .then((next) => {
          if (activeRootRef.current === rootId) {
            setDetail((current) => reconcileDetails(current, next));
          }
        })
        .catch(() => {
          // The next frame or thread switch retries; a missed refresh only
          // delays another participant's message, it never corrupts state.
        })
        .finally(() => {
          refreshingRootsRef.current.delete(rootId);
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
    liveTurnsRef.current.clear();
    firstSeenRef.current.clear();
    if (expectingRootRef.current && expectingRootRef.current !== selectedRootId) {
      expectingRootRef.current = null;
      preTurnIdsRef.current = null;
    }
    if (!selectedRootId) {
      setDetail(null);
      return;
    }
    let alive = true;
    setLoadError(null);
    void loadDetail(selectedRootId)
      .then((next) => {
        if (!alive) return;
        setDetail((current) => reconcileDetails(current, next));
        stoppedRootRef.current =
          next.summary.state === 'stopped-continuable' ? selectedRootId : null;
        setPhase(
          liveTurnsRef.current.size > 0 || expectingRootRef.current === selectedRootId
            ? 'streaming'
            : phaseForThreadState(next.summary.state),
        );
      })
      .catch((error: unknown) => {
        if (alive) setLoadError(describeError(error));
      });
    return () => {
      alive = false;
    };
  }, [loadDetail, selectedRootId]);

  useEffect(
    () =>
      port.subscribe((frame) => {
        if (frame.threadRootId === activeRootRef.current) {
          if (frame.type === 'chat.turn.done') {
            // The turn's parts are all durable in the snapshot by now — its
            // deltas are pure replay weight. Keep the small done frame so a
            // later replay can still restore the usage merge.
            recentFramesRef.current = [
              ...recentFramesRef.current.filter(
                (cached) => cached.messageId !== frame.messageId || cached.type === 'chat.turn.done',
              ),
              frame,
            ];
            liveTurnsRef.current.delete(frame.messageId);
          } else {
            recentFramesRef.current.push(frame);
            liveTurnsRef.current.add(frame.messageId);
            frameSeqRef.current += 1;
            if (!firstSeenRef.current.has(frame.messageId)) {
              firstSeenRef.current.set(frame.messageId, frameSeqRef.current);
            }
          }
          if (recentFramesRef.current.length > 2000) {
            recentFramesRef.current = recentFramesRef.current.slice(-1000);
          }
        }
        // Any thread's activity keeps the sidebar honest, active or not — and
        // a frame for a root the list has never seen means another member
        // started a thread: re-read the list.
        if (!knownRootsRef.current.has(frame.threadRootId) && !refreshingThreadsRef.current) {
          refreshingThreadsRef.current = true;
          void refreshThreads().finally(() => {
            refreshingThreadsRef.current = false;
          });
        }
        setThreads((current) =>
          current.map((thread) =>
            thread.rootId === frame.threadRootId
              ? {
                  ...thread,
                  state: frame.type === 'chat.turn.done' ? 'idle' : 'streaming',
                  updatedAt: new Date().toISOString(),
                }
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
        else if (frame.type === 'chat.turn.done') {
          if (liveTurnsRef.current.size > 0) return;
          // Only a done for a turn that STARTED after our post settles the
          // expectation — another participant's older turn finishing must not
          // hide the pulse for our still-queued one.
          const startedAt = firstSeenRef.current.get(frame.messageId) ?? 0;
          if (expectingRootRef.current === frame.threadRootId && startedAt < expectingMarkRef.current) {
            return;
          }
          expectingRootRef.current = null;
          preTurnIdsRef.current = null;
          setPhase('idle');
        } else setPhase('streaming');
      }),
    [port, refreshDetail],
  );

  /** This thread's own message ids: never chip them — they are already the
   *  transcript. Messages from OTHER sessions/threads keep their chips. Keyed
   *  by the joined ids, not the detail object, so streamed part updates do not
   *  mint a new Set and defeat every tool card's extraction memo. */
  const ownMessageIdsKey = detail
    ? `${detail.summary.rootId}:${detail.turns.map((turn) => turn.messageId).join(',')}`
    : '';
  const ownMessageIds = useMemo(() => {
    if (!detail) return undefined;
    const ids = new Set<string>(detail.turns.map((turn) => turn.messageId));
    ids.add(detail.summary.rootId);
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by id list
  }, [ownMessageIdsKey]);

  /** Live star of every entity this thread's tool calls referenced — the same
   *  client-side extraction the chips use, folded once per turns change. */
  const turnGraph = useMemo(
    () => (detail ? foldTurnGraph(detail.turns, ownMessageIds) : null),
    [detail, ownMessageIds],
  );

  const activeConfig = detail?.summary.config ?? null;
  const selectedModel = useMemo(
    () => models.find((model) => model.model === modelId) ?? null,
    [modelId, models],
  );
  const busy = isBusyPhase(phase);
  const thinking = detail !== null && showThinking(phase, detail);
  const pendingTurnId =
    detail !== null && thinking
      ? claimedSilentTurnId(phase, detail, preTurnIdsRef.current)
      : null;
  const newThread = selectedRootId === null;
  const startUnavailable = newThread ? port.startThread.unavailableReason : null;
  const selectionUnavailable =
    teammateId === ''
      ? 'No agent teammate is available in this space.'
      : !selectedModel
        ? 'No model is available from the launch catalog.'
        : null;
  const refusal = startUnavailable ?? selectionUnavailable;

  /**
   * THE COMPOSER IS THE SHARED RICH INPUT (chip placement, R4).
   *
   * `/` references a skill; `@` is deliberately NOT declared here — the chat
   * port carries `attachmentIds` and no `mentionIds`, and a picker that
   * committed a name the wire would drop is the same defect this whole
   * migration exists to end. Declaring it absent leaves `@` as plain text,
   * which is honest and is what it already was.
   */
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const rich = useRichInput({
    value: draft,
    onChange: setDraft,
    areaRef: composer,
    triggers: [{
      sigil: '/',
      options: skillOptions,
      onSelect: (option) => ({ insert: skillReference(option.display, option.id) }),
    }],
    attachments: {
      start: attach ? (file: File) => attach(file, anchorId) : undefined,
      placement: { mode: 'chip' },
    },
    onKeyDown: (event) => {
      // `isComposing` guards an IME candidate window: Enter there commits the
      // candidate, and sending on it would post a half-typed word.
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        void send();
      }
    },
  });
  const attachments = rich.attachments!;
  /* Read at SEND time through a ref, not closed over: `send` is memoised on
     the facts of the conversation, and the staged list changes with every
     upload frame. Closing over it would either stale the ids or churn the
     callback's identity on every render. */
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const sendDisabled = busy || draft.trim() === '' || refusal !== null || attachments.blocked;

  const send = useCallback(async () => {
    const body = draft.trim();
    if (body === '' || busy || refusal || teammateId === '' || !selectedModel) return;
    const staged = attachmentsRef.current;
    // An upload still in flight is not a reason to drop it: Send waits rather
    // than posting a message whose file the writer is watching arrive.
    if (staged.blocked) return;
    const attachmentIds = staged.uploadedIds() as EntityId[];
    const continuingStoppedRoot =
      selectedRootId && phase === 'stopped-continuable' ? selectedRootId : null;
    setSubmitError(null);
    const originRoot = selectedRootId;
    try {
      if (selectedRootId) {
        stoppedRootRef.current = null;
        setPhase('posting-turn');
        expectingRootRef.current = selectedRootId;
        expectingMarkRef.current = frameSeqRef.current;
        preTurnIdsRef.current = new Set(
          (detailRef.current?.turns ?? []).map((turn) => turn.messageId),
        );
        await port.postTurn({
          threadRootId: selectedRootId,
          body,
          clientMutationId: newMutationId('chat-turn'),
          ...(attachmentIds.length ? { attachmentIds } : {}),
        });
        // Clear only the draft we actually sent — if the user switched threads
        // and typed something new while the post was in flight, keep it.
        setDraft((current) => (current.trim() === body ? '' : current));
        // Forget the chips WITHOUT cancelling their uploads: the ids are on
        // the message that was just stored.
        staged.clear();
        const posted = await loadDetail(selectedRootId);
        // The user may have switched threads while the post was in flight —
        // this thread's snapshot must never overwrite another thread's screen.
        if (activeRootRef.current === selectedRootId) {
          setDetail((current) => reconcileDetails(current, posted));
          setPhase(
            liveTurnsRef.current.size > 0 || expectingRootRef.current === selectedRootId
              ? 'streaming'
              : 'idle',
          );
        }
        await refreshThreads(
          activeRootRef.current === selectedRootId ? selectedRootId : undefined,
        );
        return;
      }

      setPhase('posting-root');
      const root = await port.startThread.createRoot({
        spaceId,
        anchorId,
        body,
        clientMutationId: newMutationId('chat-root'),
        ...(attachmentIds.length ? { attachmentIds } : {}),
      });
      setPhase('configuring');
      const configured = await port.startThread.configure({
        rootMessageId: root.threadRootId,
        teammateId,
        model: selectedModel.model,
        mode: chatMode,
        clientMutationId: newMutationId('chat-config'),
      });
      if (
        configured.threadRootId !== root.threadRootId ||
        configured.teammateId !== teammateId ||
        configured.model !== selectedModel.model ||
        configured.mode !== chatMode
      ) {
        throw new Error('The node returned a different thread configuration than the one selected.');
      }
      setDraft((current) => (current.trim() === body ? '' : current));
      staged.clear();
      // The select effect owns loading the new thread — a second concurrent
      // read here would race it for setDetail/setPhase. `expecting` keeps the
      // pulse honest until the first frame arrives.
      expectingRootRef.current = root.threadRootId;
      expectingMarkRef.current = frameSeqRef.current;
      preTurnIdsRef.current = new Set();
      setSelectedRootId(root.threadRootId);
      setPhase('streaming');
      await refreshThreads(root.threadRootId);
    } catch (error) {
      // Never let a failed send in one thread rewrite another's phase or show
      // its error under an unrelated conversation.
      if (activeRootRef.current === originRoot) {
        if (continuingStoppedRoot) {
          stoppedRootRef.current = continuingStoppedRoot;
          setPhase('stopped-continuable');
        } else {
          setPhase('idle');
        }
        setSubmitError(describeError(error));
      }
    }
  }, [
    anchorId,
    busy,
    chatMode,
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
    const rootId = selectedRootId;
    stoppedRootRef.current = rootId;
    try {
      await port.interrupt(rootId);
      const stoppedDetail = await port.readThread(rootId);
      // Live-turn bookkeeping belongs to whichever thread is active NOW — an
      // interrupt that resolves after switching away must not touch it.
      if (activeRootRef.current === rootId) {
        liveTurnsRef.current.clear();
        expectingRootRef.current = null;
        preTurnIdsRef.current = null;
        setDetail((current) => {
          const merged = reconcileDetails(current, stoppedDetail);
          return { ...merged, summary: { ...merged.summary, state: 'stopped-continuable' } };
        });
        setPhase('stopped-continuable');
      }
      setThreads((current) =>
        current.map((thread) =>
          thread.rootId === rootId
            ? { ...thread, ...stoppedDetail.summary, state: 'stopped-continuable' }
            : thread,
        ),
      );
    } catch (error) {
      if (activeRootRef.current === rootId) {
        stoppedRootRef.current = null;
        setPhase('streaming');
        setSubmitError(describeError(error));
      }
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
                <span className="tch-mode-chip">{thread.config.mode}</span>
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
            mode={activeConfig?.mode ?? chatMode}
            provider={
              models.find((model) => model.model === (activeConfig?.model ?? modelId))?.provider ?? ''
            }
            pinned={activeConfig !== null}
            onTeammate={(id) => setTeammateId(id)}
            onModel={setModelId}
            onMode={setChatMode}
          />
        </header>

        <div className="tch-transcript" aria-live="polite">
          {loadError ? (
            <div className="tch-load-error" role="alert">
              <strong>Chat could not be read.</strong>
              <span>{loadError}</span>
            </div>
          ) : selectedRootId !== null && detail?.summary.rootId !== selectedRootId ? (
            // Never render one thread's transcript under another thread's
            // selection; a matching transcript stays up through a same-thread
            // reload so fast reads cannot flicker.
            <div className="tch-loading" role="status" data-testid="chat-detail-loading">
              <span className="tch-dots" aria-hidden><i /><i /><i /></span>
              Reading this conversation…
            </div>
          ) : detail ? (
            <>
              {turnGraph ? (
                <LiveGraphStrip
                  model={turnGraph}
                  anchorNoun="this conversation"
                  focusKind="message"
                  onOpenEntity={onOpenEntity}
                />
              ) : null}
              {detail.turns.map((turn) => (
                <Turn
                  key={turn.messageId}
                  turn={turn}
                  mode={detail.summary.config.mode}
                  pending={turn.messageId === pendingTurnId}
                  onOpenEntity={onOpenEntity}
                  resolveEntity={resolveEntity}
                  suppressEntityIds={ownMessageIds}
                />
              ))}
              {thinking ? (
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
            <AttachmentChips attachments={attachments} testId="tch-attachments" />
            <div className="ri-host">
              <textarea
                ref={composer}
                value={draft}
                aria-label="Message the chat agent"
                aria-describedby={refusal ? 'tch-compose-refusal' : undefined}
                disabled={busy}
                placeholder={
                  newThread ? 'Ask anything about this space…' : 'Reply in this thread…'
                }
                rows={2}
                {...rich.areaProps}
              />
              <TriggerPopover
                popover={rich.popover}
                label="Available skills"
                renderOption={(option) => (
                  <>
                    <span className="ri-popover__name">{`/${option.display}`}</span>
                    {option.meta ? <span className="ri-popover__meta">{option.meta}</span> : null}
                  </>
                )}
                emptyText="No matching skills"
                testId="tch-skill-picker"
              />
            </div>
            <div className="tch-composer__foot">
              {attach ? (
                <ChooseFilesControl
                  label="Attach a file"
                  title="attach a file — or drop or paste one into the message"
                  className="tch-attach"
                  inputClassName="tch-attach__input"
                  onChoose={attachments.addFiles}
                />
              ) : (
                <DisabledIconControl
                  label="Attach a file"
                  glyph="＋"
                  reason={{
                    cause: 'Uploading isn’t wired on this surface',
                    remedy: 'this chat was mounted without an attachment port',
                  }}
                />
              )}
              {skillOptions ? (
                <button
                  type="button"
                  className="tch-attach"
                  aria-label="Reference a skill"
                  title="reference a skill — the agent reads it and decides; nothing runs by itself"
                  aria-haspopup="listbox"
                  aria-expanded={rich.popover !== null}
                  onClick={() => {
                    // The button and the typed sigil must land in the SAME
                    // state, or the picker has two behaviours and only one of
                    // them filters.
                    if (rich.popover) rich.popover.close();
                    else rich.openTrigger('/');
                  }}
                >
                  <span aria-hidden>/</span>
                </button>
              ) : null}
              <span className="tch-phase" role="status">{phaseLabel(phase)}</span>
              <span className="tch-hint">Enter to send · Shift+Enter for a new line</span>
              {phase === 'streaming' ? (
                port.interrupt ? (
                  <button type="button" className="tch-stop" onClick={() => void interrupt()}>
                    <span aria-hidden>■</span> Stop
                  </button>
                ) : (
                  /* Unavailable ≠ invisible: the catalog has exactly one chat
                     operation (`chat.threads.start`) and no interrupt, so on a
                     real node this control used to vanish mid-turn and leave a
                     running turn looking unstoppable by design. */
                  <DisabledIconControl
                    label="Stop this turn"
                    glyph="■"
                    reason={{
                      cause: 'Stopping a turn isn’t available on this node',
                      remedy: 'no chat interrupt operation is exposed — the turn ends on its own',
                    }}
                  >
                    Stop
                  </DisabledIconControl>
                )
              ) : null}
              <button
                type="button"
                className="tch-send"
                aria-disabled={sendDisabled}
                onClick={() => void send()}
                title={
                  refusal
                  ?? (attachments.blocked
                    ? 'One or more attachments are not ready — wait for uploads to finish, retry failures, or remove them before sending.'
                    : undefined)
                }
              >
                Send <span aria-hidden>↑</span>
              </button>
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
  mode,
  provider,
  pinned,
  onTeammate,
  onModel,
  onMode,
}: {
  teammates: readonly ChatTeammateOption[];
  models: readonly ChatModelOption[];
  teammateId: EntityId | '';
  modelId: string;
  mode: ChatMode;
  provider: string;
  pinned: boolean;
  onTeammate(id: EntityId): void;
  onModel(id: string): void;
  onMode(mode: ChatMode): void;
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
        <span>Mode</span>
        <select
          aria-label="Chat mode"
          disabled={pinned}
          value={mode}
          onChange={(event) => onMode(event.target.value as ChatMode)}
        >
          <option value="ask">Ask</option>
          <option value="explain">Explain</option>
          <option value="plan">Plan</option>
          <option value="build">Build</option>
          <option value="orchestrate">Orchestrate</option>
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
  mode,
  pending,
  onOpenEntity,
  resolveEntity,
  suppressEntityIds,
}: {
  turn: ChatThreadDetail['turns'][number];
  mode: ChatMode;
  /** This turn is the one the pulse is already announcing. */
  pending?: boolean;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  resolveEntity?: ChatEntityResolver | undefined;
  suppressEntityIds?: ReadonlySet<string> | undefined;
}) {
  const label = turn.author?.displayName ?? (turn.role === 'assistant' ? 'Agent' : 'You');
  const actorId = turn.author?.id ?? `chat-${turn.role}`;
  const agent = turn.author?.isAgent ?? turn.role === 'assistant';
  /**
   * AN ANSWER IS ITS RENDERED PARTS. The server writes the assistant message
   * body twice — 'Agent turn in progress.' when the turn is claimed, the
   * finished text when it completes — because feeds, previews and
   * notifications have no parts to read. Here they do, so printing the body
   * alongside them said the same thing twice: the answer duplicated on every
   * re-read, and a redundant placeholder bubble under the thinking pulse.
   *
   * The test is what the transcript actually DRAWS, not how many rows were
   * stored. `projectTurnParts` folds a call and its result into one card and
   * drops `done` entirely, so a turn that terminated without producing output
   * holds one part and renders nothing — suppressing its body on `length` left
   * an empty bubble where the durable 'Agent turn completed.' should be.
   *
   * A turn that draws nothing is not an answer: either an ordinary message
   * posted into this thread by a teammate, whose body is all it has to say, or
   * the claimed-but-silent turn the pulse is already covering.
   */
  const bodyIsContent =
    turn.role !== 'assistant' || (projectTurnParts(turn.parts).length === 0 && !pending);
  return (
    <article className="tch-turn" data-role={turn.role} data-mode={mode}>
      <header className="tch-turn__byline">
        <Avatar
          actorId={actorId}
          provenance={agent ? 'agent' : 'human'}
          label={label}
          size={20}
          src={turn.author?.avatar}
        />
        <strong>{label}</strong>
        <span className="tch-mode-chip" title={`This answer ran in ${mode} mode`}>{mode}</span>
        <Timestamp at={turn.createdAt} />
      </header>
      {bodyIsContent && turn.body ? <div className="tch-user-body">{turn.body}</div> : null}
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
  return !last || last.role !== 'assistant' || projectTurnParts(last.parts).length === 0;
}

/**
 * WHICH turn the pulse is standing in for — by identity, never by position.
 *
 * A claimed turn's placeholder and an ordinary message a teammate posted into
 * this thread are INDISTINGUISHABLE on the wire: `role` is derived purely from
 * `author.isAgent`, and `MessageView.parts` is omitted entirely when a message
 * has none, so neither carries a mark saying "I am a chat turn". Position
 * cannot stand in for identity either — the composer stays open during
 * `streaming`, so a later user message can sit after the placeholder, and the
 * placeholder is then no longer the last row.
 *
 * Cardinality does not stand in for it either: a thread can already hold a
 * silent teammate message, which is then the only silent assistant on screen.
 * Nor does arrival: "absent from the rows THIS TAB had rendered" is not the
 * server's ordering, so a teammate message that lands between our post and the
 * claim — or one that was durable all along and unseen here, since this screen
 * never subscribes to ordinary message additions — is equally new to us.
 *
 * So the last gate is the server's OWN sentinel. `createAgentMessage`
 * (`server/src/chat/orchestrator.ts:369`, pinned by `chat-storage.pg.test.ts`)
 * writes exactly this body when it claims a turn. Matching it is a heuristic
 * and it is deliberately the one whose failure is BOUNDED: the worst it can do
 * is hide an ordinary message whose entire content is that same sentence,
 * rather than arbitrary teammate content. If the server ever changes the
 * string, suppression stops and the redundant bubble comes back — a blemish,
 * not data loss. That is the safe direction to fail in.
 *
 * The real fix is a wire marker. The server already HAS one —
 * `bind_chat_agent_message` records `chat_turns.agent_message_id` — and no
 * read path projects it, so no client can ask which row belongs to a turn.
 *
 * Arrival and cardinality still gate on top: only rows new to us, and only
 * when exactly one qualifies. With NO snapshot — a reload or a thread switch
 * mid-turn — nothing is suppressed and the durable body renders. That is the
 * honest outcome while thread liveness is never read back from the server: the
 * body is then the only hint that surface has.
 *
 * Candidacy asks for zero STORED parts, not zero rendered ones: a turn that
 * stored only `done` draws nothing but is plainly finished, and is not what a
 * pulse stands in for. (The body fallback still asks the projection — there
 * the question is whether anything was drawn.)
 *
 * During the posting phases the pulse is announcing OUR OWN write, not any
 * turn on screen, so it stands in for nothing and suppresses nothing.
 */
function claimedSilentTurnId(
  phase: ComposerPhase,
  detail: ChatThreadDetail,
  preTurnIds: ReadonlySet<string> | null,
): EntityId | null {
  if (phase !== 'streaming' || preTurnIds === null) return null;
  const silent = detail.turns.filter(
    (turn) =>
      turn.role === 'assistant' &&
      turn.parts.length === 0 &&
      turn.body === CLAIMED_TURN_BODY &&
      !preTurnIds.has(turn.messageId),
  );
  return silent.length === 1 ? silent[0]!.messageId : null;
}

/** The body the server writes onto the agent message when it claims a turn —
 *  `orchestrator.ts:369`, asserted by `server/test/db/chat-storage.pg.test.ts`.
 *  Not a UI string: the transcript never authors it, it only recognises it. */
const CLAIMED_TURN_BODY = 'Agent turn in progress.';

function phaseForThreadState(state: ChatThreadSummary['state']): ComposerPhase {
  if (state === 'streaming') return 'streaming';
  if (state === 'stopped-continuable') return 'stopped-continuable';
  return 'idle';
}

/** Only the user's OWN in-flight write blocks the composer. `streaming` is
 *  deliberately not busy: in a multiplayer thread anyone's agent may be
 *  working, and the server queues turns — typing and sending stay available. */
function isBusyPhase(phase: ComposerPhase): boolean {
  return phase === 'posting-root' || phase === 'configuring' || phase === 'posting-turn';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultMutationId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}
