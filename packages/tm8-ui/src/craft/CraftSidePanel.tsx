/**
 * THE CRAFT'S 2ND PANEL (Craft redesign §3, "2nd panel — chat/session
 * driven"): the column beside the rail while a craft is open.
 *
 *   Title
 *   [chats] [▾ chats and sessions] [＋ New chat] [＋ New session]
 *   ─────────────────────────────────────────────────────────────
 *   the selected item: a chat → the craft chat pane
 *                      a session → its LIVE terminal
 *
 *  · ONE list, newest first: the craft chats about this craft and the work
 *    sessions spawned on it (`listCraftSessions`).
 *  · ＋ New chat opens the chat composer; the first send starts a chat ABOUT
 *    the craft. ＋ New session spawns on the craft with its default teammate
 *    (`craftSpawnInput`), records the session ABOUT the craft, and shows the
 *    new terminal.
 *  · The chat pane stays mounted while a session is shown, so its thread list
 *    keeps feeding the dropdown and its draft survives the round trip.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import type { ChatHomeL2Bridge } from '../chat-home/real-port';
import type { ChatThreadSummary } from '../chat-home/types';
import type { TriggerOption } from '../rich-input';
import { KindIcon } from '../domain';
import { Timestamp } from '../kit';
import type { WorkspaceGateHandles } from '../tab-workspace';
import { EntityTabBody, getKindAdapter, type WorkspaceRuntime } from '../tab-workspace/embed';
import { CraftChatPane } from './CraftChatPane';
import { craftSpawnInput, listCraftSessions, markSessionAboutCraft, type CraftSessionRow } from './craft-sessions';
import type { ToolNoteCall } from './turn-notes';
import { useEmbeddedTab } from './use-embedded-tab';
import './craft-side-panel.css';

export interface CraftSidePanelProps {
  seam: Seam;
  spaceId: SpaceId;
  nodeKey: string;
  craftId: EntityId;
  title: string;
  /** The Workspace handles: present ⇒ a session renders its live terminal and ＋ New session can spawn. */
  gate?: WorkspaceGateHandles | undefined;
  /** The craft screen's private runtime, where a session's tab record lives. */
  runtime: WorkspaceRuntime;
  bridge?: ChatHomeL2Bridge | undefined;
  skillOptions?: readonly TriggerOption[] | undefined;
  viewerName?: string | undefined;
  viewerId?: string | undefined;
  composerSeed?: { text: string; nonce: number } | undefined;
  onPrompt(text: string): void;
  toolNote?: ((call: ToolNoteCall) => ReactNode) | undefined;
  onOpenEntity(id: EntityId): void;
  onNotice?: ((text: string) => void) | undefined;
}

/** What the body shows: a chat (null = the new-chat composer) or a session. */
type Selection = { type: 'chat'; id: EntityId | null } | { type: 'session'; id: EntityId };

/** One row of the shared list. */
type CraftItem =
  | { type: 'chat'; id: EntityId; title: string; at: string; thread: ChatThreadSummary }
  | { type: 'session'; id: EntityId; title: string; at: string; session: CraftSessionRow };

const newestFirst = (a: CraftItem, b: CraftItem) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);

export function CraftSidePanel(props: CraftSidePanelProps) {
  const { seam, craftId, gate, runtime, onNotice } = props;

  /* -- the chats: reported by the chat pane ------------------------------ */
  const [threads, setThreads] = useState<readonly ChatThreadSummary[]>([]);
  const [allThreads, setAllThreads] = useState<readonly ChatThreadSummary[]>([]);
  const onThreadsChange = useCallback((scoped: readonly ChatThreadSummary[], all: readonly ChatThreadSummary[]) => {
    setThreads(scoped);
    setAllThreads(all);
  }, []);

  /* -- the sessions: two edge reads, re-read on demand -------------------- */
  const [sessions, setSessions] = useState<readonly CraftSessionRow[] | null>(null);
  const readSeq = useRef(0);
  const refreshSessions = useCallback(() => {
    const seq = ++readSeq.current;
    void listCraftSessions(seam, craftId).then(
      (rows) => seq === readSeq.current && setSessions(rows),
      () => seq === readSeq.current && setSessions((was) => was ?? []),
    );
  }, [seam, craftId]);
  useEffect(() => {
    setSessions(null);
    refreshSessions();
  }, [refreshSessions]);

  const items = useMemo<CraftItem[]>(() => {
    const chats: CraftItem[] = threads.map((thread) => ({
      type: 'chat',
      id: thread.rootId,
      title: thread.title,
      at: thread.updatedAt,
      thread,
    }));
    const runs: CraftItem[] = (sessions ?? []).map((session) => ({
      type: 'session',
      id: session.id,
      title: session.title,
      at: session.at,
      session,
    }));
    return [...chats, ...runs].sort(newestFirst);
  }, [threads, sessions]);

  /* -- the selection ------------------------------------------------------- */
  const [selection, setSelection] = useState<Selection>({ type: 'chat', id: null });
  /** What the chat pane was asked for; `undefined` keeps its cold start. */
  const [requestedThreadId, setRequestedThreadId] = useState<EntityId | null | undefined>(undefined);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const showChat = useCallback((id: EntityId | null) => {
    setRequestedThreadId(id);
    setSelection({ type: 'chat', id });
  }, []);
  const showSession = useCallback((id: EntityId) => setSelection({ type: 'session', id }), []);

  /* The chat surface resolved a selection (a send started a chat, or the
     host's request settled). It moves the body only while a chat is shown. */
  const adoptSelection = useCallback((id: EntityId | null) => {
    setRequestedThreadId((asked) => (asked === undefined ? asked : id));
    if (selectionRef.current.type === 'chat') setSelection({ type: 'chat', id });
  }, []);

  /* Opening a craft opens ITS newest item — never the space's most recent
     thread, which could be about anything. Waits for both lists, so "nothing
     here" is not answered before anything was read. */
  const resolvedForRef = useRef<EntityId | null>(null);
  useEffect(() => {
    if (resolvedForRef.current === craftId || sessions === null || allThreads.length === 0) return;
    resolvedForRef.current = craftId;
    const first = items[0];
    if (first?.type === 'session') showSession(first.id);
    else showChat(first?.id ?? null);
  }, [craftId, sessions, allThreads, items, showChat, showSession]);

  /* -- ＋ New session ------------------------------------------------------- */
  const [spawning, setSpawning] = useState(false);
  const spawnRefusal = !gate
    ? 'Sessions launch from the app.'
    : gate.data.launch.teammates.length === 0
      ? 'This space has no teammate to run a session as.'
      : null;
  const newSession = () => {
    if (!gate || spawning) return;
    const input = craftSpawnInput({
      spaceId: gate.data.spaceId,
      craftId,
      title: props.title,
      teammates: gate.data.launch.teammates,
      projects: gate.data.launch.projects,
    });
    if (!input) {
      onNotice?.('This space has no teammate to run a session as.');
      return;
    }
    setSpawning(true);
    void gate.data
      .spawn(input)
      .then((id) => {
        /* Shown at once: the list re-reads, but the terminal does not wait on it. */
        setSessions((was) => [
          { id, title: input.title ?? props.title, status: null, at: new Date().toISOString() },
          ...(was ?? []).filter((row) => row.id !== id),
        ]);
        showSession(id);
        void markSessionAboutCraft(seam, id, craftId).then((ok) => {
          if (!ok) onNotice?.('The session started, but could not be linked to this craft, so it cannot arrange your craft tabs.');
          refreshSessions();
        });
      })
      .catch((error: unknown) =>
        onNotice?.(`Session refused: ${String((error as { message?: string })?.message ?? error)}`),
      )
      .finally(() => setSpawning(false));
  };

  const current: CraftItem | null =
    selection.id === null ? null : items.find((item) => item.type === selection.type && item.id === selection.id) ?? null;
  const chatTitle =
    selection.type === 'chat' && selection.id
      ? allThreads.find((thread) => thread.rootId === selection.id)?.title ?? 'Chat'
      : null;
  const pickerLabel =
    selection.type === 'session' ? current?.title ?? 'Session' : chatTitle ?? 'New chat';

  return (
    <section className="crf-side" aria-label={`${props.title || 'Craft'} chats and sessions`} data-testid="crf-side">
      <header className="crf-side__head" data-testid="crf-side-head">
        <h2 className="crf-side__title" data-testid="crf-side-title" title={props.title}>
          {props.title || 'Untitled craft'}
        </h2>
        <div className="crf-side__bar">
          <span className="crf-side__icon" title="Chats and sessions" aria-hidden data-testid="crf-side-chats-icon">
            <KindIcon kind="chat" size={16} />
          </span>
          <ItemsPicker
            label={pickerLabel}
            items={items}
            loading={sessions === null}
            selection={selection}
            onOpen={refreshSessions}
            onPick={(item) => (item.type === 'chat' ? showChat(item.id) : showSession(item.id))}
          />
          <button
            type="button"
            className="dsn-btn crf-side__new"
            data-testid="crf-new-chat"
            title="New chat"
            onClick={() => showChat(null)}
          >
            ＋ New chat
          </button>
          <button
            type="button"
            className="dsn-btn crf-side__new"
            data-testid="crf-new-session"
            title={spawnRefusal ?? 'New session'}
            disabled={spawnRefusal !== null || spawning}
            aria-busy={spawning || undefined}
            onClick={newSession}
          >
            ＋ New session
          </button>
        </div>
      </header>
      <div className="crf-side__body" hidden={selection.type !== 'chat'} data-testid="crf-side-chat">
        <CraftChatPane
          seam={seam}
          spaceId={props.spaceId}
          nodeKey={props.nodeKey}
          craftId={craftId}
          bridge={props.bridge}
          skillOptions={props.skillOptions}
          viewerName={props.viewerName}
          viewerId={props.viewerId}
          composerSeed={props.composerSeed}
          onPrompt={(text) => {
            if (selectionRef.current.type !== 'chat') showChat(null);
            props.onPrompt(text);
          }}
          toolNote={props.toolNote}
          onOpenEntity={props.onOpenEntity}
          requestedThreadId={requestedThreadId}
          onThreadsChange={onThreadsChange}
          onSelectionChange={adoptSelection}
        />
      </div>
      {selection.type === 'session' ? (
        <div className="crf-side__body" data-testid="crf-side-session">
          <SessionBody
            key={selection.id}
            sessionId={selection.id}
            title={current?.title ?? 'Session'}
            gate={gate}
            runtime={runtime}
            onOpenEntity={props.onOpenEntity}
            onClose={() => showChat(requestedThreadId ?? null)}
          />
        </div>
      ) : null}
    </section>
  );
}

/** A session, as the app shows one: its live terminal (the work_session body). */
function SessionBody({
  sessionId,
  title,
  gate,
  runtime,
  onOpenEntity,
  onClose,
}: {
  sessionId: EntityId;
  title: string;
  gate: WorkspaceGateHandles | undefined;
  runtime: WorkspaceRuntime;
  onOpenEntity(id: EntityId): void;
  onClose(): void;
}) {
  const tab = useEmbeddedTab(runtime, gate ? sessionId : null, gate ? 'work_session' : null);
  if (!gate) {
    return (
      <div className="dsn-plain" data-testid="crf-session-plain">
        <KindIcon kind="work_session" size={24} />
        <h2 className="dsn-plain__title">{title}</h2>
        <button type="button" className="dsn-btn" onClick={() => onOpenEntity(sessionId)}>
          Open
        </button>
      </div>
    );
  }
  if (!tab) return null;
  return (
    <div className="crf-side__session tws-entity-main tws-entity-host" data-testid="crf-session-terminal">
      <EntityTabBody
        tab={tab}
        adapter={getKindAdapter('work_session')}
        onOpenEntity={(id) => onOpenEntity(id as EntityId)}
        onClose={onClose}
      />
    </div>
  );
}

/** The ▾ list: the craft's chats and sessions, newest first. */
function ItemsPicker({
  label,
  items,
  loading,
  selection,
  onOpen,
  onPick,
}: {
  label: string;
  items: readonly CraftItem[];
  loading: boolean;
  selection: Selection;
  onOpen(): void;
  onPick(item: CraftItem): void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  /* Dismissal: outside press or Escape, captured so it wins over outer rungs. */
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className="crf-side__picker" ref={wrapRef}>
      <button
        type="button"
        className="crf-pick"
        data-testid="crf-side-picker"
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => {
          if (!open) onOpen();
          setOpen((was) => !was);
        }}
      >
        <span className="crf-pick__title">{label}</span>
        <span className="crf-pick__caret" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        <div className="crf-pop" role="menu" aria-label="Chats and sessions" data-testid="crf-side-pop">
          <div className="crf-pop__list">
            {items.length === 0 ? (
              <p className="crf-pop__hollow" role={loading ? 'status' : undefined} data-testid="crf-side-empty">
                {loading ? 'Loading…' : 'No chats or sessions on this craft yet. Start one with ＋ New chat or ＋ New session.'}
              </p>
            ) : (
              items.map((item) => (
                <button
                  type="button"
                  role="menuitem"
                  key={`${item.type}:${item.id}`}
                  className="crf-pop__row"
                  data-testid="crf-side-item"
                  data-type={item.type}
                  data-active={(item.type === selection.type && item.id === selection.id) || undefined}
                  onClick={() => {
                    setOpen(false);
                    onPick(item);
                  }}
                >
                  <span className="crf-pop__row-title">
                    <KindIcon kind={item.type === 'chat' ? 'chat' : 'work_session'} size={14} />
                    {item.type === 'chat' && item.thread.state === 'streaming' ? (
                      <span className="crf-pop__live" title="Agent is working" aria-label="Agent is working" />
                    ) : null}
                    {item.title}
                  </span>
                  <span className="crf-pop__row-meta">
                    {item.type === 'chat' ? (
                      <>
                        <span>{item.thread.config.teammateLabel}</span>
                        <span aria-hidden>·</span>
                        <span>{item.thread.config.modelLabel}</span>
                      </>
                    ) : (
                      <span>{item.session.status ? `Session · ${item.session.status}` : 'Session'}</span>
                    )}
                    <Timestamp at={item.at} />
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
