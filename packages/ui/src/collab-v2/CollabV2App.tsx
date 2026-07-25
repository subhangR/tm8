/**
 * CollabV2App — standalone mount (ATLAS-owned integration point).
 * W1: mounts the shell (rails + center host + panel stack + router + keyboard)
 * over the seeded MockFacade, with the simulation driver toggleable from a
 * floating control. W1a's EntityPanel plugs in via `renderPanel`, W2's palette
 * via `palette`, W3 screens via `views` as they land.
 */
import { useEffect, useMemo, useState } from 'react';
import './tokens.css';
import { CollabFacadeProvider, EntityFullView, EntityPanel } from './entity';
import { Gallery } from './gallery';
import { channelHubSlot, channelViews } from './screens/channel';
import { docsViews } from './screens/docs';
import { homeViews } from './screens/home';
import { inboxViews } from './screens/inbox';
import { leaderboardViews } from './screens/leaderboard';
import { settingsViews } from './screens/settings';
import { tasksViews } from './screens/tasks';
import { teamViews } from './screens/team';
import { trackingViews } from './screens/tracking';
import { CollabDndProvider, DropSurface, promoteReactionsSlot, surfaceForEntity, targetRef } from './interactions';
import type { PanelSlotProps, ShellViewProps, ViewRegistry } from './shell';
import { useGraphStore } from './stores';
import { connectionsSlot } from './subsystems/rail';
import { ReactionsPointsBar } from './subsystems/reactions';
import { discussionSlot, ThreadGallery } from './subsystems/thread';

/**
 * Panel body: EntityPanel with the W2 subsystem slots, wrapped as a grammar
 * drop surface for its own entity (drop a doc/member/task onto an open panel
 * = drop onto the entity; surfaceForEntity infers task/actor/channel, null
 * disables). Summary comes from the graph store — panels open from cards and
 * chips, so it is already ingested.
 */
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

/**
 * Generic Z4 route: kind-agnostic by construction — EntityFullView picks its
 * layout from the registry; margin (doc reader) and hub (channel) fill via
 * subsystem slots. Collapse = history back: promote pushed one entry, so back
 * restores the pre-promote center view including its panel stack.
 */
function EntityZ4Route({ entityId }: ShellViewProps) {
  if (!entityId) {
    return (
      <div className="cv2-collection__empty" role="status">
        <p>No entity selected.</p>
      </div>
    );
  }
  return (
    <EntityFullView
      key={entityId}
      entityId={entityId}
      onCollapse={() => window.history.back()}
      slots={{ margin: discussionSlot(), hub: channelHubSlot() }}
    />
  );
}

const VIEWS: ViewRegistry = {
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
import { IconBtn, PopoverProvider } from './kit';
import { createSeededFacade, createSimulation } from './mock';
import { ShellLayout } from './shell';
import { connectStores } from './stores';
import { CommandPalette, startRecentsTracker } from './subsystems/palette';
import { ToastViewport } from './subsystems/live';

/** QA surface: `#/gallery` renders the kind × zoom × state gallery instead of the shell. */
function useGalleryRoute(): boolean {
  const [on, setOn] = useState(() => window.location.hash.startsWith('#/gallery'));
  useEffect(() => {
    const sync = () => setOn(window.location.hash.startsWith('#/gallery'));
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  return on;
}

export function CollabV2App() {
  const facade = useMemo(() => createSeededFacade(), []);
  const simulation = useMemo(() => createSimulation(facade), [facade]);
  const [simOn, setSimOn] = useState(false);
  const galleryRoute = useGalleryRoute();
  const spaceId = facade.ids.space;

  useEffect(() => connectStores(facade, spaceId), [facade, spaceId]);
  useEffect(() => startRecentsTracker(), []);

  useEffect(() => {
    if (simOn) simulation.start();
    else simulation.stop();
    return () => simulation.stop();
  }, [simOn, simulation]);

  return (
    <PopoverProvider>
      <CollabFacadeProvider facade={facade}>
      <CollabDndProvider>
      <div className="cv2-root" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, minHeight: 0, overflow: galleryRoute ? 'auto' : undefined }}>
          {galleryRoute ? (
            <>
              <Gallery />
              <ThreadGallery />
            </>
          ) : (
            <ShellLayout
              facade={facade}
              spaceId={spaceId}
              views={VIEWS}
              palette={<CommandPalette />}
              renderPanel={(p) => <PanelBody {...p} />}
            />
          )}
        </div>
        <ToastViewport />
        <div
          style={{
            position: 'fixed', right: 16, bottom: 16, zIndex: 60,
            display: 'flex', gap: 8, alignItems: 'center',
            background: 'var(--pn-surface)', border: '1px solid var(--pn-line)',
            borderRadius: 'var(--pn-r-lg)', padding: '6px 10px', boxShadow: 'var(--pn-sh-md)',
          }}
        >
          <IconBtn
            aria-label={simOn ? 'Stop simulation' : 'Start simulation'}
            active={simOn}
            onClick={() => setSimOn((v) => !v)}
          >
            {simOn ? '◼' : '▶'}
          </IconBtn>
          <span className="t-secondary">
            sim {simOn ? 'on' : 'off'} · {simulation.stepIndex}/{simulation.totalSteps}
          </span>
        </div>
      </div>
      </CollabDndProvider>
      </CollabFacadeProvider>
    </PopoverProvider>
  );
}

export default CollabV2App;
