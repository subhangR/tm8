/**
 * Generic entity adapter (Spec B §6, Spec A §8, §13, §15): renders the kind's
 * chosen body — the full-view panel (`host='z4'`) or the detail-panel body —
 * through the SAME `AuxEntityPanel` host bundle the full view assembles, with
 * the panel's header and tab rows switched off (`embeddedChrome`). Exposes
 * `captureUi()` / `restoreUi(ui)` for scroll, the in-tab unavailable states,
 * and `useTabLiveStatus` for the strip.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';
import type { EntityId, EntityKind, ExecutionSpawnInput } from '@tm8/contract';
import { EditEntityDialog } from '../../authoring';
import { KindIcon, type ActionRef } from '../../domain';
import { attachmentsFor } from '../../files/port';
import type { ControlHost, EmbeddedChrome } from '../../panels';
import type { PanelTab } from '../../panels/detail/chrome';
import { AuxEntityPanel, type AuxPanelHost } from '../../views/auxPanel';
import { useLaunchPort } from '../../views/useLaunchPort';
import { useMembershipSurface } from '../../views/membershipSurface';
import { usePanelPrimaries } from '../../views/usePanelPrimaries';
import { useRowLifecycle } from '../../views/useRowLifecycle';
import { useEntityVerbs } from '../../views/useEntityVerbs';
import type { GateData } from '../../views/useGateData';
import type { WorkspaceRuntime } from '../runtime/dispatch';
import { isWorkspaceKind, type EntityTabRecord, type TabId, type TabRecord, type TabSubview, type TabUi } from '../runtime/types';
import { useWorkspace } from '../view/context';
import type { KindAdapter } from './registry';

export interface EntityAdapterHandle {
  captureUi(): Partial<TabUi>;
  restoreUi(ui: TabUi): void;
}

export interface EntityTabBodyProps {
  tab: EntityTabRecord;
  adapter: KindAdapter;
  /** Registers the mounted body's capture/restore handle; null on unmount. */
  onHandle?: (handle: EntityAdapterHandle | null) => void;
}

// ---------------------------------------------------------------------------
// The chrome seam between the body and the floating group (both in ContentHost)
// ---------------------------------------------------------------------------

/**
 * The floating group owns the DOM the panel's verbs and ⋯ items portal into;
 * the body owns the panel. ContentHost provides this so the two stay siblings
 * (the group is outside the body's scroll) without new props on either.
 */
export interface EntityChromeSlots {
  verbsSlot: HTMLElement | null;
  menuSlot: HTMLElement | null;
  secondarySlot: HTMLElement | null;
  dangerSlot: HTMLElement | null;
  menuOpen: boolean;
  setMenuOpen(open: boolean): void;
  /** Width of the entity content area, for the group's narrow arrangements. */
  contentWidth: number;
}

export interface EntityChromeContextValue extends EntityChromeSlots {
  setVerbsSlot(el: HTMLElement | null): void;
  setMenuSlot(el: HTMLElement | null): void;
  setSecondarySlot(el: HTMLElement | null): void;
  setDangerSlot(el: HTMLElement | null): void;
}

export const EntityChromeContext = createContext<EntityChromeContextValue | null>(null);

export function useEntityChrome(): EntityChromeContextValue | null {
  return useContext(EntityChromeContext);
}

/** Verbs Workspace draws itself, so the panel's bar leaves them out. */
const WORKSPACE_OWN_ACTIONS: readonly ActionRef[] = ['chat-about'];

// ---------------------------------------------------------------------------
// Section mapping (TabSubview ⇄ the panel's PanelTab)
// ---------------------------------------------------------------------------

export function panelTabOf(subview: TabSubview): PanelTab {
  return subview === 'connections' ? 'connections' : subview === 'messages' ? 'discussion' : 'content';
}

export function subviewOf(tab: PanelTab): TabSubview {
  return tab === 'connections' ? 'connections' : tab === 'discussion' ? 'messages' : 'entity';
}

// ---------------------------------------------------------------------------
// Restored-tab tracking (§13 "a restored tab that is no longer accessible")
// ---------------------------------------------------------------------------

/**
 * Tabs created in THIS page by a non-restore command. Anything else on the
 * strip arrived through persistence or a restore replay, and a failed read on
 * it reads "This tab couldn't be restored" rather than "deleted".
 */
const freshTabs = new WeakMap<WorkspaceRuntime, Set<TabId>>();

/** Start observing a runtime (idempotent). Call during render, before persistence restores. */
export function trackFreshTabs(runtime: WorkspaceRuntime): void {
  if (freshTabs.has(runtime)) return;
  const fresh = new Set<TabId>();
  freshTabs.set(runtime, fresh);
  runtime.registerEffect(({ env, prev, next }) => {
    if (env.source === 'restore') return;
    for (const id of next.orderedTabIds) if (!prev.tabs[id]) fresh.add(id);
  });
}

function isRestoredTab(runtime: WorkspaceRuntime, tabId: TabId): boolean {
  return !(freshTabs.get(runtime)?.has(tabId) ?? false);
}

// ---------------------------------------------------------------------------
// Host bundle — the same ports FullViewScreen assembles, built once per body
// ---------------------------------------------------------------------------

type PullableData = GateData & { pull?: (id: string) => void };

function useWorkspacePanelHost(
  data: PullableData,
  entityId: string,
  onOpenTab: (kind: string, entityId: string) => void,
): { host: AuxPanelHost; verbs: ReturnType<typeof useEntityVerbs> } {
  const { gate } = useWorkspace();
  const { onNotice, reasons, serverBaseUrl, viewerMemberId } = gate;
  const detail = data.detailOf(entityId);
  const kind = (detail?.kind ?? null) as EntityKind | null;

  const notifyActionFailed = useCallback(
    (_verb: ActionRef, _entityId: string, error: unknown) => {
      onNotice({
        id: 'tws-action-failed',
        tone: 'error',
        title: 'That did not go through',
        body: String((error as { message?: string })?.message ?? error),
        ttlMs: 6_000,
      });
    },
    [onNotice],
  );
  /* A launched session opens as its own tab, as the full view opens it in Work. */
  const onSpawn = useCallback(
    async (input: ExecutionSpawnInput) => {
      const sessionId = await data.spawn(input);
      onOpenTab('work_session', sessionId);
    },
    [data, onOpenTab],
  );
  const launchPort = useLaunchPort(data, { onSpawn });
  const primaries = usePanelPrimaries({
    seam: data.seam,
    reconcileCommand: data.reconcileCommand,
    onError: notifyActionFailed,
    versionOf: (id) => data.detailOf(id)?.version,
  });
  const rowLifecycle = useRowLifecycle({ data, viewerMemberId, onNotice });
  const membership = useMembershipSurface({
    spaceId: data.spaceId,
    seam: data.seam,
    refetchDetail: (id) => data.refetchDetail(id),
    onNotice,
  });
  const attachments = useMemo(() => attachmentsFor(data.seam, data.spaceId), [data.seam, data.spaceId]);
  const verbs = useEntityVerbs({
    detail,
    spaceId: data.spaceId,
    commands: data.seam.commands,
    onCreated: (id) => {
      const created = data.detailOf(id);
      if (created) onOpenTab(created.kind, id);
    },
    onSaved: (id) => data.refetchDetail(id),
  });
  const ctx = useMemo(() => ({ spaceId: data.spaceId }), [data.spaceId]);
  const controls = useMemo<ControlHost>(
    () => ({
      kind: kind ?? '',
      ctx,
      livenessOf: data.livenessOf,
      capabilitiesOf: (id) => data.capabilitiesOf(id),
      onNeedDetail: (id: string) => data.pull?.(id),
      onAction: (ref, id) => primaries.forEntity(id)?.(ref),
      onSetState: rowLifecycle.setState,
      onArchive: rowLifecycle.archive,
      onSetValue: rowLifecycle.setValue,
      onAssign: rowLifecycle.assign,
      assignableActors: rowLifecycle.assignable,
      onMembership: rowLifecycle.membership,
      membershipSets: rowLifecycle.membershipSets,
      connectionsOf: data.connectionsOf,
    }),
    [kind, ctx, data, primaries, rowLifecycle],
  );
  const host: AuxPanelHost = {
    data,
    reasons,
    ctx,
    controls,
    primaries,
    membership,
    launchPort,
    rowLifecycle,
    attachments,
    serverBaseUrl,
    viewerMemberId,
  };
  return { host, verbs };
}

// ---------------------------------------------------------------------------
// Availability — never an endless spinner (§13, design log §11)
// ---------------------------------------------------------------------------

type Availability =
  | { state: 'ready' }
  | { state: 'loading'; visible: boolean; slow: boolean }
  | { state: 'not_found' }
  | { state: 'forbidden' }
  | { state: 'failed'; message: string };

const SKELETON_DELAY_MS = 200;
/** After this long without a detail, ask the node WHY (one read, nothing ingested by us). */
const PROBE_AFTER_MS = 1_500;
const SLOW_AFTER_MS = 10_000;

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : null;
}

function useAvailability(data: PullableData, entityId: string): { availability: Availability; retry(): void } {
  const detail = data.detailOf(entityId);
  const [attempt, setAttempt] = useState(0);
  const [visible, setVisible] = useState(false);
  const [slow, setSlow] = useState(false);
  const [failure, setFailure] = useState<Availability | null>(null);
  const hasDetail = detail !== undefined;

  useEffect(() => {
    if (hasDetail) return;
    setVisible(false);
    setSlow(false);
    setFailure(null);
    /* The data layer reads and stores; this body only asks for it. */
    data.pull?.(entityId);
    let live = true;
    const timers = [
      setTimeout(() => live && setVisible(true), SKELETON_DELAY_MS),
      setTimeout(() => live && setSlow(true), SLOW_AFTER_MS),
      setTimeout(() => {
        if (!live || data.detailOf(entityId)) return;
        data.seam.entity(entityId as never).then(
          () => {
            /* It answers now: hand the store its copy through the layer's own refetch. */
            if (live) data.refetchDetail(entityId);
          },
          (error: unknown) => {
            if (!live) return;
            const code = errorCode(error);
            if (code === 'not_found') setFailure({ state: 'not_found' });
            else if (code === 'forbidden') setFailure({ state: 'forbidden' });
            else
              setFailure({
                state: 'failed',
                message: String((error as { message?: string })?.message ?? 'The node did not answer.'),
              });
          },
        );
      }, PROBE_AFTER_MS),
    ];
    return () => {
      live = false;
      timers.forEach(clearTimeout);
    };
    // `data` churns per GateApp render; the read is keyed on the id and attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, attempt, hasDetail]);

  const retry = useCallback(() => {
    data.refetchDetail(entityId);
    setAttempt((n) => n + 1);
  }, [data, entityId]);

  if (hasDetail) return { availability: { state: 'ready' }, retry };
  return { availability: failure ?? { state: 'loading', visible, slow }, retry };
}

function TabState({
  kind,
  title,
  line,
  children,
  testId,
}: {
  kind: string;
  title: string;
  line?: string;
  children?: ReactNode;
  testId: string;
}) {
  return (
    <div className="tws-state" role="status" data-testid={testId}>
      <KindIcon kind={kind} size={24} className="tws-state-icon" />
      <h2 className="tws-state-title">{title}</h2>
      {line ? <p className="tws-state-line">{line}</p> : null}
      {children ? <div className="tws-state-actions">{children}</div> : null}
    </div>
  );
}

function UnavailableBody({
  tab,
  adapter,
  availability,
  restored,
  onRetry,
  onClose,
}: {
  tab: EntityTabRecord;
  adapter: KindAdapter;
  availability: Exclude<Availability, { state: 'ready' }>;
  restored: boolean;
  onRetry(): void;
  onClose(): void;
}) {
  const noun = adapter.noun.toLowerCase();
  const close = (
    <button type="button" className="tws-state-btn" onClick={onClose}>
      Close tab
    </button>
  );
  if (availability.state === 'loading') {
    if (availability.slow) {
      return (
        <TabState kind={tab.kind} title="Still loading…" testId="tws-state-slow">
          <button type="button" className="tws-state-btn" onClick={onRetry}>
            Retry
          </button>
          {close}
        </TabState>
      );
    }
    return (
      <div className="tws-skeleton" aria-busy="true" aria-label={`Loading ${noun}`} data-testid="tws-state-loading">
        {availability.visible ? (
          <>
            <span className="tws-skeleton-bar" style={{ width: '60%' }} />
            <span className="tws-skeleton-bar" style={{ width: '80%' }} />
            <span className="tws-skeleton-bar" style={{ width: '40%' }} />
          </>
        ) : null}
      </div>
    );
  }
  if ((availability.state === 'not_found' || availability.state === 'forbidden') && restored) {
    return (
      <TabState
        kind={tab.kind}
        title="This tab couldn't be restored"
        line={`The ${noun} is no longer available.`}
        testId="tws-state-restore-failed"
      >
        {close}
      </TabState>
    );
  }
  if (availability.state === 'not_found') {
    return (
      <TabState
        kind={tab.kind}
        title={`This ${noun} was deleted`}
        line="It may have been removed by someone else."
        testId="tws-state-deleted"
      >
        {close}
      </TabState>
    );
  }
  if (availability.state === 'forbidden') {
    return (
      <TabState
        kind={tab.kind}
        title={`You don't have access to this ${noun}`}
        line="Ask a space owner for access."
        testId="tws-state-forbidden"
      >
        {close}
      </TabState>
    );
  }
  return (
    <TabState kind={tab.kind} title={`Couldn't load this ${noun}`} line={availability.message} testId="tws-state-failed">
      <button type="button" className="tws-state-btn" onClick={onRetry}>
        Retry
      </button>
      {close}
    </TabState>
  );
}

// ---------------------------------------------------------------------------
// The tab body
// ---------------------------------------------------------------------------

/** The scroll container inside the reused panel: the whole column for a
    document, the body for a kind that owns its height (see content.css). */
const SCROLL_SELECTOR = ".pn-panel[data-embedded-flow='document'], .pn-panel[data-embedded-flow='fill'] .pn-body";

export function EntityTabBody({ tab, adapter, onHandle }: EntityTabBodyProps) {
  const { gate, dispatch, runtime } = useWorkspace();
  const data = gate.data as PullableData;
  const chrome = useEntityChrome();
  const { availability, retry } = useAvailability(data, tab.entityId);
  const detail = data.detailOf(tab.entityId);

  /* Drilling from the body opens (or focuses) the target's own tab, carrying
     this tab on the trail (Spec A §11). A target whose kind is not known yet
     is pulled first and opened when it lands. */
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);
  const openTab = useCallback(
    (kind: string, entityId: string, withTrail = false) => {
      if (!isWorkspaceKind(kind)) {
        gate.navigateView({ view: 'entity', entityId: entityId as EntityId, origin: null });
        return;
      }
      const trail = withTrail
        ? [...(tab.ui.trail ?? []), { entityId: tab.entityId, kind: tab.kind, title: detail?.title ?? '' }]
        : undefined;
      dispatch({
        command: 'workspace.tabs.open',
        args: { kind, entityId, ...(trail ? { trail } : {}) },
        source: 'click',
      });
    },
    [dispatch, gate, tab, detail?.title],
  );
  const kindOf = useCallback(
    (id: string): string | null =>
      data.detailOf(id)?.kind ?? data.domain.store.getState().entities[id as EntityId]?.kind ?? null,
    [data],
  );
  const onOpenEntity = useCallback(
    (id: string) => {
      const kind = kindOf(id);
      if (kind) openTab(kind, id, true);
      else {
        data.pull?.(id);
        setPendingOpen(id);
      }
    },
    [kindOf, openTab, data],
  );
  const pendingKind = pendingOpen ? kindOf(pendingOpen) : null;
  useEffect(() => {
    if (!pendingOpen || !pendingKind) return;
    setPendingOpen(null);
    openTab(pendingKind, pendingOpen, true);
  }, [pendingOpen, pendingKind, openTab]);

  const openPlain = useCallback((kind: string, id: string) => openTab(kind, id), [openTab]);
  const { host, verbs } = useWorkspacePanelHost(data, tab.entityId, openPlain);

  const closeTab = useCallback(
    () => dispatch({ command: 'workspace.tabs.close', args: { tabId: tab.id }, source: 'click' }),
    [dispatch, tab.id],
  );
  const onTabChange = useCallback(
    (next: PanelTab) =>
      dispatch({
        command: 'workspace.tabs.setUi',
        args: { tabId: tab.id, patch: { subview: subviewOf(next) } },
        source: 'click',
      }),
    [dispatch, tab.id],
  );

  // -- scroll capture / restore ---------------------------------------------
  const rootRef = useRef<HTMLDivElement>(null);
  /* Tracked as it happens: at unmount the node may already be detached, and a
     detached element reads scrollTop 0. */
  const lastScroll = useRef<number | undefined>(tab.ui.scrollTop);
  const scrollEl = () => rootRef.current?.querySelector<HTMLElement>(SCROLL_SELECTOR) ?? null;
  const restoreUi = useCallback((ui: TabUi) => {
    const target = ui.scrollTop;
    if (target === undefined || target <= 0) return;
    let tries = 0;
    /* The body hydrates its sections asynchronously; try for ~half a second
       until the content is tall enough to hold the offset. */
    const step = () => {
      const el = scrollEl();
      if (el) {
        el.scrollTop = target;
        if (Math.abs(el.scrollTop - target) < 2) return;
      }
      if (++tries < 30) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, []);

  const ready = availability.state === 'ready';
  useEffect(() => {
    if (!ready) return;
    const root = rootRef.current;
    if (!root) return;
    const onScroll = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t instanceof HTMLElement && t.matches(SCROLL_SELECTOR)) lastScroll.current = t.scrollTop;
    };
    root.addEventListener('scroll', onScroll, true);
    restoreUi(tab.ui);
    return () => root.removeEventListener('scroll', onScroll, true);
    // Restore once per mount, when the body first becomes ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    if (!onHandle) return;
    onHandle({
      captureUi: () => (lastScroll.current === undefined ? {} : { scrollTop: lastScroll.current }),
      restoreUi,
    });
    return () => onHandle(null);
  }, [onHandle, restoreUi]);

  /* Leaving the Workspace view unmounts the body without a tab switch; keep
     the offset on the record (a scroll-only commit is not revision-significant). */
  useEffect(
    () => () => {
      const scrollTop = lastScroll.current;
      if (scrollTop === undefined || !runtime.store.getState().tabs[tab.id]) return;
      runtime.dispatch({ command: 'workspace.tabs.setUi', args: { tabId: tab.id, patch: { scrollTop } }, source: 'system' });
    },
    [runtime, tab.id],
  );

  if (availability.state !== 'ready') {
    return (
      <div className="tws-body" data-testid="tws-entity-body" data-kind={tab.kind} data-state={availability.state}>
        <UnavailableBody
          tab={tab}
          adapter={adapter}
          availability={availability}
          restored={isRestoredTab(runtime, tab.id)}
          onRetry={retry}
          onClose={closeTab}
        />
      </div>
    );
  }

  const embeddedChrome: EmbeddedChrome = {
    verbsSlot: chrome?.verbsSlot ?? null,
    menuSlot: chrome?.menuSlot ?? null,
    secondarySlot: chrome?.secondarySlot ?? null,
    dangerSlot: chrome?.dangerSlot ?? null,
    omitActions: WORKSPACE_OWN_ACTIONS,
    onMenuDone: () => chrome?.setMenuOpen(false),
  };
  const fullView = adapter.body === 'fullView';
  return (
    <div
      ref={rootRef}
      className="tws-body tws-panel"
      data-testid="tws-entity-body"
      data-kind={tab.kind}
      data-body={adapter.body}
    >
      <AuxEntityPanel
        host={host}
        entityId={tab.entityId as EntityId}
        panelHost={fullView ? 'z4' : 'stack'}
        onOpenEntity={onOpenEntity}
        onClose={closeTab}
        {...(fullView
          ? { story: { open: (id: EntityId) => onOpenEntity(id), selectedId: null, layout: 'full' as const } }
          : {})}
        extraActions={{ onAction: verbs.onAction, wiredActions: verbs.wiredActions }}
        panelProps={{
          activeTab: panelTabOf(tab.ui.subview),
          onTabChange,
          embeddedChrome,
        }}
      />
      {/* The edit sheet `useEntityVerbs` drives; fixed over a scrim, so it
          sits outside the panel's overflow (as FullViewScreen mounts it). */}
      <EditEntityDialog
        flow={verbs.edit}
        fields={verbs.editFields}
        title={verbs.editTitle}
        skillOptions={data.skillOptions}
        attach={host.attachments ? (file: File) => host.attachments!.startUpload(file, tab.entityId) : undefined}
        onAttached={() => data.refetchDetail(tab.entityId)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live status for the strip (Spec A §15) — from live data, never the body
// ---------------------------------------------------------------------------

export type TabLiveStatus = 'running' | 'error' | null;

const RUNNING_STATUSES: ReadonlySet<string> = new Set(['spawning', 'running']);
const ERROR_STATUSES: ReadonlySet<string> = new Set(['failed']);

/**
 * Running / error for a tab, from the live entity stream (the domain store's
 * summaries and details, which events keep current) and session liveness.
 * Works for unmounted tabs. Drafts and the chooser have no live status.
 */
export function useTabLiveStatus(tab: TabRecord | null | undefined): TabLiveStatus {
  const { gate } = useWorkspace();
  const data = gate.data;
  const entityId = tab?.type === 'entity' ? (tab.entityId as EntityId) : null;
  const status = useStore(data.domain.store, (s) => {
    if (!entityId) return null;
    const row = s.entities[entityId] ?? s.details[entityId];
    const state = row?.state as { status?: unknown } | undefined;
    return typeof state?.status === 'string' ? state.status : null;
  });
  if (!entityId) return null;
  if (status !== null && ERROR_STATUSES.has(status)) return 'error';
  if (data.livenessOf(entityId) === 'live' || (status !== null && RUNNING_STATUSES.has(status))) return 'running';
  return null;
}
