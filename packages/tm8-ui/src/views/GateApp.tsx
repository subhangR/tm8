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
  type MenuDynamicGroup,
  type MenuTarget,
} from '../shell';
import type { NavPort } from '../shell/nav-port';
import { screenStackStore } from '../stores/screenStackStore';
import { navStore, useNavStore } from '../stores/navStore';
import { CommandPalette, type PaletteView } from '../shell/CommandPalette';
import { PromptsOverlay } from '../prompts';
import { createKeyboardController, type KeyboardController } from '../keyboard';
import { allKinds } from '../domain';
import { getKind } from '../domain';
import { buildSpawnInput, newLaunchMutationId } from '../domain/launch';
import type { DetailReasons } from '../panels';
import { BootLoader } from '../kit';
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
import { ChannelView } from './ChannelView';
import { SettingsShell, settingsPortFromSeam } from '../settings-space';
import { nodeKeyOf } from '../data/launch-cache';
import { NewSpaceProjectDialog, type ProjectOnboardingPort } from '../projects';

/**
 * §5.1's ruled side-panel defaults: left=tasks, right=sessions. These are the
 * only kind names in the shell layer; §15.2 wants them in `domain/` beside the
 * registry (the D18 precedent for SHIPPED_DEFAULT_MENU) — flagged to
 * fe-coordinator for routing rather than moved across a lane boundary here.
 */
const DEFAULT_LEFT_KIND = 'task';
/**
 * SESSIONS STAY HERE (user report 2026-08-01, third pass).
 *
 * This briefly defaulted to `channel`, to fix channels being invisible on
 * arrival after they left the rail. That traded one missing collection for
 * another: the workspace has TWO docks and three collections that want to be
 * on screen, so pointing a dock at channels took sessions off the screen, and
 * the next report was "I don't see sessions". The dock is not the place to
 * solve channel visibility — reverted rather than left to rotate the problem.
 */
const DEFAULT_RIGHT_KIND = 'work_session';
/**
 * The green ● in the rail counts running PTYs, which is a SESSION fact and
 * nothing else. It used to be spelled `ref === DEFAULT_RIGHT_KIND`, which was
 * only ever true by coincidence — the moment the right dock defaulted to
 * another kind, that kind would have inherited a live count it has no meaning
 * for. Named for what it is instead.
 */
const LIVE_COUNT_KIND = 'work_session';

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
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [activeTarget, setActiveTarget] = useState<MenuTarget | null>({
    type: 'view',
    ref: 'workspace',
  });
  const projectOnboardingPort = useMemo<ProjectOnboardingPort | null>(() => {
    const setup = data.seam.projectSetup;
    if (!setup) return null;
    return {
      ...setup,
      createMemory: (input) => data.seam.commands.createEntity(input),
    };
  }, [data.seam]);

  const stack = useNavStore((s) => s.stack);
  const pinned = useNavStore((s) => s.pinned);
  const contentSurface = useNavStore((s) => s.contentSurface);
  // Hydration resolves the active-space display actor through the same
  // identity read that supplies the account face. Reuse its canonical member
  // id here: a second resolver/read would let the two surfaces disagree.
  const viewerMemberId = data.viewerActor?.id ?? null;

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
      surfaceOf: (id) => contentSurface[id] ?? null,
      setContentSurface: (id, surface) => actions.setContentSurface(id, surface),
    };
  }, [stack, pinned, contentSurface]);

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
        modalDepth:
          paletteOpen || promptsOpen || (launch.isModalOpen?.() ?? false) ? 1 : 0,
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
  }, [paletteOpen, promptsOpen, launch]);

  /**
   * Kind refs resolve through the DOMAIN REGISTRY (§15.2) — shell never maps a
   * kind itself. `getKind` falls back to the `c:*` row on a miss, so the
   * identity check is what makes an unknown ref unrenderable rather than
   * silently generic (A1a's landing note).
   */
  const presentKind = useCallback<KindPresenter>((ref) => {
    const row = getKind(ref);
    if (row.kind !== ref) return null;
    // `live` stays SESSIONS-ONLY and keeps its meaning: the green dot is the
    // count of PTYs actually running, from the liveness snapshot. It is not a
    // count of rows, and no other kind has an equivalent, so no other kind
    // gets one.
    const live = ref === LIVE_COUNT_KIND ? data.liveIds.length : undefined;
    // The rail's own numbers, from `spaces.counts`. Absent (a node that cannot
    // serve them, or a not-yet-completed first read) means NO number — never a
    // fabricated zero, which would assert the space is empty.
    const counts = data.countsFor(ref);
    return {
      label: row.labelPlural,
      icon: row.icon as unknown as string,
      live,
      ...(counts ? { badge: counts.total, unseen: counts.unseen } : {}),
    };
  }, [data.liveIds.length, data.countsFor]);

  // Channels left the rail entirely (user ruling 2026-08-01): they are
  // entities, so they live in the Entity List Panel with every other
  // collection — `channel` is `strategy: 'collection'` in the registry now and
  // the panel's kind switcher offers it with no wiring here. What remains is
  // the CHANNEL ROUTE: `#/s/{space}/channels` (and the palette row that opens
  // it) still resolve to the space's first channel and its full-screen
  // ChannelView, so a deep link and a bookmark keep working.
  const channelEntities = data.rowsFor('channel')(undefined);

  // The same grammar for VOICE: "Voice" is a label, the space's voice_channel
  // entities are the rows. The glyph comes from the REGISTRY row (as
  // `presentKind` does above) rather than being authored here — a second
  // authored glyph beside the registry's would drift the moment either moves.
  const voiceKind = getKind('voice_channel');
  const voiceEntities = data.rowsFor(voiceKind.kind)(undefined);
  const voiceGroup = useMemo<MenuDynamicGroup>(() => ({
    replaceConfiguredItems: true,
    emptyLabel: 'No voice channels in this space yet.',
    items: voiceEntities.map((entity) => {
      const state = entity.state as unknown as { participantCount?: number };
      return {
        id: entity.id,
        kind: entity.kind,
        parentId: entity.parentId,
        label: entity.title,
        icon: voiceKind.icon as unknown as string,
        // `live` renders the green ● n treatment. An EMPTY room gets no badge:
        // "● 0" would present nobody-is-here as a presence signal.
        ...(state.participantCount ? { live: state.participantCount } : {}),
      };
    }),
  }), [voiceEntities, voiceKind.icon]);

  // The settings screen's one seam adapter (settings-space/port.ts). Memoized
  // on the same (seam, space) pair the shell booted with; null until a space
  // exists, which is also when the Settings rail row can first be clicked.
  const settingsPort = useMemo(
    () => (data.spaceId ? settingsPortFromSeam(data.seam, data.spaceId) : null),
    [data.seam, data.spaceId],
  );

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
    if (scope === 'view' && ref === 'channels' && channelEntities[0]) {
      setActiveTarget({ type: 'entity', ref: channelEntities[0].id, kind: channelEntities[0].kind });
    } else if (scope === 'view') {
      setActiveTarget({ type: 'view', ref: ref as never });
    }
    if (scope === 'kind') setActiveTarget({ type: 'kind', ref });
    setPaletteOpen(false);
  }, [channelEntities]);

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
          onSelectSpace={(id: SpaceId) => {
            navStore.getState().applyNormalization({ stack: [], pinned: [] });
            navStore.getState().setSession(null);
            /* Entity ids are SPACE-SCOPED and the screen stacks are module-level,
               so they outlive this switch. Without this, a kind screen would
               restore an entity belonging to the space just left. */
            screenStackStore.getState().clearAll();
            setActiveTarget({ type: 'view', ref: 'workspace' });
            data.selectSpace(id);
          }}
          onAddSpace={projectOnboardingPort ? () => setNewSpaceOpen(true) : undefined}
          accountInitial="A"
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenPrompts={() => setPromptsOpen(true)}
          // D1: theme's one home is the account menu. No tab-bar toggle.
          onOpenAccount={toggleTheme}
          // T3-3, user-ordered 2026-07-29: the real account menu — signed-in
          // name, theme, sign-out — replaces the avatar ONCE THERE IS AN
          // ACCOUNT. Undefined otherwise, so a GateApp rendered without an
          // AuthGate (every existing test) keeps the avatar fallback and its
          // behaviour is unchanged.
          accountSlot={
            authAccount && data.viewerActor ? (
              <AccountMenu actor={data.viewerActor} theme={theme} onThemeChange={setTheme} />
            ) : undefined
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
            dynamicGroups={{ voice: voiceGroup }}
            servers={props.servers}
            activeServerId={activeServer.id}
            onSelectServer={(id) => {
              navStore.getState().applyNormalization({ stack: [], pinned: [] });
              navStore.getState().setSession(null);
              /* Entity ids are SPACE-SCOPED and the screen stacks are module-level,
                 so they outlive this switch. Without this, a kind screen would
                 restore an entity belonging to the space just left. */
              screenStackStore.getState().clearAll();
              setActiveTarget({ type: 'view', ref: 'workspace' });
              props.onSelectServer?.(id);
            }}
            onAddServer={props.onAddServer ? () => setAddServerOpen(true) : undefined}
          />

          {/* The REAL error boundary wraps the whole view region: a crashed
              screen renders the designed error state with retry; the rail and
              tab bar above stay live for navigating away. */}
          <CatchBoundary label="view">
          {data.ready &&
            activeTarget?.type === 'entity' &&
            activeTarget.kind === voiceKind.kind ? (
            /* THE MISROUTE FIX. The branch below tested only `type === 'entity'`
               with NO kind check, so EVERY entity target rendered ChannelView —
               a voice rail row would have opened a message feed against a room
               that has none, and the feed would have looked empty rather than
               wrong. Guarded here, above it, because the rail now emits voice
               entity targets.

               The room UI itself is being built separately; until it lands this
               SAYS SO, in the same idiom as `unbuilt-view` below. An honest
               placeholder is the correct state — silently borrowing another
               kind's screen is the failure class this replaces. */
            <div className="ev-root" data-testid="unbuilt-voice-view">
              <p className="evt-empty" style={{ margin: 24 }}>
                {'Voice room — not built yet. This channel exists, but its room UI does not exist in this build; nothing is hidden here.'}
              </p>
            </div>
          ) : data.ready && activeTarget?.type === 'entity' ? (
            <ChannelView
              data={data}
              channelId={activeTarget.ref as EntityId}
              serverBaseUrl={activeServer.routeBaseUrl}
              reasons={reasons}
            />
          ) : data.ready && activeTarget?.type === 'view' && activeTarget.ref === 'graph' ? (
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
          ) : data.ready && activeTarget?.type === 'kind' ? (
            /* D65: a rail KIND row opens its EntityView — wide list, Z3 aside
               on row click, Z4 full on promote. The workspace stays the one
               three-panel exception below. CHANNELS is a contract VIEW ref
               but IS the channel EntityView (Surface Audit: it fell through
               to the workspace silently — the misroute-honesty class). */
            <EntityView
              data={data}
              viewerMemberId={viewerMemberId}
              serverBaseUrl={activeServer.routeBaseUrl}
              kind={activeTarget.ref}
              reasons={reasons}
              onNotice={notices.push}
              onKindChange={(next) => setActiveTarget({ type: 'kind', ref: next })}
              /* The same verb the workspace's tiles commit. Passing it is what
                 makes the tile's `Launch ▸` a live control here instead of a
                 disabled-with-reason one; the sources behind it come from
                 `useLaunchPort` inside the view. */
              onSpawn={async (input) => {
                const sessionId = await data.spawn(input);
                setActiveTarget({ type: 'view', ref: 'workspace' });
                nav.push(sessionId);
              }}
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
            activeTarget.ref === 'settings' &&
            settingsPort ? (
            /* ⛭ Settings — the T2 shell, mounted at last (identity-display
               lane, 2026-08-01): this ref rendered the unbuilt-view card while
               the whole module sat built and unmounted in settings-space/.
               Sections another module owns (projects/kinds) keep their honest
               not-mounted state inside the shell itself. */
            <SettingsShell port={settingsPort} nodeKey={nodeKeyOf(activeServer.routeBaseUrl)} />
          ) : data.ready &&
            activeTarget?.type === 'view' &&
            activeTarget.ref !== 'workspace' ? (
            /* Unbuilt view refs (feed/inbox/…) SAY SO — rendering the
               workspace under a highlighted Dashboard row was a silent lie
               about where you are (same audit, same class). */
            <div className="ev-root" data-testid="unbuilt-view">
              <p className="evt-empty" style={{ margin: 24 }}>
                {`${activeTarget.ref} isn’t built yet — its designed screen is coming. Nothing is hidden here; it does not exist in this build.`}
              </p>
            </div>
          ) : data.ready ? (
            <WorkspaceView
              data={data}
              viewerMemberId={viewerMemberId}
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
                      // Any kind: the server derives the task anchor (064).
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
               silent fall-back to fixtures. Two distinct honest states share
               this card: a node that could not be read (boot keeps retrying
               in the background), and a node that answered with zero spaces
               (nothing to retry — there is nothing to open). */
            data.bootError.startsWith('this node has no spaces') ? (
              <div className="shell-boot" role="alert">
                <strong>No spaces on this node.</strong>
                <div>Create a Space and connect the local folder where its project work should be saved.</div>
                {projectOnboardingPort ? (
                  <button type="button" className="gov-btn gov-btn--ink" onClick={() => setNewSpaceOpen(true)}>
                    Create Space & add project
                  </button>
                ) : <div>{data.bootError}</div>}
              </div>
            ) : (
              <div className="shell-boot" role="alert">
                <strong>Can’t reach the tm8 node.</strong>
                <div>{data.bootError}</div>
                <div>The workspace is empty because nothing could be read — not because there is nothing in it.</div>
                <div>Retrying automatically — this clears itself the moment the node answers.</div>
              </div>
            )
          ) : (
            <BootLoader label="loading workspace" />
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
        <PromptsOverlay open={promptsOpen} onClose={() => setPromptsOpen(false)} />
        <NoticeHost notices={notices.notices} onDismiss={notices.dismiss} />
        <AddServerDialog
          open={addServerOpen}
          onDismiss={() => setAddServerOpen(false)}
          onAdd={async (input) => {
            if (!props.onAddServer) throw new Error('Adding Servers is unavailable.');
            await props.onAddServer(input);
          }}
        />
        {projectOnboardingPort ? (
          <NewSpaceProjectDialog
            key={activeServer.id}
            open={newSpaceOpen}
            nodeLabel={activeServer.label}
            port={projectOnboardingPort}
            onDismiss={() => setNewSpaceOpen(false)}
            onCreated={(space) => {
              navStore.getState().applyNormalization({ stack: [], pinned: [] });
              navStore.getState().setSession(null);
              screenStackStore.getState().clearAll();
              setActiveTarget({ type: 'view', ref: 'workspace' });
              data.acceptSpace(space);
              setNewSpaceOpen(false);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
