/**
 * GateApp — the complete T0-1 master screen, composed (R5 THE GATE).
 *
 * Boot order matters and is deliberate: identity/spaces/menu resolve before
 * anything renders content, the rail falls back to the shipped default when the
 * seam has no menu row (which is the fixture path, so the gate exercises
 * fail-closed for real), and the workspace mounts only once a space exists.
 *
 * The three lanes keep their authority: geometry sizes, navStore owns panel
 * state and the URL, the panels own anatomy. This file is composition only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EntityId, EntitySummary, SpaceId } from '@tm8/contract';
import {
  MenuRail,
  NoticeHost,
  SpaceTabBar,
  useNotices,
  type KindPresenter,
  type MenuTarget,
} from '../shell';
import type { NavPort } from '../shell/nav-port';
import { navStore, useNavStore } from '../stores/navStore';
import { CommandPalette, type PaletteView } from '../shell/CommandPalette';
import { createKeyboardController, type KeyboardController } from '../keyboard';
import { allKinds } from '../domain';
import { getKind } from '../domain';
import { buildSpawnInput, newLaunchMutationId } from '../domain/launch';
import type { DetailReasons } from '../panels';
import { CatchBoundary } from '../panels/detail/CatchBoundary';
import {
  authoredFromHollowReason,
  homeActivityLoadEarlierReason,
  presenceHollowReason,
} from '../fixtures';
import { useGateData } from './useGateData';
import { useSidePanelKinds } from './useSidePanelKinds';
import { useLaunchSheet } from './useLaunchSheet';
import { useTheme } from '../theme/useTheme';
import { AccountMenu, useAuthActions } from '../auth';
import { WorkspaceView } from './WorkspaceView';
import { EntityView } from './EntityView';
import { HomeScreen } from '../home';
import { GraphScreen } from '../graph';
import { AddServerDialog, LOCAL_SERVER, type AddServerInput, type UiServer } from '../servers';

/**
 * §5.1's ruled side-panel defaults: left=tasks, right=sessions. These are the
 * only kind names in the shell layer; §15.2 wants them in `domain/` beside the
 * registry (the D18 precedent for SHIPPED_DEFAULT_MENU) — flagged to
 * fe-coordinator for routing rather than moved across a lane boundary here.
 */
const DEFAULT_LEFT_KIND = 'task';
const DEFAULT_RIGHT_KIND = 'work_session';

export interface GateAppProps {
  activeServer?: UiServer;
  servers?: readonly UiServer[];
  onSelectServer?(id: string): void;
  onAddServer?(input: AddServerInput): Promise<unknown>;
}

export function GateApp(props: GateAppProps = {}) {
  // null when this GateApp is not inside an <AuthGate> — the shell tests, and
  // any host that has not mounted the gate.
  const authAccount = useAuthActions()?.account ?? null;

  // Boot hydrates the RULED defaults; the viewer's persisted choice is applied
  // after, because the persistence is scoped per (viewer, space) and the space
  // id only exists once the seam has answered. Passing a placeholder id here
  // would silently disable persistence altogether — the storage key would never
  // match the one the next session reads.
  const activeServer = props.activeServer ?? LOCAL_SERVER;
  const data = useGateData({
    leftKind: DEFAULT_LEFT_KIND,
    rightKind: DEFAULT_RIGHT_KIND,
    serverBaseUrl: activeServer.routeBaseUrl,
  });
  const kinds = useSidePanelKinds({
    viewerId: 'viewer',
    spaceId: data.spaceId,
    defaultLeft: DEFAULT_LEFT_KIND,
    defaultRight: DEFAULT_RIGHT_KIND,
  });

  // A kind chosen after boot (or restored from storage) may never have been
  // queried — hydrate it on demand rather than rendering an empty panel that
  // looks like "this kind has no rows".
  useEffect(() => {
    data.ensureKind(kinds.leftKind);
    data.ensureKind(kinds.rightKind);
  }, [data, kinds.leftKind, kinds.rightKind]);
  const notices = useNotices();

  // Theme: PERSISTED, with a prefers-color-scheme default (LLD §11). It was an
  // unpersisted useState seeded to light, so every reload discarded the
  // viewer's choice. The control's home is still the account menu (D1).
  const { theme, setTheme, toggle: toggleTheme } = useTheme();
  const [menuCollapsed, setMenuCollapsed] = useState(false);
  const [addServerOpen, setAddServerOpen] = useState(false);
  const [activeTarget, setActiveTarget] = useState<MenuTarget | null>({
    type: 'view',
    ref: 'workspace',
  });

  const stack = useNavStore((s) => s.stack);
  const pinned = useNavStore((s) => s.pinned);

  // D44/D51 launch sheet. Transient client state — never the URL (§11), so a
  // shared link cannot open someone else's half-configured spawn surface.
  // Obligation 2 rides here: `hostedIds` is what clears the sheet when its
  // subject stops being hosted, by ANY route out (pop, close, promote, or a
  // hydration nobody dispatched).
  const launch = useLaunchSheet({ hostedIds: [...pinned, ...stack] });
  /* T5-5 annotation 6 (Surface Audit): a spawn refusal renders IN the sheet,
     never as a toast. The sheet therefore stays OPEN through the spawn and
     closes only on success; the refusal state lives here because the sheet
     is stateless about outcomes by design. */
  const [launchRefusal, setLaunchRefusal] = useState<{ cause: string; detail: string } | null>(null);

  // Bind A1a's store to my narrow port. This is the adapter nav-port.ts exists
  // for: shell drives a small, explicit surface rather than the whole store.
  const nav = useMemo<NavPort>(() => {
    const actions = navStore.getState();
    return {
      stack,
      pinned,
      push: (id) => actions.push(id),
      pop: () => actions.pop(),
      close: (id) => actions.close(id),
      pin: (id) => actions.pin(id),
      unpin: (id) => actions.unpin(id),
      promote: (id) => actions.promote(id),
      applyNormalization: (next) => actions.applyNormalization(next),
    };
  }, [stack, pinned]);

  /**
   * GAP #0 (Surface Audit final): the palette and the C6 controller were
   * NEVER MOUNTED while the UI's own copy taught "/ opens the palette" —
   * a plain promise in visible copy, silently broken. This mounts the REAL
   * controller (keyboard/controller.ts, chords guaranteed:true) as the one
   * window keydown route; the old hand-rolled ⌘\ listener retired into it.
   */
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const keyboardRef = useRef<KeyboardController | null>(null);
  const commandSink = useRef<(command: string) => void>(() => undefined);
  if (keyboardRef.current === null) {
    keyboardRef.current = createKeyboardController({
      onCommand: (command) => commandSink.current(command),
    });
  }
  commandSink.current = (command: string) => {
    if (command === 'palette.open') setPaletteOpen(true);
    if (command === 'menu.toggle') setMenuCollapsed((collapsed) => !collapsed);
  };
  useEffect(() => {
    const kb = keyboardRef.current;
    if (!kb) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const textEntry =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      kb.setContext({
        textEntry,
        modalDepth: paletteOpen || (launch.isModalOpen?.() ?? false) ? 1 : 0,
      });
      // Legacy ⌘\ stays honored even if the binding table names it
      // differently — losing a shipped shortcut would be its own regression.
      if (event.key === '\\' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setMenuCollapsed((collapsed) => !collapsed);
        return;
      }
      const result = kb.handle({
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
      });
      if (result.handled && result.consumed) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [paletteOpen, launch]);

  /**
   * Kind refs resolve through the DOMAIN REGISTRY (§15.2) — shell never maps a
   * kind itself. `getKind` falls back to the `c:*` row on a miss, so the
   * identity check is what makes an unknown ref unrenderable rather than
   * silently generic (A1a's landing note).
   */
  const presentKind = useCallback<KindPresenter>((ref) => {
    const row = getKind(ref);
    if (row.kind !== ref) return null;
    const live = ref === DEFAULT_RIGHT_KIND ? data.liveIds.length : undefined;
    return { label: row.labelPlural, icon: row.icon as unknown as string, live };
  }, [data.liveIds.length]);

  const reasons = useMemo<DetailReasons>(
    () => ({
      presenceHollow: presenceHollowReason,
      versionHistory: 'Version history isn’t available yet.',
      provenanceHollow: authoredFromHollowReason,
      shareUnavailable: 'Sharing into a session isn’t available yet.',
      withdrawUnavailable: 'Withdrawing a handoff isn’t available yet.',
    }),
    [],
  );
  void homeActivityLoadEarlierReason; // D7.1 — consumed by HomeView at fan-out.

  /* Palette data. Results search WHAT THE APP HAS READ (the hydrated kind
     caches) — honest scope for the fixture path; a seam-side text search is
     the upgrade path and this stays correct when it lands. */
  const paletteResults = useMemo(() => {
    const q = paletteQuery.trim().toLowerCase();
    if (!q) return [];
    const seen = new Set<string>();
    const out: EntitySummary[] = [];
    for (const row of allKinds()) {
      for (const item of data.rowsFor(row.kind)(undefined)) {
        if (seen.has(item.id)) continue;
        if (item.title.toLowerCase().includes(q)) {
          seen.add(item.id);
          out.push(item);
          if (out.length >= 12) return out;
        }
      }
    }
    return out;
  }, [paletteQuery, data]);

  const paletteViews = useMemo<PaletteView[]>(
    () => [
      { id: 'view:workspace', label: 'Workspace', glyph: '#' },
      { id: 'view:graph', label: 'Graph', glyph: '◉' },
      { id: 'view:channels', label: 'Channels', glyph: '#' },
      ...allKinds()
        .filter((row) => !row.kind.startsWith('c:'))
        .map((row) => ({ id: `kind:${row.kind}`, label: row.labelPlural, glyph: row.chip.glyph })),
    ],
    [],
  );
  const openPaletteView = useCallback((id: string) => {
    const [scope, ref] = id.split(':', 2) as [string, string];
    if (scope === 'view') setActiveTarget({ type: 'view', ref: ref as never });
    if (scope === 'kind') setActiveTarget({ type: 'kind', ref });
    setPaletteOpen(false);
  }, []);

  return (
    <div className="cv2-root" data-theme={theme === 'dark' ? 'dark' : undefined}>
      <div className="shell-root">
        <SpaceTabBar
          activeServer={{
            label: activeServer.label,
            reachability: activeServer.reachability,
          }}
          spaces={data.spaces}
          activeSpaceId={data.spaceId || null}
          onSelectSpace={(id: SpaceId) => void id}
          accountInitial="A"
          onOpenPalette={() => setPaletteOpen(true)}
          // D1: theme's one home is the account menu. No tab-bar toggle.
          onOpenAccount={toggleTheme}
          // T3-3, user-ordered 2026-07-29: the real account menu — signed-in
          // name, theme, sign-out — replaces the avatar ONCE THERE IS AN
          // ACCOUNT. Undefined otherwise, so a GateApp rendered without an
          // AuthGate (every existing test) keeps the avatar fallback and its
          // behaviour is unchanged.
          accountSlot={
            authAccount ? <AccountMenu theme={theme} onThemeChange={setTheme} /> : undefined
          }
        />

        <div className="shell-body">
          <MenuRail
            config={data.menu.config}
            collapsed={menuCollapsed}
            onToggle={() => setMenuCollapsed((c) => !c)}
            activeTarget={activeTarget}
            onNavigate={setActiveTarget}
            presentKind={presentKind}
            servers={props.servers}
            activeServerId={activeServer.id}
            onSelectServer={(id) => {
              navStore.getState().applyNormalization({ stack: [], pinned: [] });
              navStore.getState().setSession(null);
              props.onSelectServer?.(id);
            }}
            onAddServer={props.onAddServer ? () => setAddServerOpen(true) : undefined}
          />

          {/* The REAL error boundary wraps the whole view region: a crashed
              screen renders the designed error state with retry; the rail and
              tab bar above stay live for navigating away. */}
          <CatchBoundary label="view">
          {data.ready && activeTarget?.type === 'view' && activeTarget.ref === 'graph' ? (
            /* ◉ Graph follows the D65 pattern exactly:
               an activated menu view replaces the centre WHOLESALE — full
               width, no side lists; node C1 clicks open the Z3 aside inside
               the screen. Its initial lens comes from graph.query; durable
               entity/edge events keep the projected nodes current. */
            <GraphScreen
              data={data}
              serverBaseUrl={activeServer.routeBaseUrl}
              reasons={reasons}
              nodes={data.graph.nodes}
              edges={data.graph.edges}
              now={data.graph.now}
              loading={data.graph.loading}
              error={data.graph.error}
              onRetry={data.graph.refresh}
            />
          ) : data.ready &&
            (activeTarget?.type === 'kind' ||
              (activeTarget?.type === 'view' && activeTarget.ref === 'channels')) ? (
            /* D65: a rail KIND row opens its EntityView — wide list, Z3 aside
               on row click, Z4 full on promote. The workspace stays the one
               three-panel exception below. CHANNELS is a contract VIEW ref
               but IS the channel EntityView (Surface Audit: it fell through
               to the workspace silently — the misroute-honesty class). */
            <EntityView
              data={data}
              serverBaseUrl={activeServer.routeBaseUrl}
              kind={activeTarget.type === 'kind' ? activeTarget.ref : 'channel'}
              reasons={reasons}
              onNotice={notices.push}
              onKindChange={(next) => setActiveTarget({ type: 'kind', ref: next })}
            />
          ) : data.ready && activeTarget?.type === 'view' && activeTarget.ref === 'dashboard' ? (
            /* T5-1 Home — the first void route dispatching to a real screen
               (surface wave, home lane). Above the unbuilt-view branch, whose
               placeholder stopped being true the moment this landed. */
            <HomeScreen
              data={data}
              spaceLabel={data.spaces.find((sp) => sp.id === data.spaceId)?.name}
              onOpenEntity={(id) => nav.push?.(id as EntityId)}
            />
          ) : data.ready &&
            activeTarget?.type === 'view' &&
            activeTarget.ref !== 'workspace' ? (
            /* Unbuilt view refs (dashboard/feed/inbox/settings) SAY SO —
               rendering the workspace under a highlighted Dashboard row was a
               silent lie about where you are (same audit, same class). */
            <div className="ev-root" data-testid="unbuilt-view">
              <p className="evt-empty" style={{ margin: 24 }}>
                {`${activeTarget.ref} isn’t built yet — its designed screen is coming. Nothing is hidden here; it does not exist in this build.`}
              </p>
            </div>
          ) : data.ready ? (
            <WorkspaceView
              data={data}
              serverBaseUrl={activeServer.routeBaseUrl}
              nav={nav}
              leftKind={kinds.leftKind}
              rightKind={kinds.rightKind}
              leftWidth={kinds.leftWidth}
              rightWidth={kinds.rightWidth}
              onLeftKindChange={kinds.setLeftKind}
              onRightKindChange={kinds.setRightKind}
              onMoveSidePanel={kinds.movePanel}
              onResizeSidePanel={kinds.resizePanel}
              onResetSidePanelWidth={kinds.resetPanelWidth}
              onLaunchOpen={(id) => launch.open(id)}
              launchSubjectId={launch.subjectId}
              launchRefusal={launchRefusal}
              isModalOpen={launch.isModalOpen}
              onLaunchCancel={() => {
                setLaunchRefusal(null);
                launch.close();
              }}
              // D44: the sheet's Launch PERFORMS. A brass primary that cannot
              // do its verb reads as working at a glance and only corrects
              // itself after a click — the same misleading-glance shape as a
              // transient refusal wearing the permanent form. The honest fix
              // is to wire it, not to grey it out.
              onLaunchSubmit={(config) => {
                setLaunchRefusal(null);
                void data
                  .spawn(
                    buildSpawnInput({
                      clientMutationId: newLaunchMutationId(),
                      spaceId: data.spaceId,
                      config,
                      taskIds: [config.subjectId],
                      title: data.detailOf(config.subjectId)?.title,
                    }),
                  )
                  .then((sessionId) => {
                    launch.close();
                    setActiveTarget({ type: 'view', ref: 'workspace' });
                    nav.push(sessionId);
                    notices.push({
                      id: 'launch-done',
                      tone: 'info',
                      title: 'Session launched',
                      body: 'The live terminal is open in the workspace.',
                      ttlMs: 6000,
                    });
                  })
                  .catch((error: unknown) =>
                    // A refusal is a FACT about the node and it renders IN
                    // THE SHEET beside the config that provoked it — the
                    // sheet stays open, nothing toasts (T5-5 annotation 6;
                    // the audit found this card built and dead).
                    setLaunchRefusal({
                      cause: 'Launch refused',
                      detail: String((error as { message?: string })?.message ?? error),
                    }),
                  );
              }}
              onSpawn={async (input) => {
                const sessionId = await data.spawn(input);
                setActiveTarget({ type: 'view', ref: 'workspace' });
                nav.push(sessionId);
              }}
              menuCollapsed={menuCollapsed}
              reasons={reasons}
              onNotice={notices.push}
              onPinRefusal={(_id: EntityId, refusal: string) =>
                notices.push({
                  id: 'pin-refused',
                  tone: 'warn',
                  title: 'Panel not pinned',
                  body: refusal,
                  ttlMs: 6000,
                })
              }
            />
          ) : data.bootError ? (
            /* GAP-1 (data-wiring handover): with the real seam now the
               default, an unreachable node is a NORMAL state and must be
               STATED — never a spinner that resolves for nobody, never a
               silent fall-back to fixtures. */
            <div className="shell-boot" role="alert">
              <strong>Can’t reach the tm8 node.</strong>
              <div>{data.bootError}</div>
              <div>The workspace is empty because nothing could be read — not because there is nothing in it.</div>
            </div>
          ) : (
            <div className="shell-boot" role="status">
              loading workspace…
            </div>
          )}
          </CatchBoundary>
        </div>

        <CommandPalette
          open={paletteOpen}
          results={paletteResults}
          views={paletteViews}
          ctx={{ spaceId: data.spaceId }}
          onQueryChange={setPaletteQuery}
          onOpenEntity={(id) => {
            nav.push?.(id as EntityId);
            setPaletteOpen(false);
          }}
          onOpenView={openPaletteView}
          onDismiss={() => setPaletteOpen(false)}
        />
        <NoticeHost notices={notices.notices} onDismiss={notices.dismiss} />
        <AddServerDialog
          open={addServerOpen}
          onDismiss={() => setAddServerOpen(false)}
          onAdd={async (input) => {
            if (!props.onAddServer) throw new Error('Adding Servers is unavailable.');
            await props.onAddServer(input);
          }}
        />
      </div>
    </div>
  );
}
