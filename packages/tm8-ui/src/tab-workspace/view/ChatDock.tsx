/**
 * Per-tab chat dock / overlay (Spec A §10, D13; design log §12). Workstream G.
 *
 * The tab's own `ui.chat` is the slot: `open`, and `threadId` (absent until
 * the chats about the entity are read, then the latest or `'new'`, exactly as
 * `openEntityChat` resolves it). Workspace never touches the route's chat slot
 * (`ca`/`ct`) or the shell's `EntityChatDock` sheet.
 *
 * WIDTH is the workspace's one `layout.chatWidth` (`workspace.layout.set`),
 * not a per-tab width: the dock is a column of the workspace, like the
 * browser, and a column that changes width on every tab switch reads as a
 * layout jump. When less than ~480px of entity content would remain, the
 * chat opens as an overlay inside the row instead, under the floating group.
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
import { getKind } from '../../domain';
import { EntityChatPanel, NewChatSettings, useChatsAbout } from '../../entity-chat';
import { PanelResizer } from '../../kit/PanelResizer';
import { entityChatSurfaceFor, type EntityChatSurfaceHost } from '../../views/conversationSurface';
import { getKindAdapter } from '../adapters/registry';
import { isWorkspaceKind, LAYOUT_BOUNDS, type EntityTabRecord, type TabId } from '../runtime/types';
import { useWorkspace, useWorkspaceState } from './context';
import './chat.css';

export interface ChatDockProps {
  tab: EntityTabRecord;
}

/** Below this much entity content beside the dock, the chat overlays instead (Spec A §10). */
const MIN_CONTENT_W = 480;

/** A new chat's chosen settings, per tab, for the page's life. */
const startedSeeds = new Map<TabId, NewChatSeed>();

export function ChatDock({ tab }: ChatDockProps) {
  if (!tab.ui.chat?.open || !getKindAdapter(tab.kind).supportsChat) return null;
  return <OpenChatDock tab={tab} />;
}

function OpenChatDock({ tab }: ChatDockProps) {
  const { dispatch, gate, viewerId } = useWorkspace();
  const chatWidth = useWorkspaceState((s) => s.layout.chatWidth);
  const { data } = gate;
  const about = tab.entityId as EntityId;
  const tabId = tab.id;

  /* The row's width decides docked vs overlay; the floating group's bottom
     is where an overlay starts, so the group is never covered. */
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [rowWidth, setRowWidth] = useState(Infinity);
  const [groupBottom, setGroupBottom] = useState(0);
  useEffect(() => {
    const row = el?.parentElement;
    if (!row || typeof ResizeObserver === 'undefined') return;
    const group = row.querySelector<HTMLElement>('.tws-floating');
    /* Layout px, not client rects: the shell scales with CSS `zoom`. The
       group's offset parent is the entity content, which starts at the row's top. */
    const measure = () => {
      setRowWidth(row.clientWidth);
      setGroupBottom(group ? group.offsetTop + group.offsetHeight : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    if (group) ro.observe(group);
    return () => ro.disconnect();
  }, [el]);
  const overlay = rowWidth - chatWidth < MIN_CONTENT_W;

  const setChat = useCallback(
    (chat: { open: boolean; threadId?: EntityId | 'new' }, source: 'click' | 'system' = 'click') =>
      dispatch({ command: 'workspace.tabs.setUi', args: { tabId, patch: { chat } }, source }),
    [dispatch, tabId],
  );
  const close = useCallback(() => setChat({ open: false }), [setChat]);

  /* Thread: the tab's, or — first time open — the latest chat about it. */
  const { chats } = useChatsAbout(data.seam, about);
  const thread = tab.ui.chat?.threadId as EntityId | 'new' | undefined;
  useEffect(() => {
    if (thread === undefined && chats) setChat({ open: true, threadId: chats[0]?.id ?? 'new' }, 'system');
  }, [thread, chats, setChat]);
  const select = useCallback((next: EntityId | 'new') => setChat({ open: true, threadId: next }), [setChat]);

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

  /* Links inside the chat open as workspace tabs, with this tab on the trail. */
  const detail = data.detailOf(tab.entityId);
  const title = detail?.title ?? null;
  const openTab = useCallback(
    (kind: string, entityId: string) => {
      if (!isWorkspaceKind(kind)) {
        gate.navigateView({ view: 'entity', entityId: entityId as EntityId, origin: null });
        return;
      }
      const trail = [...(tab.ui.trail ?? []), { entityId: tab.entityId, kind: tab.kind, title: title ?? '' }];
      dispatch({ command: 'workspace.tabs.open', args: { kind, entityId, trail }, source: 'click' });
    },
    [dispatch, gate, tab, title],
  );
  const onOpenEntity = useCallback(
    (id: EntityId) => {
      const kind = data.detailOf(id)?.kind ?? data.domain.store.getState().entities[id]?.kind;
      if (kind) openTab(kind, id);
      else data.seam.entity(id).then((read) => openTab(read.kind, id), () => undefined);
    },
    [data, openTab],
  );

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

  useChatScroll(el, tabId, thread);

  const style = {
    '--tws-chat-w': `${chatWidth}px`,
    '--tws-chat-top': `${groupBottom}px`,
  } as CSSProperties;

  /* A new chat's settings, once chosen, hold for this tab until it is
     created: coming back to the tab returns to its composer and draft, not
     to the settings card. `+ New` after a created chat asks again. */
  useEffect(() => {
    if (thread !== undefined && thread !== 'new') startedSeeds.delete(tabId);
  }, [thread, tabId]);

  let body: ReactNode = <div className="tws-chat-wait" role="status" aria-label="Loading chat" />;
  if (thread !== undefined) {
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
    <aside
      ref={setEl}
      className={`tws-chat${overlay ? ' tws-chat--overlay' : ''}`}
      aria-label="Chat"
      data-testid="tws-chat"
      data-mode={overlay ? 'overlay' : 'docked'}
      style={style}
      onKeyDown={(e) => {
        if (overlay && e.key === 'Escape' && !e.defaultPrevented) close();
      }}
    >
      {overlay ? null : (
        <div className="tws-chat-resizer">
          <PanelResizer
            side="right"
            label="Chat"
            width={chatWidth}
            minWidth={LAYOUT_BOUNDS.chatWidth.min}
            maxWidth={Math.min(LAYOUT_BOUNDS.chatWidth.max, rowWidth - MIN_CONTENT_W)}
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
      )}
      {thread !== undefined ? (
        <EntityChatPanel
          slot={{ about, thread }}
          subject={{ id: about, title, glyph: getKind(tab.kind).chip.glyph }}
          chats={chats}
          onSelectThread={select}
          onClose={close}
        >
          {body}
        </EntityChatPanel>
      ) : (
        body
      )}
    </aside>
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
