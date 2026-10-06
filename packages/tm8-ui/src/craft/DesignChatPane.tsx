/**
 * THE DESIGN'S CHAT PANE (Craft → Designs, D3 and change list item 10): the
 * left column of a design. Every chat here is ABOUT the design (an `about`
 * edge written by `chat.start`) with the mode PINNED to craft; the agent
 * picks which page to work on. No per-page chats.
 *
 * The pane's own header holds the thread picker over the chats about this
 * design and `+ New chat`. The chat surface is hosted SOLO — the picker is
 * its thread column — and `routeThreadId` is authoritative.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { createChatHomePortFromSeam, type ChatHomeL2Bridge } from '../chat-home/real-port';
import { ChatHomeSurface } from '../chat-home/ChatHomeSurface';
import type { ChatThreadSummary } from '../chat-home/types';
import type { TriggerOption } from '../rich-input';
import { Timestamp } from '../kit';
import type { ToolNoteCall } from './turn-notes';

export const EXAMPLE_PROMPTS: readonly string[] = [
  'Plan a launch for our new pricing page: research, copy, design review and the ship checklist.',
  'Break "migrate auth to passkeys" into tasks, who should own each, and the docs they produce.',
  'Design a weekly research digest: a teammate that reads sources, writes a doc, and remembers what it covered.',
];

/** One frozen empty set, so "no chats yet" never mints a new identity. */
const EMPTY_ABOUT: ReadonlySet<EntityId> = new Set();

function sameIds(current: ReadonlySet<EntityId>, next: readonly EntityId[]): boolean {
  return current.size === next.length && next.every((id) => current.has(id));
}

export interface DesignChatPaneProps {
  seam: Seam;
  spaceId: SpaceId;
  nodeKey: string;
  designId: EntityId;
  bridge?: ChatHomeL2Bridge | undefined;
  skillOptions?: readonly TriggerOption[] | undefined;
  viewerName?: string | undefined;
  viewerId?: string | undefined;
  composerSeed?: { text: string; nonce: number } | undefined;
  onPrompt(text: string): void;
  toolNote?: ((call: ToolNoteCall) => ReactNode) | undefined;
  onOpenEntity(id: EntityId): void;
}

export function DesignChatPane({
  seam,
  spaceId,
  nodeKey,
  designId,
  bridge,
  skillOptions,
  viewerName,
  viewerId,
  composerSeed,
  onPrompt,
  toolNote,
  onOpenEntity,
}: DesignChatPaneProps) {
  /* The SAME port `ChatHomeSurface` builds from this seam — a pure factory. */
  const port = useMemo(() => createChatHomePortFromSeam(seam, bridge), [seam, bridge]);
  const [threads, setThreads] = useState<readonly ChatThreadSummary[]>([]);
  /** The resolved selection the chat surface reports; the picker's label. */
  const [activeThreadId, setActiveThreadId] = useState<EntityId | null>(null);
  /**
   * What the picker asked for. `undefined` = nothing asked yet (the surface
   * keeps its cold start); `null` = the explicit new-chat composer. It TRACKS
   * the resolved selection (`adoptSelection`), because `routeThreadId` is
   * compared by value and a stale request could never be re-asked.
   */
  const [requestedThreadId, setRequestedThreadId] = useState<EntityId | null | undefined>(undefined);

  /* Which chats are about the design: ONE incoming-edge read on the design,
     re-run when the thread list's membership changes (a send that started a
     chat wrote a new `about` edge). Settles rather than re-sets. */
  const [aboutDesign, setAboutDesign] = useState<ReadonlySet<EntityId>>(EMPTY_ABOUT);
  const threadKey = threads.map((thread) => thread.rootId).join(',');
  useEffect(() => {
    let live = true;
    void port.chatIdsAbout(designId).then((ids) => {
      if (live) setAboutDesign((current) => (sameIds(current, ids) ? current : new Set(ids)));
    });
    return () => {
      live = false;
    };
  }, [port, designId, threadKey]);

  const scoped = useMemo(
    () => threads.filter((thread) => thread.config.mode === 'craft' && aboutDesign.has(thread.rootId)),
    [threads, aboutDesign],
  );

  /* Opening a design opens ITS most recent chat, or the composer — never the
     space's most recent thread, which could be about anything. Waits for the
     list so "no chat here" is not answered before anything was read. */
  const resolvedForRef = useRef<EntityId | null>(null);
  useEffect(() => {
    if (resolvedForRef.current === designId || threads.length === 0) return;
    resolvedForRef.current = designId;
    const first = scoped[0]?.rootId ?? null;
    setRequestedThreadId(first);
    setActiveThreadId(first);
  }, [designId, threads, scoped]);

  /* The host driving its own selection moves both halves: the surface does
     not echo a selection the host pushed down. */
  const requestThread = useCallback((id: EntityId | null) => {
    setRequestedThreadId(id);
    setActiveThreadId(id);
  }, []);
  const adoptSelection = useCallback((id: EntityId | null) => {
    setActiveThreadId(id);
    setRequestedThreadId((asked) => (asked === undefined ? asked : id));
  }, []);

  return (
    <div className="dsn-chat">
      <div className="dsn-chat__head">
        <ThreadPicker threads={scoped} all={threads} selectedId={activeThreadId} onSelect={requestThread} />
        <button type="button" className="dsn-btn" data-testid="dsn-new-chat" onClick={() => requestThread(null)}>
          ＋ New chat
        </button>
      </div>
      <div className="crf-chat__body">
        <ChatHomeSurface
          seam={seam}
          spaceId={spaceId}
          nodeKey={nodeKey}
          bridge={bridge}
          /* Contextual chat: a new thread is ABOUT the design. */
          aboutId={designId}
          pinnedMode="craft"
          composerSeed={composerSeed}
          newThreadIntro={<DesignChatIntro onPrompt={onPrompt} />}
          toolNote={toolNote}
          skillOptions={skillOptions}
          onOpenEntity={onOpenEntity}
          soloConversation
          routeThreadId={requestedThreadId}
          onThreadsChange={setThreads}
          onSelectionChange={adoptSelection}
          viewerName={viewerName}
          viewerId={viewerId}
        />
      </div>
    </div>
  );
}

/** The thread picker: the craft chats about this design, newest first. */
function ThreadPicker({
  threads,
  all,
  selectedId,
  onSelect,
}: {
  threads: readonly ChatThreadSummary[];
  /** Every loaded thread: the open one is named even before its `about` edge is read back. */
  all: readonly ChatThreadSummary[];
  selectedId: EntityId | null;
  onSelect(id: EntityId): void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const current = all.find((thread) => thread.rootId === selectedId) ?? null;

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
    <div className="dsn-threads" ref={wrapRef}>
      <button
        type="button"
        className="crf-pick"
        data-testid="dsn-thread-picker"
        aria-haspopup="menu"
        aria-expanded={open}
        title={current ? current.title : 'Choose a chat about this design'}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="crf-pick__title">{current ? current.title : 'New chat'}</span>
        <span className="crf-pick__caret" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        <div className="crf-pop" role="menu" aria-label="Chats about this design" data-testid="dsn-thread-pop">
          <div className="crf-pop__list">
            {threads.length === 0 ? (
              <p className="crf-pop__hollow" data-testid="dsn-thread-empty">
                No chats about this design yet. Start one with ＋ New chat.
              </p>
            ) : (
              threads.map((thread) => (
                <button
                  type="button"
                  role="menuitem"
                  key={thread.rootId}
                  className="crf-pop__row"
                  data-active={thread.rootId === selectedId || undefined}
                  onClick={() => {
                    setOpen(false);
                    onSelect(thread.rootId);
                  }}
                >
                  <span className="crf-pop__row-title">
                    {thread.state === 'streaming' ? (
                      <span className="crf-pop__live" title="Agent is working" aria-label="Agent is working" />
                    ) : null}
                    {thread.title}
                  </span>
                  <span className="crf-pop__row-meta">
                    <span>{thread.config.teammateLabel}</span>
                    <span aria-hidden>·</span>
                    <span>{thread.config.modelLabel}</span>
                    <Timestamp at={thread.updatedAt} />
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

/**
 * The new-chat intro in a design — in place of the generic greeting, it says
 * what this agent does here. The examples land in the composer, unsent.
 */
export function DesignChatIntro({ onPrompt }: { onPrompt(text: string): void }) {
  return (
    <div className="crf-intro" data-testid="crf-chat-intro">
      <h1>Craft a design</h1>
      <p>
        Describe the work. The craft agent builds this design&apos;s pages — a graph that plans the tasks and who owns
        them, the docs, drawings and artifacts they need — and revises them with you. Nothing is created until you
        Run the design.
      </p>
      <ul className="crf-intro__prompts">
        {EXAMPLE_PROMPTS.slice(0, 2).map((prompt) => (
          <li key={prompt}>
            <button type="button" className="crf-teach__prompt" data-testid="crf-example" onClick={() => onPrompt(prompt)}>
              {prompt}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
