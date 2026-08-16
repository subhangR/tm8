import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChatMode, EntityId, SpaceId } from '@tm8/contract';
import type { HomeTab } from '../stores/homeRegionStore';
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
import type { ConnectionsReader } from '../session-graph/load';
import { mergeChatTurnFrame, projectTurnParts, reconcileDetails } from './turn-model';
import { ChatEntityGraph } from './ChatEntityGraph';
import type { ChatEntityResolver } from './EntityChip';
import { ComposerSelect } from './ComposerSelect';
import { TurnParts } from './TurnParts';
import type {
  ChatHomePort,
  ChatModelOption,
  ChatSessionRow,
  ChatTaskRow,
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
  newMutationId?: (prefix: string) => string;
  /** Opens the entity detail panel for an entity a tool call referenced. */
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  /** Lazily resolves title/kind for bare entity ids in tool payloads. */
  resolveEntity?: ChatEntityResolver | undefined;
  /**
   * The host's `entities.connections` reader, for the entity graph's induced
   * relations (never `graph.query` — see `session-graph/model.ts`). Absent ⇒
   * the graph draws every card labelled "edges not read" (R11), never a
   * fabricated line.
   */
  connections?: ConnectionsReader | undefined;
  /** Same authenticated file-byte seam used by the Files screen. */
  assetHref?: ((fileEntityId: EntityId) => string | null) | undefined;
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
  /**
   * Work sessions for the SESSIONS TAB (task 01a006f8 D1/D17 — the merged
   * R4 column is retired; each population owns a tab now). Rows arrive
   * COMPOSED — status word, tone and the live verdict are the host's
   * (liveness outranks the stored record); this screen renders them.
   * `undefined` means the host did not wire sessions (older mounts), and the
   * tab says so — absent is not an empty session list.
   */
  sessions?: readonly ChatSessionRow[];
  /**
   * Tasks for the TASKS TAB, same contract as `sessions`: host-composed and
   * host-ordered. `undefined` ⇒ the tab states tasks are not wired here.
   */
  tasks?: readonly ChatTaskRow[];
  /**
   * The active tab, when the HOST owns it (D15: persisted per space, and
   * D11 flips it to Sessions from outside this screen on spawn). Absent ⇒
   * uncontrolled, defaulting to Chats — the standalone/mobile mounts.
   */
  tab?: HomeTab;
  onTab?: ((tab: HomeTab) => void) | undefined;
  /**
   * The entity currently occupying region B, for the HONEST active-row
   * highlight (D9): a task/session row draws active only when it IS the
   * selection; while an entity is selected, no chat row is active.
   */
  selectedEntityId?: string | null;
  /** SELECTING (D7): puts a task/session row's entity in region B. Absent ⇒
   *  those rows render disabled-with-reason, never dead. */
  onSelectEntity?: ((id: string) => void) | undefined;
  /** The host clears region B back to the chat — a chat row click or ＋ New
   *  chat calls it, so the conversation pane (D8: mounted, hidden) returns. */
  onShowChat?: (() => void) | undefined;
  /** D2/D3: `＋ New task` — the host's `useNewTask` create-immediately flow.
   *  Absent ⇒ disabled with `newTaskUnavailable`'s reason, never hidden. */
  onNewTask?: (() => void) | undefined;
  newTaskUnavailable?: { cause: string; remedy: string } | null;
  /** D11: Run on a task row → the host opens its launch sheet on that task.
   *  Serves the FALLBACK rows only — a hosted tab list wires Run itself. */
  onRunTask?: ((id: string) => void) | undefined;
  /**
   * The host's own CONTENT for a tab — the workspace's `EntityListPanel`
   * with its full tree, tiles, lifecycle tabs and in-panel search (user
   * ruling 2026-08-16: exact same components). Non-null replaces this
   * screen's list AND its search box for that tab (the panel brings its
   * own); null keeps the built-in rows — the standalone/mobile mounts.
   */
  renderTabList?: ((tab: HomeTab) => ReactNode) | undefined;
  /**
   * Region B when it is NOT the chat (D7/D8): the host's entity panel,
   * rendered in the conversation pane's place while the conversation stays
   * MOUNTED but hidden — unmounting it would tear down a streaming thread.
   */
  centerOverride?: ReactNode;
  /**
   * Node slot usage for the column foot — `execution.liveness.capacity`,
   * passed through. `undefined` renders NOTHING (absent ≠ zero: no snapshot
   * means nobody measured, not that the node has no slots).
   */
  slots?: { used: number; total: number } | undefined;
  /** The signed-in display name, for the empty-state greeting. */
  viewerName?: string | undefined;
  /**
   * The signed-in actor id, for byline sidedness — the viewer's identity
   * header sits left, everyone else's right. Same source as `viewerName`,
   * never a separate fetch. Role is NOT a substitute: in a shared thread
   * another human's turn is also `role: 'user'`, so sidedness must compare
   * author identity.
   */
  viewerId?: string | undefined;
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
  newMutationId = defaultMutationId,
  onOpenEntity,
  resolveEntity,
  connections,
  assetHref,
  attach,
  skillOptions,
  sessions,
  tasks,
  tab: tabProp,
  onTab,
  selectedEntityId = null,
  onSelectEntity,
  onShowChat,
  onNewTask,
  newTaskUnavailable,
  onRunTask,
  renderTabList,
  centerOverride,
  slots,
  viewerName,
  viewerId,
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
        /* COLD START (ruled 2026-08-15): the most recent conversation opens
           itself, so the right pane is never empty on launch. `listThreads`
           returns most-recent-first; no conversations at all lands on the new
           conversation composer, which is still a conversation.

           The ruling's follow-on — auto-open silently marks the most recent
           read — DOES NOT BITE YET, and the reason is worth writing down:
           there is no per-conversation unread anywhere to mark.
           `ChatThreadSummary` carries none, the only per-viewer unseen the
           server exposes is KIND-level (`spaces.counts`), and `read_marks` is
           not written per thread. When per-thread unread lands, the accepted
           default is that this auto-open marks read like any other open — see
           the panel's block comment. */
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
   * THE THREAD'S THREE WRITE-ONCE FACTS, as the composer's drop-ups read them.
   *
   * A configured thread shows what it was STARTED with and refuses edits; a new
   * thread shows the pending selection and takes them. The two lists carry the
   * config's own label when the catalog no longer offers it — a teammate can
   * leave the space and a model can be retired from the launch catalog after a
   * thread pinned it, and a trigger reading "—" would hide the very fact the
   * thread is pinned to.
   */
  const pinned = activeConfig !== null;
  const shownTeammateId = activeConfig?.teammateId ?? teammateId;
  const shownModelId = activeConfig?.model ?? modelId;
  const shownMode = activeConfig?.mode ?? chatMode;
  const teammateOptions = useMemo(() => {
    const base = teammates.map((teammate) => ({
      id: teammate.id,
      label: teammate.label,
      actor: { id: teammate.id, avatar: teammate.avatar },
    }));
    return activeConfig && !base.some((option) => option.id === activeConfig.teammateId)
      ? [{
          id: activeConfig.teammateId,
          label: activeConfig.teammateLabel,
          actor: { id: activeConfig.teammateId, avatar: null },
        }, ...base]
      : base;
  }, [teammates, activeConfig]);
  const modelOptions = useMemo(() => {
    const base = models.map((model) => ({
      id: model.model,
      label: model.label,
      hint: model.provider,
    }));
    return activeConfig && !base.some((option) => option.id === activeConfig.model)
      ? [{ id: activeConfig.model, label: activeConfig.modelLabel }, ...base]
      : base;
  }, [models, activeConfig]);

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

  /* THREE TABS, one population each (task 01a006f8 D1 — the merged R4 column
     is retired). The tab is CONTROLLED when the host owns it (D15 per-space
     persistence; D11's spawn flip arrives from outside) and uncontrolled on
     standalone mounts, opening on Chats. D6: switching a tab is BROWSING — it
     re-lists this column and touches nothing else on the screen. */
  const [innerTab, setInnerTab] = useState<HomeTab>('chats');
  const tab = tabProp ?? innerTab;
  const setTab = useCallback(
    (next: HomeTab) => {
      if (onTab) onTab(next);
      else setInnerTab(next);
    },
    [onTab],
  );

  /* ONE search box, scoped to the active tab (D4). It filters WHAT IS READ —
     there is no server-side search behind it, and its labels must not claim
     one. The query survives a tab switch: it is one box, not three. */
  const [findQuery, setFindQuery] = useState('');
  const threadGroups = useMemo(
    () => (tab === 'chats' ? composeThreadColumn(threads, findQuery) : []),
    [tab, threads, findQuery],
  );
  const sessionGroups = useMemo(
    () => (tab === 'sessions' ? composeSessionColumn(sessions ?? [], findQuery) : []),
    [tab, sessions, findQuery],
  );
  const taskRows = useMemo(
    () => (tab === 'tasks' ? filterTaskRows(tasks ?? [], findQuery) : []),
    [tab, tasks, findQuery],
  );
  const activeTabEmpty =
    tab === 'chats'
      ? threadGroups.length === 0
      : tab === 'sessions'
        ? sessionGroups.length === 0
        : taskRows.length === 0;
  /** D9 — the honest highlight: chat rows are active only while the chat
   *  OCCUPIES region B; an entity selection extinguishes them rather than
   *  fabricating an active row on a tab the selection is not from. */
  const chatOccupiesCenter = centerOverride === undefined || centerOverride === null;
  /** The host's whole-tab takeover: the workspace list panel, with its own
   *  search — so this screen's find box stands down for that tab. */
  const hostedList = renderTabList?.(tab) ?? null;

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
      {/*
        THE NAVIGATION AXIS (task 01a006f8, 2026-08-16, superseding R4's
        merged list). This panel is the full inventory AND the only selector,
        as one time-grouped THREE-TAB column: Chats | Tasks | Sessions (D1,
        order re-ruled 2026-08-16).
        Switching a tab is BROWSING — it re-lists this column only (D6);
        clicking a row is SELECTING — it puts that entity in region B (D7).
        The two ＋ buttons above the tabs are the single exception to D6:
        each takes region B AND switches this column to its own tab (D10).

        NO COUNTS ON THE TAB LABELS (D16): the only number obtainable is
        "how many are loaded", which would read as a total — absent ≠ zero.

        UNREAD IS NOT DRAWN, AND ITS ABSENCE IS THE HONEST STATE. The ruling
        puts unread state in this panel and nowhere else; what it could not
        know is that no per-conversation unread exists to put here.
        `ChatThreadSummary` has no unread field, the only per-viewer unseen
        the server exposes is KIND-level (`KindCounts.unseen` from
        `spaces.counts`), and `unreadCount` belongs to `channel` ENTITIES,
        which these threads are not. The `read_marks` table can express it —
        nothing writes or reads it per thread yet.

        So the work is a server change (a per-thread unseen read plus a
        mark-read write on open), not a relocation of state that already
        exists, and it is deliberately NOT done here: a dot rendered against
        no measurement would be the fabricated zero this codebase refuses
        everywhere else — the same reason the tab bar's bell carries no count.
        When it lands, the accepted default is that the cold-start auto-open
        marks read like any other open.
      */}
      <aside className="tch-sidebar" aria-label="Tasks, chats and sessions">
        {/* D2: two constant buttons. No New session — a session is created by
            RUNNING a task (D11); the old permanently-disabled button is gone. */}
        <div className="tch-sidebar__actions">
          <button
            type="button"
            className="tch-new"
            onClick={() => {
              setSelectedRootId(null);
              setDetail(null);
              stoppedRootRef.current = null;
              setPhase('idle');
              setSubmitError(null);
              /* D10: takes region B (back to the chat's new-conversation
                 composer) AND switches the column to its own tab. */
              onShowChat?.();
              setTab('chats');
            }}
          >
            <span aria-hidden>＋</span> New chat
          </button>
          <button
            type="button"
            className="tch-new tch-new--task"
            aria-disabled={onNewTask ? undefined : 'true'}
            title={
              onNewTask
                ? 'Create an Untitled task and open it — type its name there'
                : newTaskUnavailable
                  ? `${newTaskUnavailable.cause} — ${newTaskUnavailable.remedy}`
                  : 'Creating tasks isn’t wired on this surface'
            }
            onClick={
              onNewTask
                ? () => {
                    /* D3: create immediately — the host's useNewTask flow
                       makes the entity, selects it into B (title focused)
                       and, per D10, we land on its tab. */
                    onNewTask();
                    setTab('tasks');
                  }
                : (event) => event.preventDefault()
            }
          >
            <span aria-hidden>＋</span> New task
          </button>
        </div>
        {/* Chats | Tasks | Sessions (re-ruled order). Labels only (D16). */}
        <div className="tch-tabs" role="tablist" aria-label="Home lists">
          {HOME_TAB_STRIP.map((entry) => (
            <button
              key={entry.tab}
              type="button"
              role="tab"
              aria-selected={tab === entry.tab}
              className={`tch-tab ${tab === entry.tab ? 'tch-tab--active' : ''}`}
              onClick={() => setTab(entry.tab)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {hostedList == null ? (
          <input
            type="search"
            className="tch-find"
            placeholder={FIND_COPY[tab].placeholder}
            aria-label={`${FIND_COPY[tab].label} — filters what is already loaded`}
            title={`Filters the ${FIND_COPY[tab].noun} already loaded here; this is not a server search`}
            value={findQuery}
            onChange={(event) => setFindQuery(event.target.value)}
          />
        ) : null}
        {hostedList != null ? (
          /* The workspace's own EntityListPanel, given the tab's space —
             tree, tiles, lifecycle tiers, sort and search are all its own. */
          <div className="tch-panel-host" data-testid="tch-hosted-list">
            {hostedList}
          </div>
        ) : (
        <div className="tch-thread-list">
          {tab === 'chats' && loading ? (
            <p className="tch-hollow">Reading conversations…</p>
          ) : null}
          {!(tab === 'chats' && loading) && activeTabEmpty ? (
            <p className="tch-hollow">
              {findQuery.trim() ? 'Nothing loaded here matches.' : EMPTY_COPY[tab](
                tab === 'sessions' ? sessions !== undefined : tab !== 'tasks' || tasks !== undefined,
              )}
            </p>
          ) : null}
          {tab === 'chats' && port.threadListUnavailableReason ? (
            <p className="tch-thread-refusal">{port.threadListUnavailableReason}</p>
          ) : null}

          {tab === 'chats'
            ? threadGroups.map((group) => (
                <div key={group.label} className="tch-group" role="group" aria-label={group.label}>
                  <span className="tch-group__label">{group.label}</span>
                  {group.rows.map((thread) => (
                    <button
                      type="button"
                      key={thread.rootId}
                      className="tch-thread"
                      /* D9: honest only while the chat occupies B. */
                      data-active={
                        (chatOccupiesCenter && thread.rootId === selectedRootId) || undefined
                      }
                      onClick={() => {
                        /* D7: selecting a chat puts the conversation in B. */
                        setSelectedRootId(thread.rootId);
                        onShowChat?.();
                      }}
                    >
                      <span className="tch-thread__title">
                        {thread.state === 'streaming' ? (
                          <span className="tch-thread__live" title="Agent is working" aria-label="Agent is working" />
                        ) : null}
                        {thread.title}
                      </span>
                      <span className="tch-thread__preview">{thread.preview}</span>
                      <span className="tch-thread__meta">
                        <span className="tch-mode-chip">{thread.config.mode}</span>
                        <span>{thread.config.teammateLabel}</span>
                        <span aria-hidden>·</span>
                        <span>{thread.config.modelLabel}</span>
                        <Timestamp at={thread.updatedAt} />
                      </span>
                    </button>
                  ))}
                </div>
              ))
            : null}

          {tab === 'sessions'
            ? sessionGroups.map((group) => (
                <div key={group.label} className="tch-group" role="group" aria-label={group.label}>
                  <span className="tch-group__label">{group.label}</span>
                  {group.rows.map((session) => (
                    /* The badge sub-row is a SIBLING of the row button — PR
                       chips carry real links, which cannot nest in a button.
                       The tile wrapper carries the hover/active visuals so
                       button and badges read as one row. */
                    <div
                      key={session.id}
                      className="tch-tile"
                      data-active={session.id === selectedEntityId || undefined}
                    >
                    <button
                      type="button"
                      className="tch-thread tch-thread--session"
                      data-active={session.id === selectedEntityId || undefined}
                      title={
                        onSelectEntity
                          ? 'Open this session here'
                          : 'Opening sessions isn’t wired on this surface'
                      }
                      aria-disabled={onSelectEntity ? undefined : 'true'}
                      onClick={
                        onSelectEntity
                          ? () => onSelectEntity(session.id)
                          : (event) => event.preventDefault()
                      }
                    >
                      <span className="tch-thread__title">
                        <span className="tch-thread__glyph" aria-hidden>❯_</span>
                        {session.title}
                      </span>
                      <span className="tch-thread__meta">
                        <span className={`tch-session-word tch-session-word--${session.tone}`}>
                          {session.live ? <span className="tch-thread__live" aria-hidden /> : null}
                          {session.statusWord}
                        </span>
                        {session.detail ? (
                          <>
                            <span aria-hidden>·</span>
                            <span>{session.detail}</span>
                          </>
                        ) : null}
                        {session.viewOnly ? (
                          <span
                            className="tch-viewonly"
                            title="Another member’s session — you can see it; only the owner can attach to its terminal"
                          >
                            view only
                          </span>
                        ) : null}
                        <Timestamp at={session.updatedAt} />
                      </span>
                    </button>
                    {session.badges ? (
                      <span className="tch-thread__badges">{session.badges}</span>
                    ) : null}
                    </div>
                  ))}
                </div>
              ))
            : null}

          {tab === 'tasks'
            ? taskRows.map((task) => (
                /* A row and its Run are SIBLINGS — a button cannot nest a
                   button, and Run must not be the row's whole surface. The
                   badge sub-row (PR chips, entity counts) is a sibling too,
                   for the same reason: chips carry real links. */
                <div
                  key={task.id}
                  className="tch-tile"
                  data-active={task.id === selectedEntityId || undefined}
                >
                <div className="tch-task-row">
                  <button
                    type="button"
                    className="tch-thread tch-thread--task"
                    data-active={task.id === selectedEntityId || undefined}
                    title={
                      onSelectEntity
                        ? 'Open this task here'
                        : 'Opening tasks isn’t wired on this surface'
                    }
                    aria-disabled={onSelectEntity ? undefined : 'true'}
                    onClick={
                      onSelectEntity
                        ? () => onSelectEntity(task.id)
                        : (event) => event.preventDefault()
                    }
                  >
                    <span className="tch-thread__title">{task.title}</span>
                    <span className="tch-thread__meta">
                      <span className={`tch-session-word tch-session-word--${task.tone}`}>
                        {task.statusWord}
                      </span>
                      {task.detail ? (
                        <>
                          <span aria-hidden>·</span>
                          <span>{task.detail}</span>
                        </>
                      ) : null}
                      <Timestamp at={task.updatedAt} />
                    </span>
                  </button>
                  {onRunTask ? (
                    <button
                      type="button"
                      className="tch-run"
                      title="Run — configure and launch a session on this task"
                      aria-label={`Run ${task.title}`}
                      onClick={() => onRunTask(task.id)}
                    >
                      ◔ Run ▸
                    </button>
                  ) : (
                    <DisabledIconControl
                      label={`Run ${task.title}`}
                      glyph="▸"
                      reason={{
                        cause: 'Launching isn’t wired on this surface',
                        remedy: 'open the task in the workspace to run it',
                      }}
                    />
                  )}
                </div>
                {task.badges ? (
                  <span className="tch-thread__badges">{task.badges}</span>
                ) : null}
                </div>
              ))
            : null}
        </div>
        )}
        <footer className="tch-sidebar__foot">
          {slots ? (
            slots.total >= UNCAPPED_SESSION_TOTAL ? (
              /* An uncapped node reports int4-max as its total (the spawn
                 guard has no word for "unlimited" — execution-handlers.ts,
                 UNLIMITED_SESSION_CAP). A fraction of a sentinel reads as
                 "9/2147483647"; the honest render is the used count alone. */
              <div className="tch-slots" title={`${slots.used} node session slots in use — this node has no session cap`}>
                <span className="tch-slots__label">session slots</span>
                <span className="tch-slots__nums">{slots.used} in use · no cap</span>
              </div>
            ) : (
              <div
                className="tch-slots"
                title={`${slots.used} of ${slots.total} node session slots in use`}
              >
                <span className="tch-slots__label">session slots</span>
                <span className="tch-slots__bar" aria-hidden>
                  <span
                    className="tch-slots__fill"
                    style={{ width: `${slots.total > 0 ? Math.min(100, (slots.used / slots.total) * 100) : 0}%` }}
                  />
                </span>
                <span className="tch-slots__nums">{slots.used}/{slots.total}</span>
              </div>
            )
          ) : null}
        </footer>
      </aside>

      {/*
        REGION B — the selection (D5/D7). The conversation pane is B's CHAT
        occupant; when a task or session is selected the host hands
        `centerOverride` and this pane goes display:none while staying
        MOUNTED (D8) — unmounting it would tear down a streaming thread.
        There is still no working-set tab strip above it: the left column is
        the only selector.
      */}
      {centerOverride != null ? (
        <section className="tch-center" aria-label="Selection" data-testid="tch-center-override">
          {centerOverride}
        </section>
      ) : null}
      <section
        className="tch-conversation"
        aria-label="Conversation"
        data-hidden={centerOverride != null ? 'true' : undefined}
        hidden={centerOverride != null || undefined}
        /* The new-conversation state centres greeting + composer as one
           invitation (ref mockup 02); an open thread pins the composer to
           the bottom. Layout only — the CSS pair reads this. */
        data-empty={newThread || undefined}
      >
        <header className="tch-conversation__head">
          <div className="tch-title">
            <strong>{detail?.summary.title ?? 'New conversation'}</strong>
            <span>{activeConfig ? `with ${activeConfig.teammateLabel}` : 'Work with your graph from one place'}</span>
          </div>
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
              {/* The entities this thread referenced and the relations they
                  ACTUALLY hold — the conversation selects, it is not a node. */}
              <ChatEntityGraph
                turns={detail.turns}
                suppressEntityIds={ownMessageIds}
                connections={connections}
                resolveEntity={resolveEntity}
                onOpenEntity={onOpenEntity}
              />
              {detail.turns.map((turn) => (
                <Turn
                  key={turn.messageId}
                  turn={turn}
                  mode={detail.summary.config.mode}
                  pending={turn.messageId === pendingTurnId}
                  viewerId={viewerId}
                  onOpenEntity={onOpenEntity}
                  resolveEntity={resolveEntity}
                  suppressEntityIds={ownMessageIds}
                  assetHref={assetHref}
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
              <h1>{greetingLine(viewerName)}</h1>
              <p>New conversation — pick a mode and a teammate, or just type. The agent uses graph tools and keeps every turn in the thread.</p>
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
              {/* The thread's configuration lives HERE and nowhere else. NO
                  `auto` teammate on purpose: there is no routing pipeline that
                  could honour it, and an option that promises routing nobody
                  built is exactly the fabrication this surface refuses. */}
              <span className="tch-picks">
                <ComposerSelect
                  label="Chat mode"
                  testId="tch-mode"
                  options={MODE_OPTIONS}
                  value={shownMode}
                  onChange={(id) => setChatMode(id as ChatMode)}
                  disabled={pinned}
                  emptyNote="No chat mode is available."
                />
                <ComposerSelect
                  label="Chat teammate"
                  testId="tch-teammate"
                  options={teammateOptions}
                  value={shownTeammateId}
                  onChange={(id) => setTeammateId(id as EntityId)}
                  disabled={pinned}
                  emptyNote="No agent teammate is available in this space."
                />
                <ComposerSelect
                  label="Chat model"
                  testId="tch-model"
                  options={modelOptions}
                  value={shownModelId}
                  onChange={setModelId}
                  disabled={pinned}
                  emptyNote="No model is available from the launch catalog."
                />
                {pinned ? <span className="tch-pinned">pinned for this thread</span> : null}
              </span>
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

/**
 * The composer's mode drop-up.
 *
 * Every mode carries the same tool surface (`toolPermission` in @tm8/mcp); the
 * mode states how the teammate works, not what it may touch. So these hints
 * describe intent and must never promise safety — the earlier "changes
 * nothing" copy on ask/explain/plan would now be a lie, because those modes
 * can edit the thread checkout and mutate the graph like any other.
 *
 * The hints are the menu rows' second line rather than a sentence beside a chip
 * row: read on the row it describes, each one is legible; parked at the end of
 * the bar, only the selected mode's was, and it set the composer's width.
 */
const MODE_OPTIONS: readonly { id: ChatMode; label: string; hint: string }[] = [
  { id: 'ask', label: 'ask', hint: 'answers your question; acts only when you ask it to' },
  { id: 'explain', label: 'explain', hint: 'walks the reasoning with inline diagrams, graphs and code' },
  { id: 'plan', label: 'plan', hint: 'shapes work into steps and a durable plan to approve' },
  { id: 'build', label: 'build', hint: 'does the work; edits this thread’s checkout for real' },
  { id: 'orchestrate', label: 'orchestrate', hint: 'dispatches and steers worker sessions' },
];

function greetingLine(viewerName?: string): string {
  const hour = new Date().getHours();
  const daypart = hour < 5 ? 'Evening' : hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';
  return viewerName ? `${daypart}, ${viewerName}.` : `${daypart}.`;
}

/** The server's "no cap" sentinel: an uncapped node saturates its session cap
 *  at int4 max because the spawn guard cannot express "unlimited"
 *  (`UNLIMITED_SESSION_CAP`, server execution-handlers.ts). A total at or
 *  above it is a sentinel, not a measurement — never a denominator. */
const UNCAPPED_SESSION_TOTAL = 2_147_483_647;

/** D1's strip. ORDER re-ruled by Subhang 2026-08-16 ("it should be
 *  chats | tasks | sessions"), superseding D1's Tasks-first order. Chats
 *  leads — it is also the default tab, so the first visit opens on the
 *  first tab. Labels only — no counts (D16). */
const HOME_TAB_STRIP: readonly { tab: HomeTab; label: string }[] = [
  { tab: 'chats', label: 'Chats' },
  { tab: 'tasks', label: 'Tasks' },
  { tab: 'sessions', label: 'Sessions' },
];

/** D4: the one search box, worded per tab and never claiming server search. */
const FIND_COPY: Record<HomeTab, { placeholder: string; label: string; noun: string }> = {
  tasks: { placeholder: 'Find a task…', label: 'Find a task', noun: 'tasks' },
  chats: { placeholder: 'Find a conversation…', label: 'Find a conversation', noun: 'conversations' },
  sessions: { placeholder: 'Find a session…', label: 'Find a session', noun: 'sessions' },
};

/** Empty states: an unwired tab (host passed nothing) is NOT an empty list. */
const EMPTY_COPY: Record<HomeTab, (wired: boolean) => string> = {
  tasks: (wired) =>
    wired ? 'No tasks yet. ＋ New task creates one.' : 'Tasks aren’t wired on this surface.',
  chats: () => 'No conversations yet. Start with the composer.',
  sessions: (wired) =>
    wired
      ? 'No sessions yet. Run a task to launch one.'
      : 'Sessions aren’t wired on this surface.',
};

/**
 * Day buckets in the VIEWER's local time — Today, Yesterday, then Earlier —
 * the same grouping the merged column drew, now applied per tab.
 */
function bucketByDay<T>(rows: readonly { at: string; row: T }[]): { label: string; rows: T[] }[] {
  const sorted = [...rows].sort((a, b) => b.at.localeCompare(a.at));
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const today = startOfDay(new Date());
  const dayMs = 24 * 60 * 60 * 1000;

  const buckets: { label: string; rows: T[] }[] = [];
  for (const entry of sorted) {
    const at = new Date(entry.at);
    const stamp = Number.isNaN(at.getTime()) ? 0 : startOfDay(at);
    const label = stamp >= today ? 'Today' : stamp >= today - dayMs ? 'Yesterday' : 'Earlier';
    const existing = buckets.find((bucket) => bucket.label === label);
    if (existing) existing.rows.push(entry.row);
    else buckets.push({ label, rows: [entry.row] });
  }
  return buckets;
}

function composeThreadColumn(
  threads: readonly ChatThreadSummary[],
  query: string,
): { label: string; rows: ChatThreadSummary[] }[] {
  const q = query.trim().toLowerCase();
  return bucketByDay(
    threads
      .filter(
        (thread) =>
          !q ||
          `${thread.title} ${thread.preview} ${thread.config.teammateLabel}`
            .toLowerCase()
            .includes(q),
      )
      .map((thread) => ({ at: thread.updatedAt, row: thread })),
  );
}

function composeSessionColumn(
  sessions: readonly ChatSessionRow[],
  query: string,
): { label: string; rows: ChatSessionRow[] }[] {
  const q = query.trim().toLowerCase();
  return bucketByDay(
    sessions
      .filter(
        (session) =>
          !q ||
          `${session.title} ${session.detail ?? ''} ${session.statusWord}`
            .toLowerCase()
            .includes(q),
      )
      .map((session) => ({ at: session.updatedAt, row: session })),
  );
}

/** Tasks keep the HOST's order (open-first, then recency) — no day buckets,
 *  because interleaving open-first with date groups would lie about one axis. */
function filterTaskRows(tasks: readonly ChatTaskRow[], query: string): ChatTaskRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...tasks];
  return tasks.filter((task) =>
    `${task.title} ${task.statusWord} ${task.detail ?? ''}`.toLowerCase().includes(q),
  );
}

function Turn({
  turn,
  mode,
  pending,
  viewerId,
  onOpenEntity,
  resolveEntity,
  suppressEntityIds,
  assetHref,
}: {
  turn: ChatThreadDetail['turns'][number];
  mode: ChatMode;
  /** This turn is the one the pulse is already announcing. */
  pending?: boolean;
  viewerId?: string | undefined;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  resolveEntity?: ChatEntityResolver | undefined;
  suppressEntityIds?: ReadonlySet<string> | undefined;
  assetHref?: ((fileEntityId: EntityId) => string | null) | undefined;
}) {
  const label = turn.author?.displayName ?? (turn.role === 'assistant' ? 'Agent' : 'You');
  const actorId = turn.author?.id ?? `chat-${turn.role}`;
  const agent = turn.author?.isAgent ?? turn.role === 'assistant';
  /**
   * Sidedness is decided by AUTHOR IDENTITY, not role — in a shared thread
   * another human's turn is also `role: 'user'` and must land right. A null
   * author on a user turn is your own message rendered optimistically before
   * the server echo; treating it as self prevents a visible left→right flip
   * on send. No `viewerId` degrades to the role heuristic — never crash,
   * never guess.
   */
  const isSelf = viewerId
    ? turn.author
      ? turn.author.id === viewerId
      : turn.role === 'user'
    : turn.role === 'user';
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
    <article className="tch-turn" data-role={turn.role} data-mode={mode} data-self={isSelf ? 'true' : 'false'}>
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
        assetHref={assetHref}
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
