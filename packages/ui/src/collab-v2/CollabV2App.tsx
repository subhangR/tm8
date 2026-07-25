/**
 * CollabV2App — standalone mount (ATLAS-owned integration point).
 * W1: mounts the shell (rails + center host + panel stack + router + keyboard)
 * over the seeded MockFacade, with the simulation driver toggleable from a
 * floating control. W1a's EntityPanel plugs in via `renderPanel`, W2's palette
 * via `palette`, W3 screens via `views` as they land.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import './tokens.css';
import type { CollabFacade } from './facade/CollabFacade';
import type { SpaceId } from './types/contract';
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

/**
 * tm8 TOUCH #1 (Keystone, W3 transplant — approved by Orion).
 *
 * Facade selection + a banner slot, and nothing else. Every prop is optional
 * and the no-prop call is byte-for-byte the previous behaviour (seeded mock +
 * simulation control), so existing consumers and the acceptance suite are
 * unaffected.
 *
 * Why here rather than a parallel app root: this file's own header names it the
 * Atlas-owned integration point, and duplicating its composition to swap one
 * value would fork the shell wiring and let the copy rot silently.
 */
export interface CollabV2AppProps {
  /** Defaults to the seeded MockFacade when omitted. */
  facade?: CollabFacade;
  /** Required alongside `facade`; the mock supplies its own via `ids.space`. */
  spaceId?: SpaceId;
  /** Rendered above the shell — the real/mock mode banner. */
  banner?: ReactNode;
  /**
   * tm8 TOUCH #2: screens supplied by the INTEGRATION LAYER, merged over the
   * module's own registry.
   *
   * The module is backend-agnostic and never imports `real/`, but some surfaces
   * are irreducibly node-specific: the Sessions view hosts a live PTY terminal
   * over a tm8 WebSocket and reads a `work_session`, a kind this module's
   * `EntityKind` union does not even contain. Injecting them keeps that code on
   * the tm8 side of the seam instead of forking the shell wiring, and mirrors
   * how `installTm8Kinds()` already adds kinds from outside.
   *
   * Merged LAST, so the integration layer may also override a module screen.
   */
  extraViews?: ViewRegistry;
}

export function CollabV2App({
  facade: injected, spaceId: injectedSpaceId, banner, extraViews,
}: CollabV2AppProps = {}) {
  // The mock world is only constructed when no facade is injected — building a
  // seeded world behind a live server would waste the work and, worse, leave
  // fabricated entities one mistaken reference away from the screen.
  const mock = useMemo(() => (injected ? null : createSeededFacade()), [injected]);
  const facade = (injected ?? mock) as CollabFacade & { ids?: { space: SpaceId } };
  const simulation = useMemo(() => (mock ? createSimulation(mock) : null), [mock]);
  const [simOn, setSimOn] = useState(false);
  const galleryRoute = useGalleryRoute();
  const spaceId = injectedSpaceId ?? (facade.ids?.space as SpaceId);

  useEffect(() => connectStores(facade, spaceId), [facade, spaceId]);
  useEffect(() => startRecentsTracker(), []);

  useEffect(() => {
    if (!simulation) return;
    if (simOn) simulation.start();
    else simulation.stop();
    return () => simulation.stop();
  }, [simOn, simulation]);

  return (
    <PopoverProvider>
      <CollabFacadeProvider facade={facade}>
      <CollabDndProvider>
      <div className="cv2-root" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        {banner}
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
              views={extraViews ? { ...VIEWS, ...extraViews } : VIEWS}
              palette={<CommandPalette />}
              renderPanel={(p) => <PanelBody {...p} />}
            />
          )}
        </div>
        <ToastViewport />
        {/* tm8 TOUCH #1: the simulation control belongs to the mock world and
            is hidden against a real server — a "sim on/off" toggle over live
            data would imply the events are synthetic when they are not. */}
        {simulation && (
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
        )}
      </div>
      </CollabDndProvider>
      </CollabFacadeProvider>
    </PopoverProvider>
  );
}

export default CollabV2App;
