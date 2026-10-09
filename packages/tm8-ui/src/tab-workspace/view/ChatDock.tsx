/**
 * Per-tab side column (Spec A §10, D13; design log §12; task 01a122b9).
 * Workstream G. It began as the chat dock and now holds three sections —
 * Chat · Messages · Links — behind one header, so the entity body stays in
 * place while its conversation and links are read beside it. The section is
 * `ui.chat.section` (see `sideSection.ts`); the column, its width and its
 * open state are the dock's, unchanged.
 *
 * The tab's own `ui.chat` is the slot: `open`, and `threadId` (absent until
 * the chats about the entity are read, then the latest or `'new'`, exactly as
 * `openEntityChat` resolves it). Workspace never touches the route's chat slot
 * (`ca`/`ct`) or the shell's `EntityChatDock` sheet.
 *
 * WIDTH is the workspace's one `layout.chatWidth` (`workspace.layout.set`),
 * not a per-tab width: the dock is a column of the workspace, like the
 * browser, and a column that changes width on every tab switch reads as a
 * layout jump. It is ALWAYS a column, never an overlay over the page (task
 * 01a11330): in a narrow row the chat gives up width down to its minimum and
 * the entity content shrinks beside it.
 *
 * PER-TAB STATE survives the unmount that every tab switch is (D15):
 *   · thread and open/closed live on the tab record;
 *   · the composer's unsent text lives in the chat store's persisted drafts
 *     (`chat-store.ts` `readDraft`/`writeDraft`), keyed by viewer and thread —
 *     and, for a chat not yet started, by the entity it will be about — so
 *     no draft can surface under another entity;
 *   · the transcript's scroll is kept per tab for the page's life.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { EntityId } from '@tm8/contract';
import { readDraft, writeDraft, type ChatStateKeyParts } from '../../channel-screen/chat-store';
import type { ComposerDraftStore } from '../../chat-home/ChatHomeScreen';
import type { NewChatSeed } from '../../chat-home/types';
import { nodeKeyOf } from '../../data/launch-cache';
import { getKind, KindIcon } from '../../domain';
import { EntityAttentionChip } from '../../attention';
import { EntityChatPanel, NewChatSettings, useChatsAbout, type ChatAboutRow } from '../../entity-chat';
import { PanelResizer } from '../../kit/PanelResizer';
import { relTime, absTime } from '../../kit/time';
import { countMessages } from '../../panels';
import { entityChatSurfaceFor, type EntityChatSurfaceHost } from '../../views/conversationSurface';
import { getKindAdapter } from '../adapters/registry';
import { LAYOUT_BOUNDS, type EntityTabRecord, type SideSection, type TabId } from '../runtime/types';
import { useWorkspace, useWorkspaceState } from './context';
import { useLinkedOpen } from './LinkedTrail';
import { SideLinks, sideLinksOf } from './SideLinks';
import { SideMessages } from './SideMessages';
import { openSideSection, sidePatch } from './sideSection';
import './chat.css';
import './side.css';

export interface ChatDockProps {
  tab: EntityTabRecord;
  /** Where an entity named in the column opens; absent ⇒ a linked Workspace tab. */
  onOpenEntity?: (id: string) => void;
}

/** The column narrows (to its own minimum) before the entity content goes below this. */
const MIN_CONTENT_W = 320;

/** A new chat's settings, per tab, for the page's life. */
const startedSeeds = new Map<TabId, NewChatSeed>();
/** Tabs whose Chat section shows the thread list rather than a thread (D11). */
const chatListMode = new Set<TabId>();

const SECTION_LABEL: Record<SideSection, string> = { chat: 'Chat', messages: 'Messages', links: 'Links' };

export function ChatDock({ tab, onOpenEntity }: ChatDockProps) {
  const chatAvailable = getKindAdapter(tab.kind).supportsChat;
  const section = openSideSection(tab, chatAvailable);
  if (!section) return null;
  return <SideColumn tab={tab} section={section} chatAvailable={chatAvailable} onOpenEntity={onOpenEntity} />;
}

function SideColumn({
  tab,
  section,
  chatAvailable,
  onOpenEntity,
}: ChatDockProps & { section: SideSection; chatAvailable: boolean }) {
  const { dispatch, gate } = useWorkspace();
  const chatWidth = useWorkspaceState((s) => s.layout.chatWidth);
  const { data } = gate;
  const about = tab.entityId as EntityId;
  const tabId = tab.id;
  const detail = data.detailOf(tab.entityId);

  /* The row's width caps the column: the viewer's width while the content
     keeps MIN_CONTENT_W, else narrower, never below the column's own minimum. */
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [rowWidth, setRowWidth] = useState(Infinity);
  useEffect(() => {
    const row = el?.parentElement;
    if (!row || typeof ResizeObserver === 'undefined') return;
    /* Layout px, not client rects: the shell scales with CSS `zoom`. */
    const measure = () => setRowWidth(row.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
  }, [el]);
  const fitMax = Math.max(LAYOUT_BOUNDS.chatWidth.min, rowWidth - MIN_CONTENT_W);
  const paintedWidth = Math.min(chatWidth, fitMax);
  const style = { '--tws-chat-w': `${paintedWidth}px` } as CSSProperties;

  const show = (next: SideSection) =>
    dispatch({
      command: 'workspace.tabs.setUi',
      args: { tabId, patch: sidePatch(tab, next, chatAvailable, false) },
      source: 'click',
    });
  const close = () =>
    dispatch({ command: 'workspace.tabs.setUi', args: { tabId, patch: { chat: { open: false } } }, source: 'click' });

  /* Links inside the column open as workspace tabs, with this tab on the trail. */
  const { openLinked } = useLinkedOpen(tab);
  const open = onOpenEntity ?? openLinked;

  const { chats } = useChatsAbout(chatAvailable ? data.seam : null, about);
  const counts: Record<SideSection, number | null> = {
    chat: chats ? chats.length : null,
    messages: detail ? countMessages(detail, data.messagesOf(tab.entityId)) : null,
    links: detail ? sideLinksOf(detail, data.connectionsOf(tab.entityId)).length : null,
  };
  const sections: SideSection[] = chatAvailable ? ['chat', 'messages', 'links'] : ['messages', 'links'];

  let body: ReactNode;
  if (section === 'chat') {
    body = <ChatSection tab={tab} chats={chats} el={el} onOpenEntity={open} />;
  } else if (!detail) {
    body = <div className="tws-chat-wait" role="status" aria-label="Loading" />;
  } else if (section === 'messages') {
    body = (
      <SideMessages
        key={about}
        data={data}
        entityId={about}
        viewerMemberId={gate.viewerMemberId ?? 'anonymous'}
        canPost={detail.capabilities.canEdit || detail.capabilities.canReact}
        onOpenEntity={open}
      />
    );
  } else {
    body = <SideLinks detail={detail} connections={data.connectionsOf(tab.entityId)} onOpenEntity={open} />;
  }

  return (
    <aside
      ref={setEl}
      className="tws-chat tws-side"
      aria-label={SECTION_LABEL[section]}
      data-testid="tws-chat"
      data-mode="docked"
      data-section={section}
      style={style}
    >
      <div className="tws-chat-resizer">
        <PanelResizer
          side="right"
          label="Side panel"
          width={paintedWidth}
          minWidth={LAYOUT_BOUNDS.chatWidth.min}
          maxWidth={Math.min(LAYOUT_BOUNDS.chatWidth.max, fitMax)}
          onResize={(w) =>
            dispatch({ command: 'workspace.layout.set', args: { chatWidth: Math.round(w) }, source: 'click' })
          }
          onReset={() =>
            dispatch({
              command: 'workspace.layout.set',
              args: { chatWidth: LAYOUT_BOUNDS.chatWidth.initial },
              source: 'click',
            })
          }
        />
      </div>
      <header className="tws-side-head">
        <div className="tws-side-seg" role="tablist" aria-label="Side panel sections">
          {sections.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              className="tws-side-seg__tab"
              aria-selected={section === id}
              data-testid={`tws-side-tab-${id}`}
              onClick={() => show(id)}
            >
              {SECTION_LABEL[id]}
              {counts[id] ? <em>{counts[id]}</em> : null}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="tws-side-close"
          aria-label="Close side panel"
          title="Close"
          data-testid="tws-side-close"
          onClick={close}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      <div className="tws-side-body" role="tabpanel" aria-label={SECTION_LABEL[section]}>
        {body}
      </div>
    </aside>
  );
}

/**
 * THE CHAT SECTION (D11): the conversation with its thread switcher is the
 * primary screen, exactly as the dock was; a list toggle in its header swaps
 * to the threads about the entity as a clean list, and picking one returns to
 * the conversation.
 */
function ChatSection({
  tab,
  chats,
  el,
  onOpenEntity,
}: {
  tab: EntityTabRecord;
  chats: readonly ChatAboutRow[] | null;
  el: HTMLElement | null;
  onOpenEntity: (id: string) => void;
}) {
  const { dispatch, gate, viewerId } = useWorkspace();
  const { data } = gate;
  const about = tab.entityId as EntityId;
  const tabId = tab.id;
  const [listMode, setListModeState] = useState(() => chatListMode.has(tabId));
  const setListMode = (next: boolean) => {
    if (next) chatListMode.add(tabId);
    else chatListMode.delete(tabId);
    setListModeState(next);
  };

  const setChat = useCallback(
    (chat: { open: boolean; threadId?: EntityId | 'new' }, source: 'click' | 'system' = 'click') =>
      dispatch({ command: 'workspace.tabs.setUi', args: { tabId, patch: { chat } }, source }),
    [dispatch, tabId],
  );

  /* Thread: the tab's, or — first time open — the latest chat about it. */
  const thread = tab.ui.chat?.threadId as EntityId | 'new' | undefined;
  useEffect(() => {
    if (thread === undefined && chats) setChat({ open: true, threadId: chats[0]?.id ?? 'new' }, 'system');
  }, [thread, chats, setChat]);
  const select = useCallback(
    (next: EntityId | 'new') => {
      chatListMode.delete(tabId);
      setListModeState(false);
      setChat({ open: true, threadId: next });
    },
    [setChat, tabId],
  );

  /* Composer drafts in the chat store, keyed per viewer and thread; a chat
     not yet created is keyed by its subject, so it cannot follow the viewer
     to another entity's new chat. */
  const viewerMemberId = gate.viewerMemberId ?? viewerId;
  const composerDrafts = useMemo<ComposerDraftStore>(() => {
    const storage = typeof window === 'undefined' ? null : window.localStorage;
    const partsOf = (threadKey: string): ChatStateKeyParts => ({
      viewerMemberId,
      sessionId: threadKey === 'new-thread' ? `about:${about}` : threadKey,
      filter: 'workspace-chat-composer',
    });
    return {
      read: (threadKey) => readDraft(storage, partsOf(threadKey)).newMessage || undefined,
      write: (threadKey, value) =>
        writeDraft(storage, partsOf(threadKey), { newMessage: value, replies: {}, updatedAt: new Date().toISOString() }),
    };
  }, [viewerMemberId, about]);

  const title = data.detailOf(tab.entityId)?.title ?? null;

  const host = useMemo<EntityChatSurfaceHost>(
    () => ({
      seam: data.seam,
      spaceId: data.spaceId ?? '',
      nodeKey: nodeKeyOf(gate.serverBaseUrl),
      onOpenEntity,
      skillOptions: data.skillOptions,
      viewerName: data.viewerActor?.displayName,
      viewerMemberId: gate.viewerMemberId ?? undefined,
      composerDrafts,
    }),
    [data, gate.serverBaseUrl, gate.viewerMemberId, onOpenEntity, composerDrafts],
  );

  useChatScroll(listMode ? null : el, tabId, thread);

  /* A new chat's settings, once chosen, hold for this tab until it is
     created: coming back to the tab returns to its composer and draft, not
     to the settings card. `+ New` after a created chat asks again. */
  useEffect(() => {
    if (thread !== undefined && thread !== 'new') startedSeeds.delete(tabId);
  }, [thread, tabId]);

  if (thread === undefined) return <div className="tws-chat-wait" role="status" aria-label="Loading chat" />;

  const listToggle = (
    <button
      type="button"
      className="ecp__list"
      aria-pressed={listMode}
      aria-label={listMode ? 'Back to the conversation' : 'All chats'}
      title={listMode ? 'Back to the conversation' : 'All chats'}
      data-testid="tws-chat-list-toggle"
      onClick={() => setListMode(!listMode)}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M5.5 4h8M5.5 8h8M5.5 12h8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="2.75" cy="4" r="0.9" fill="currentColor" />
        <circle cx="2.75" cy="8" r="0.9" fill="currentColor" />
        <circle cx="2.75" cy="12" r="0.9" fill="currentColor" />
      </svg>
    </button>
  );

  let body: ReactNode;
  if (listMode) {
    body = <ChatList chats={chats} current={thread} onSelect={select} />;
  } else {
    const surfaceFor = (seed?: NewChatSeed) => entityChatSurfaceFor(about, thread, host, select, seed);
    const started = thread === 'new' ? startedSeeds.get(tabId) : undefined;
    body =
      thread !== 'new' ? (
        surfaceFor()
      ) : started ? (
        surfaceFor(started)
      ) : (
        <NewChatSettings
          seam={data.seam}
          spaceId={host.spaceId}
          nodeKey={host.nodeKey}
          subject={{ id: about, kind: tab.kind }}
          composerFor={(seed) => {
            const { focus: _focus, ...held } = seed;
            startedSeeds.set(tabId, held);
            return surfaceFor(seed);
          }}
        />
      );
  }

  return (
    <EntityChatPanel
      slot={{ about, thread }}
      subject={{ id: about, title, glyph: getKind(tab.kind).chip.glyph }}
      chats={chats}
      onSelectThread={select}
      actions={listToggle}
    >
      {body}
    </EntityChatPanel>
  );
}

/** The chats about the entity as rows — the Chat section's list mode (D11). */
function ChatList({
  chats,
  current,
  onSelect,
}: {
  chats: readonly ChatAboutRow[] | null;
  current: EntityId | 'new';
  onSelect: (thread: EntityId | 'new') => void;
}) {
  if (!chats) return <div className="tws-chat-wait" role="status" aria-label="Loading chats" />;
  if (chats.length === 0) return <p className="tws-side-empty">No chats about this yet. Start one with + New.</p>;
  return (
    <div className="tws-side-scroll">
      <ul className="tws-side-list" aria-label="Chats" data-testid="tws-chat-list">
        {chats.map((chat) => (
          <li key={chat.id} className="tws-side-row" data-current={chat.id === current || undefined}>
            <button
              type="button"
              className="tws-side-row__hit"
              aria-current={chat.id === current ? 'true' : undefined}
              onClick={() => onSelect(chat.id)}
            >
              <span className="tws-side-row__lead tws-side-row__icon">
                <KindIcon kind="chat" size={14} />
              </span>
              <span className="tws-side-row__main">
                <span className="tws-side-row__line">
                  <span className="tws-side-row__title">{chat.title}</span>
                  <time className="tws-side-row__when" dateTime={chat.lastActivityAt} title={absTime(chat.lastActivityAt)}>
                    {relTime(chat.lastActivityAt)}
                  </time>
                </span>
                <span className="tws-side-row__tags">
                  <span className="tws-side-row__meta">
                    {`${chat.turnCount} ${chat.turnCount === 1 ? 'turn' : 'turns'}`}
                  </span>
                  <EntityAttentionChip entity={{ id: chat.id }} compact />
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Transcript scroll, per tab, for the page's life. Recorded on every scroll of
 * the chat's transcript; put back once the thread has rendered enough to hold
 * it. A reader who was at the latest turn is left to the transcript's own
 * follow-the-latest rule.
 * ------------------------------------------------------------------------- */

const TRANSCRIPT = '.tch-transcript';
const AT_END_PX = 24;
const RESTORE_WINDOW_MS = 4000;
const chatScroll = new Map<TabId, { thread: string; top: number }>();

function useChatScroll(el: HTMLElement | null, tabId: TabId, thread: string | undefined) {
  useEffect(() => {
    if (!el || thread === undefined) return;
    const record = (e: Event) => {
      const target = e.target as HTMLElement;
      if (!target.matches?.(TRANSCRIPT)) return;
      if (target.scrollHeight - target.scrollTop - target.clientHeight <= AT_END_PX) chatScroll.delete(tabId);
      else chatScroll.set(tabId, { thread, top: target.scrollTop });
    };

    const saved = chatScroll.get(tabId);
    let restoring = saved?.thread === thread ? saved : undefined;
    let done = () => {};
    if (restoring) {
      const target = restoring.top;
      const tryRestore = () => {
        const t = el.querySelector<HTMLElement>(TRANSCRIPT);
        if (!t || t.scrollHeight - t.clientHeight < target) return;
        t.scrollTop = target;
        done();
      };
      const mo = new MutationObserver(tryRestore);
      mo.observe(el, { childList: true, subtree: true });
      const timer = window.setTimeout(() => done(), RESTORE_WINDOW_MS);
      /* The reader moving first wins. */
      const stop = () => done();
      el.addEventListener('wheel', stop, { passive: true });
      el.addEventListener('pointerdown', stop);
      el.addEventListener('keydown', stop);
      done = () => {
        restoring = undefined;
        mo.disconnect();
        window.clearTimeout(timer);
        el.removeEventListener('wheel', stop);
        el.removeEventListener('pointerdown', stop);
        el.removeEventListener('keydown', stop);
        done = () => {};
      };
      tryRestore();
    }

    el.addEventListener('scroll', record, true);
    return () => {
      el.removeEventListener('scroll', record, true);
      done();
    };
  }, [el, tabId, thread]);
}
