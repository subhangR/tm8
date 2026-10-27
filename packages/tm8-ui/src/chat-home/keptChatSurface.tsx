/**
 * ONE CHAT SCREEN ACROSS A DRAFT'S BIND (task 01a14a83).
 *
 * A new chat starts in a Workspace draft tab. Its first Send creates the chat,
 * `drafts.bind` turns the tab into an entity tab, and the content host swaps
 * `DraftHost` for `EntityTab` — two different trees, so React unmounted the
 * screen that was showing the message and the turn, and the entity tab
 * stepped through its skeleton, "Loading Chat…" and "Reading this
 * conversation…" before drawing the same transcript again.
 *
 * The keeper holds that ONE screen instead. The draft does not render its
 * chat screen; it hands it to the keeper, which renders it through a portal
 * into a DOM node the keeper owns. Whichever outlet is on screen — the draft
 * body, then the entity tab while its detail loads, then the chat panel's
 * conversation slot — moves that node into itself. The screen's state (the
 * transcript, the turn clock, the phase, its turn socket) never unmounts.
 *
 * One kept screen at a time, owned by the content host, which drops it the
 * moment its tab stops being the active tab. Outside a provider every outlet
 * renders its own fallback, so no other host changes.
 */
import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { EntityId } from '@tm8/contract';
import './kept-chat.css';

/** What an entity outlet may hand the kept screen once it hosts it. */
export interface KeptChatAdoption {
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  viewerName?: string | undefined;
  viewerId?: string | undefined;
}

interface KeptEntry {
  /** The tab that started the chat. */
  tabId: string;
  /** Null until the chat exists (`chat.start` answered). */
  chatId: string | null;
  /** The node the portal renders into; outlets move it into themselves. */
  element: HTMLDivElement;
  surface: ReactElement;
  adoption: KeptChatAdoption | null;
}

export interface KeptChatStore {
  /** The draft hands over (or refreshes) its chat screen. */
  hold(tabId: string, surface: ReactElement): void;
  /** The chat now exists; entity outlets for it take the kept screen. */
  bind(tabId: string, chatId: string): void;
  /** An entity outlet hands the screen the props its own mount would have had. */
  adopt(chatId: string, adoption: KeptChatAdoption): void;
  /** Drop the kept screen (its tab closed or stopped being active). */
  release(tabId?: string): void;
  heldTabId(): string | null;
  heldChatId(): string | null;
  /** The kept node for a draft tab, or for a chat. */
  elementForTab(tabId: string): HTMLDivElement | null;
  elementForChat(chatId: string): HTMLDivElement | null;
  subscribe(listener: () => void): () => void;
  snapshot(): KeptEntry | null;
}

export function createKeptChatStore(): KeptChatStore {
  let entry: KeptEntry | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  const set = (next: KeptEntry | null) => {
    entry = next;
    emit();
  };
  return {
    hold(tabId, surface) {
      if (entry?.tabId === tabId) {
        if (entry.surface !== surface) set({ ...entry, surface });
        return;
      }
      const element = document.createElement('div');
      element.setAttribute('data-testid', 'kept-chat-surface');
      set({ tabId, chatId: null, element, surface, adoption: null });
    },
    bind(tabId, chatId) {
      if (entry?.tabId !== tabId || entry.chatId === chatId) return;
      set({ ...entry, chatId });
    },
    adopt(chatId, adoption) {
      if (!entry || entry.chatId !== chatId) return;
      const prev = entry.adoption;
      if (
        prev &&
        prev.onOpenEntity === adoption.onOpenEntity &&
        prev.viewerName === adoption.viewerName &&
        prev.viewerId === adoption.viewerId
      ) {
        return;
      }
      set({ ...entry, adoption });
    },
    release(tabId) {
      if (!entry || (tabId !== undefined && entry.tabId !== tabId)) return;
      entry.element.remove();
      set(null);
    },
    heldTabId: () => entry?.tabId ?? null,
    heldChatId: () => entry?.chatId ?? null,
    elementForTab: (tabId) => (entry?.tabId === tabId ? entry.element : null),
    elementForChat: (chatId) => (entry && entry.chatId === chatId ? entry.element : null),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => entry,
  };
}

export const KeptChatContext = createContext<KeptChatStore | null>(null);

export function useKeptChatStore(): KeptChatStore | null {
  return useContext(KeptChatContext);
}

/**
 * The provider plus the portal. The portal is a child of the provider, so the
 * kept screen lives as long as the provider does — across the draft host's
 * unmount and the entity tab's mount beneath it.
 */
export function KeptChatProvider({ store, children }: { store: KeptChatStore; children: ReactNode }) {
  return (
    <KeptChatContext.Provider value={store}>
      {children}
      <KeptChatPortal store={store} />
    </KeptChatContext.Provider>
  );
}

function KeptChatPortal({ store }: { store: KeptChatStore }) {
  const entry = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  if (!entry) return null;
  const { adoption } = entry;
  const surface =
    adoption && isValidElement(entry.surface)
      ? cloneElement(entry.surface, {
          ...(adoption.onOpenEntity ? { onOpenEntity: adoption.onOpenEntity } : {}),
          ...(adoption.viewerName ? { viewerName: adoption.viewerName } : {}),
          ...(adoption.viewerId ? { viewerId: adoption.viewerId } : {}),
        } as Record<string, unknown>)
      : entry.surface;
  return createPortal(surface, entry.element, entry.tabId);
}

/**
 * A node taken out of the document drops its focus and its scroll offsets;
 * the move is not the reader's, so the next outlet puts both back.
 */
const views = new WeakMap<HTMLElement, { focus: HTMLElement | null; scrolls: [HTMLElement, number][] }>();

function rememberView(element: HTMLElement) {
  const active = document.activeElement;
  const scrolls: [HTMLElement, number][] = [];
  element.querySelectorAll<HTMLElement>('*').forEach((node) => {
    if (node.scrollTop > 0) scrolls.push([node, node.scrollTop]);
  });
  views.set(element, { focus: active instanceof HTMLElement && element.contains(active) ? active : null, scrolls });
}

function restoreView(element: HTMLElement) {
  const view = views.get(element);
  if (!view) return;
  views.delete(element);
  for (const [node, top] of view.scrolls) node.scrollTop = top;
  if (view.focus && element.contains(view.focus)) view.focus.focus({ preventScroll: true });
}

/** Moves the kept node into this outlet while it is mounted. */
function Outlet({ element }: { element: HTMLDivElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    host.appendChild(element);
    restoreView(element);
    return () => {
      if (element.parentNode !== host) return;
      /* Still attached here (React runs this before it removes the old
         host), so the focus and the scroll offsets are readable. */
      rememberView(element);
      host.removeChild(element);
    };
  }, [element]);
  return <div ref={ref} className="tch-kept-outlet" data-testid="kept-chat-outlet" />;
}

/**
 * THE DRAFT'S SIDE: hand the screen to the keeper and show it here. Without a
 * keeper (a host that mounts drafts outside the content host) the screen
 * renders in place, as it always did.
 */
export function KeptChatDraft({ tabId, surface }: { tabId: string; surface: ReactElement }) {
  const store = useKeptChatStore();
  const element = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    () => store?.elementForTab(tabId) ?? null,
    () => null,
  );
  /* A layout effect, so the keeper's re-render lands before the first paint. */
  useLayoutEffect(() => {
    store?.hold(tabId, surface);
  }, [store, tabId, surface]);
  if (!store) return surface;
  return element ? <Outlet element={element} /> : <div className="tch-kept-outlet" />;
}

/**
 * THE ENTITY SIDE: if the keeper holds the screen that started this chat,
 * show that one; otherwise mount `fallback` (the ordinary chat surface).
 */
export function KeptChatOutlet({
  chatId,
  adoption,
  fallback,
}: {
  chatId: string;
  adoption?: KeptChatAdoption;
  fallback: ReactNode;
}) {
  const store = useKeptChatStore();
  const subscribe = store?.subscribe ?? noopSubscribe;
  const element = useSyncExternalStore(
    subscribe,
    () => store?.elementForChat(chatId) ?? null,
    () => null,
  );
  const onOpenEntity = adoption?.onOpenEntity;
  const viewerName = adoption?.viewerName;
  const viewerId = adoption?.viewerId;
  /* The handler is re-minted per host render; adopt through a ref-stable
     wrapper so the kept screen is not re-rendered by every parent render. */
  const openRef = useRef(onOpenEntity);
  openRef.current = onOpenEntity;
  const [stableOpen] = useState(() => (id: EntityId) => openRef.current?.(id));
  const hasOpen = onOpenEntity !== undefined;
  useLayoutEffect(() => {
    if (!store || !element) return;
    store.adopt(chatId, { onOpenEntity: hasOpen ? stableOpen : undefined, viewerName, viewerId });
  }, [store, element, chatId, hasOpen, stableOpen, viewerName, viewerId]);
  if (!element) return <>{fallback}</>;
  return <Outlet element={element} />;
}

/** True when the keeper holds the screen for this chat (the entity tab skips its skeleton). */
export function useKeptChat(chatId: string): boolean {
  const store = useKeptChatStore();
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    () => (store ? store.elementForChat(chatId) !== null : false),
    () => false,
  );
}

const noopSubscribe = () => () => {};
