/**
 * W5 ACCEPTANCE RIG (Sentinel-owned) — the five golden workflows of
 * `01-IMPLEMENTATION-PLAN.md` §L8 / `COLLAB_V2_UI_UX_BRIEF.md` §10 driven
 * against the REAL composition.
 *
 * `renderApp` mounts the same provider tower + view registry + panel body that
 * `CollabV2App` mounts, with three test-only substitutions:
 *   - a latency-0 seeded facade on a ManualClock (undo TTL is testable),
 *   - a memory router target instead of `window.location`,
 *   - an explicit `spaceId` (CollabV2App reads it from `facade.ids`, same value).
 *
 * NOTE / DEFECT (reported to Atlas): `CollabV2App.tsx` exports only the
 * component — its `VIEWS` registry and `PanelBody` are module-private, so this
 * file must RE-ASSEMBLE the identical composition from the same view modules
 * rather than import the real one. `appViewRegistryParity` below pins the two
 * together (kind + count) so a drift in CollabV2App fails here.
 */
import { act, cleanup, render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { CollabFacadeProvider, EntityFullView, EntityPanel } from '../../entity';
import { PopoverProvider } from '../../kit';
import {
  CollabDndProvider, DropSurface, promoteReactionsSlot, surfaceForEntity, targetRef,
} from '../../interactions';
import { useCreationStore } from '../../interactions/create';
import { useInteractionMenuStore } from '../../interactions/keyboard';
import { useDndStore } from '../../interactions/dnd';
import { useUndoStore } from '../../interactions/undo';
import { createSeededWorld, MockFacade } from '../../mock';
import { channelHubSlot, channelViews } from '../../screens/channel';
import { docsViews } from '../../screens/docs';
import { homeViews } from '../../screens/home';
import { inboxViews } from '../../screens/inbox';
import { leaderboardViews } from '../../screens/leaderboard';
import { settingsViews } from '../../screens/settings';
import { tasksViews } from '../../screens/tasks';
import { teamViews } from '../../screens/team';
import { trackingViews } from '../../screens/tracking';
import { ShellLayout, createMemoryTarget, type MemoryTarget } from '../../shell';
import type { PanelSlotProps, ShellViewProps, ViewRegistry } from '../../shell';
import {
  connectStores, useCollectionsStore, useGraphStore, useNavStore, usePresenceStore,
} from '../../stores';
import { CommandPalette, startRecentsTracker } from '../../subsystems/palette';
import { ToastViewport, useToastStore } from '../../subsystems/live';
import { connectionsSlot } from '../../subsystems/rail';
import { ReactionsPointsBar } from '../../subsystems/reactions';
import { discussionSlot } from '../../subsystems/thread';
import { ENTITY_DRAG_MIME } from '../../entity';
import type { EntitySummary } from '../../types/contract';
import { ManualClock } from '../foundation/helpers';

export { ManualClock };

// --- jsdom shims xyflow wants (graph layout is reachable from tasks/graph) ---
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}
if (!('DOMMatrixReadOnly' in globalThis)) {
  class DOMMatrixReadOnlyStub {
    m22 = 1;
    constructor(_transform?: string) {}
  }
  (globalThis as Record<string, unknown>).DOMMatrixReadOnly = DOMMatrixReadOnlyStub;
}

// ---------------------------------------------------------------------------
// the composition (mirror of CollabV2App)
// ---------------------------------------------------------------------------

function PanelBody(p: PanelSlotProps) {
  const summary = useGraphStore((s) => s.entities[p.entityId]);
  const surface = summary ? surfaceForEntity(summary) : null;
  return (
    <DropSurface target={summary && surface ? targetRef(summary, surface) : null}>
      <EntityPanel
        entityId={p.entityId}
        onClose={p.onClose}
        slots={{
          discussion: discussionSlot({
            reactionsSlot: promoteReactionsSlot((m) => (
              <ReactionsPointsBar entityId={m.id} entity={m} size="sm" hideZeroCounts />
            )),
          }),
          connections: connectionsSlot({ onOpenEntity: p.onOpenEntity }),
        }}
      />
    </DropSurface>
  );
}

function EntityZ4Route({ entityId }: ShellViewProps) {
  if (!entityId) return <div className="cv2-collection__empty" role="status"><p>No entity selected.</p></div>;
  return (
    <EntityFullView
      key={entityId}
      entityId={entityId}
      onCollapse={() => {}}
      slots={{ margin: discussionSlot(), hub: channelHubSlot() }}
    />
  );
}

/** Byte-for-byte the same registry CollabV2App builds. */
export const APP_VIEWS: ViewRegistry = {
  ...homeViews,
  ...inboxViews,
  ...tasksViews,
  ...docsViews,
  ...teamViews,
  ...leaderboardViews,
  ...channelViews,
  ...trackingViews,
  ...settingsViews,
  entity: EntityZ4Route,
};

// ---------------------------------------------------------------------------
// rig
// ---------------------------------------------------------------------------

export interface AcceptanceRig {
  facade: MockFacade;
  clock: ManualClock;
  ids: MockFacade['ids'];
  now: () => number;
  target: MemoryTarget;
  /** Live durable events seen since mount (activity/notification assertions). */
  events: { type: string; [k: string]: unknown }[];
}

export function createRig(hash?: (ids: MockFacade['ids']) => string): AcceptanceRig {
  const clock = new ManualClock();
  const facade = new MockFacade(createSeededWorld(clock.now), { latency: 0 });
  const target = createMemoryTarget(
    hash ? hash(facade.ids) : `#/s/${encodeURIComponent(facade.ids.space)}/home`,
  );
  return { facade, clock, ids: facade.ids, now: clock.now, target, events: [] };
}

export function resetStores(): void {
  useGraphStore.getState().reset();
  useCollectionsStore.getState().reset();
  usePresenceStore.getState().reset();
  useNavStore.getState().reset();
  useToastStore.getState().clear();
  useUndoStore.getState().clear();
  useDndStore.getState().endDrag();
  useDndStore.getState().closeMenu();
  useCreationStore.getState().close();
  useInteractionMenuStore.getState().close();
}

export interface MountedApp extends RenderResult {
  disconnect: () => void;
}

/**
 * Mount the full app: providers + shell + real views + real panel body +
 * palette + toasts, with the stores connected to the facade exactly as
 * CollabV2App connects them.
 */
export function renderApp(rig: AcceptanceRig, opts: { connect?: boolean } = {}): MountedApp {
  const stop: (() => void)[] = [];
  if (opts.connect !== false) {
    stop.push(connectStores(rig.facade, rig.ids.space));
    stop.push(startRecentsTracker());
  }
  stop.push(rig.facade.subscribe(rig.ids.space, (e) => {
    rig.events.push(e as unknown as { type: string });
  }));
  const result = render(
    <div className="cv2-root">
      <PopoverProvider>
        <CollabFacadeProvider facade={rig.facade}>
          <CollabDndProvider now={rig.now}>
            <ShellLayout
              facade={rig.facade}
              spaceId={rig.ids.space}
              views={APP_VIEWS}
              palette={<CommandPalette />}
              renderPanel={(p) => <PanelBody {...p} />}
              routerTarget={rig.target}
            />
            <ToastViewport />
          </CollabDndProvider>
        </CollabFacadeProvider>
      </PopoverProvider>
    </div>,
  );
  return Object.assign(result, { disconnect: () => stop.forEach((f) => f()) });
}

/** Providers only — for workflows that drive a screen without the shell chrome. */
export function renderBare(rig: AcceptanceRig, ui: ReactNode): RenderResult {
  return render(
    <div className="cv2-root">
      <PopoverProvider>
        <CollabFacadeProvider facade={rig.facade}>
          <CollabDndProvider now={rig.now}>
            {ui}
            <ToastViewport />
          </CollabDndProvider>
        </CollabFacadeProvider>
      </PopoverProvider>
    </div>,
  );
}

// ---------------------------------------------------------------------------
// small assertion helpers
// ---------------------------------------------------------------------------

/**
 * Unmount, then let every in-flight facade promise resolve INSIDE act().
 *
 * Panels, rails and `ChipById` fetch lazily, so a test that asserts and returns
 * leaves resolved-but-unapplied promises behind; React then logs
 * "not wrapped in act(...)" against a component the test no longer cares about.
 * Draining here keeps the acceptance run's console signal clean, so a REAL
 * warning is visible instead of buried.
 */
export async function settle(): Promise<void> {
  // Drain WHILE still mounted so the updates apply inside act(), then unmount.
  // Several rounds: a rail fetch resolves, renders chips, and each chip starts
  // its own fetch — the cascade needs more than one microtask turn.
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });
  }
  cleanup();
}

export function toastMessages(): string[] {
  return useToastStore.getState().toasts.map((t) => t.message);
}

/** Seed the graph store's known-entity cache (keyboard menus + panels read it). */
export async function ingest(rig: AcceptanceRig, ...ids: string[]): Promise<EntitySummary[]> {
  const summaries = await Promise.all(ids.map((id) => rig.facade.getEntity(id)));
  useGraphStore.getState().ingestSummaries(summaries);
  return summaries;
}

export function makeDataTransfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    setData: (type: string, value: string) => { data.set(type, value); },
    getData: (type: string) => data.get(type) ?? '',
    clearData: () => data.clear(),
    get types() { return Array.from(data.keys()); },
    dropEffect: 'none',
    effectAllowed: 'all',
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    setDragImage: () => {},
  } as unknown as DataTransfer;
}

export function dragPayloadFor(entity: EntitySummary): DataTransfer {
  const dt = makeDataTransfer();
  dt.setData(ENTITY_DRAG_MIME, JSON.stringify({
    entityId: entity.id, kind: entity.kind, title: entity.title,
  }));
  return dt;
}

/**
 * Flatten a Connections read to `"<direction>:<type>" → [otherEntityIds]`.
 * Direction is the group's, so `out['outgoing:attached_to']` reads
 * "this entity is attached_to …". The "other" end is the far side of the edge
 * relative to `id`.
 */
export async function edgeIndex(
  rig: AcceptanceRig, id: string,
): Promise<Record<string, string[]>> {
  const conns = await rig.facade.getConnections(id);
  const out: Record<string, string[]> = {};
  for (const group of [...conns.outgoing, ...conns.incoming]) {
    const bucket = (out[`${group.direction}:${group.type}`] ??= []);
    for (const edge of group.edges) {
      bucket.push(edge.source.id === id ? edge.target.id : edge.source.id);
    }
  }
  return out;
}

/** Every activity verb recorded on an entity, newest first. */
export async function activityVerbs(rig: AcceptanceRig, id: string): Promise<string[]> {
  const page = await rig.facade.getActivity(id);
  return page.items.map((i) => i.verb);
}
