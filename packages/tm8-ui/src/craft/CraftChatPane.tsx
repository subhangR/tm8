/**
 * THE CRAFT'S CHAT PANE (Craft → Crafts, D3 and change list item 10): the
 * left column of a craft. Every chat here is ABOUT the craft (an `about`
 * edge written by `chat.start`) with the mode PINNED to craft; the agent
 * picks which page to work on. No per-page chats.
 *
 * It draws no header: the craft's side panel (`CraftSidePanel`) lists these
 * chats beside the craft's sessions and drives the selection. The chat
 * surface is hosted SOLO and `routeThreadId` is authoritative.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { createChatHomePortFromSeam, type ChatHomeL2Bridge } from '../chat-home/real-port';
import { ChatHomeSurface } from '../chat-home/ChatHomeSurface';
import type { ChatThreadSummary } from '../chat-home/types';
import type { TriggerOption } from '../rich-input';
import type { ToolNoteCall } from './turn-notes';

export const EXAMPLE_PROMPTS: readonly string[] = [
  'Plan a launch for our new pricing page: research, copy, craft review and the ship checklist.',
  'Break "migrate auth to passkeys" into tasks, who should own each, and the docs they produce.',
  'Craft a weekly research digest: a teammate that reads sources, writes a doc, and remembers what it covered.',
];

/** One frozen empty set, so "no chats yet" never mints a new identity. */
const EMPTY_ABOUT: ReadonlySet<EntityId> = new Set();

function sameIds(current: ReadonlySet<EntityId>, next: readonly EntityId[]): boolean {
  return current.size === next.length && next.every((id) => current.has(id));
}

export interface CraftChatPaneProps {
  seam: Seam;
  spaceId: SpaceId;
  nodeKey: string;
  craftId: EntityId;
  bridge?: ChatHomeL2Bridge | undefined;
  skillOptions?: readonly TriggerOption[] | undefined;
  viewerName?: string | undefined;
  viewerId?: string | undefined;
  composerSeed?: { text: string; nonce: number } | undefined;
  onPrompt(text: string): void;
  toolNote?: ((call: ToolNoteCall) => ReactNode) | undefined;
  onOpenEntity(id: EntityId): void;
  /**
   * What the host's list asked for. `undefined` = nothing asked yet (the
   * surface keeps its cold start); `null` = the explicit new-chat composer.
   * The host TRACKS the resolved selection (`onSelectionChange`), because
   * `routeThreadId` is compared by value and a stale request could never be
   * re-asked.
   */
  requestedThreadId: EntityId | null | undefined;
  /** The craft chats about this craft, newest first, and every loaded thread. */
  onThreadsChange(scoped: readonly ChatThreadSummary[], all: readonly ChatThreadSummary[]): void;
  /** The selection the chat surface resolved. */
  onSelectionChange(id: EntityId | null): void;
}

export function CraftChatPane({
  seam,
  spaceId,
  nodeKey,
  craftId,
  bridge,
  skillOptions,
  viewerName,
  viewerId,
  composerSeed,
  onPrompt,
  toolNote,
  onOpenEntity,
  requestedThreadId,
  onThreadsChange,
  onSelectionChange,
}: CraftChatPaneProps) {
  /* The SAME port `ChatHomeSurface` builds from this seam — a pure factory. */
  const port = useMemo(() => createChatHomePortFromSeam(seam, bridge), [seam, bridge]);
  const [threads, setThreads] = useState<readonly ChatThreadSummary[]>([]);

  /* Which chats are about the craft: ONE incoming-edge read on the craft,
     re-run when the thread list's membership changes (a send that started a
     chat wrote a new `about` edge). Settles rather than re-sets. */
  const [aboutCraft, setAboutCraft] = useState<ReadonlySet<EntityId>>(EMPTY_ABOUT);
  const threadKey = threads.map((thread) => thread.rootId).join(',');
  useEffect(() => {
    let live = true;
    void port.chatIdsAbout(craftId).then((ids) => {
      if (live) setAboutCraft((current) => (sameIds(current, ids) ? current : new Set(ids)));
    });
    return () => {
      live = false;
    };
  }, [port, craftId, threadKey]);

  const scoped = useMemo(
    () => threads.filter((thread) => thread.config.mode === 'craft' && aboutCraft.has(thread.rootId)),
    [threads, aboutCraft],
  );
  const reportRef = useRef(onThreadsChange);
  reportRef.current = onThreadsChange;
  useEffect(() => {
    reportRef.current(scoped, threads);
  }, [scoped, threads]);

  return (
    <div className="dsn-chat">
      <div className="crf-chat__body">
        <ChatHomeSurface
          seam={seam}
          spaceId={spaceId}
          nodeKey={nodeKey}
          bridge={bridge}
          /* Contextual chat: a new thread is ABOUT the craft. */
          aboutId={craftId}
          pinnedMode="craft"
          composerSeed={composerSeed}
          newThreadIntro={<CraftChatIntro onPrompt={onPrompt} />}
          toolNote={toolNote}
          skillOptions={skillOptions}
          onOpenEntity={onOpenEntity}
          soloConversation
          routeThreadId={requestedThreadId}
          onThreadsChange={setThreads}
          onSelectionChange={onSelectionChange}
          viewerName={viewerName}
          viewerId={viewerId}
        />
      </div>
    </div>
  );
}

/**
 * The new-chat intro in a craft — in place of the generic greeting, it says
 * what this agent does here. The examples land in the composer, unsent.
 */
export function CraftChatIntro({ onPrompt }: { onPrompt(text: string): void }) {
  return (
    <div className="crf-intro" data-testid="crf-chat-intro">
      <h1>Start a craft</h1>
      <p>
        Describe the work. The craft agent builds this craft&apos;s pages — a graph that plans the tasks and who owns
        them, the docs, drawings and artifacts they need — and revises them with you. Nothing is created until you
        Run the craft.
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
