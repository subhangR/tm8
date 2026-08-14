/**
 * WorkspaceView — THE GATE SCREEN (T0-1): the three-column workspace with the
 * live-session bar over the panel stack.
 *
 * This is where the three lanes meet: my geometry (§5.1/§5.3) sizes the grid,
 * A1a's navStore owns `{stack, pinned}` and the URL, A1c's panels render the
 * content. The composition rule is that each lane keeps its own authority —
 * this file wires, it does not re-decide. Notably it does NOT re-implement
 * admission or demotion: it measures the centre, calls the engine, and hands
 * the settled result to the store (the direction A1a's DAG correction fixed).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  EntityId,
  EntitySummary,
  ExecutionSpawnInput,
  WorkSessionInteractionProfileProjection,
} from '@tm8/contract';
import { EntityDetailPanel, EntityListPanel, type DetailReasons } from '../panels';
import { useRowLifecycle } from './useRowLifecycle';
import { EntityVerbs } from './EntityVerbs';
import type { ActionContext, ActionRef, CollectionMode } from '../domain/types';
import {
  LEFT_PANEL_DEFAULT,
  PanelStack,
  RIGHT_PANEL_DEFAULT,
  WorkspaceGrid,
  solveWorkspace,
  useMeasuredWidth,
  usePanelEngine,
  type WorkspacePanelSide,
} from '../shell';
import type { NavPort } from '../shell/nav-port';
import type { Notice } from '../shell/notices';
import { toSessionRow } from '../terminal';
import { EntityCreateControl, placeholderTitleFor, useNewTask } from '../authoring';
import { allKinds, getKind } from '../domain/registry';
import { placeholderNameFor } from '../domain/title-grammar';
import { QUIET_SESSION_DETAIL, needsAttentionOf } from '../domain/needs-attention';
import { newLaunchMutationId } from '../domain/launch';
import { useLaunchPort } from './useLaunchPort';
import { mergePrPortFor } from './mergePrPort';
import { composePanelActions, usePanelPrimaries } from './usePanelPrimaries';
import { useSessionStart } from './useSessionStart';
import { EmptyCenter } from './EmptyCenter';
import { LaunchSheet, type DispatchSelection, type LaunchSelection } from './LaunchSheet';
import type { GateData } from './useGateData';
import { openEntityAndResolve } from './open-entity';
import { LazySessionChatSurface } from '../channel-screen/LazySessionChatSurface';
import { LazyChannelChatSurface } from '../channel-screen/LazyChannelChatSurface';
import { channelFeedPortFromGateData } from './channel-feed-port';
import { debugSurfaceFor } from './debugSurface';
import { gitSurfaceFor } from './gitSurface';
import { taskGitSectionFor } from './taskGitSection';
import { graphSurfaceFor } from './graphSurface';
import { attachmentsFor } from '../files/port';
import { useMembershipSurface } from './membershipSurface';
import { representedThreadMessageCount } from './message-thread';

/** The session collection is selected by capability, never by panel position
    or a kind literal. The empty centre must keep showing terminals after both
    side panels switch to unrelated collections. */
const TERMINAL_ROSTER_KIND = allKinds().find((kind) => kind.list.liveTreatment != null)?.kind;

export interface WorkspaceViewProps {
  data: GateData & { pull?: (id: string) => void };
  serverBaseUrl?: string;
  nav: NavPort;
  viewerMemberId?: string | null;
  leftKind: string;
  rightKind: string;
  menuCollapsed: boolean;
  reasons: DetailReasons;
  onNotice(notice: Notice): void;
  onPinRefusal?(id: EntityId, refusal: string): void;
  /** The kind selectors are LIVE: the panel switches kind (T0-1 law). */
  onLeftKindChange?(kind: string): void;
  onRightKindChange?(kind: string): void;
  leftWidth?: number;
  rightWidth?: number;
  onMoveSidePanel?(from: WorkspacePanelSide, to: WorkspacePanelSide): void;
  onResizeSidePanel?(side: WorkspacePanelSide, width: number): void;
  onResetSidePanelWidth?(side: WorkspacePanelSide): void;
  /** D44/D51 — the launch sheet's subject, or null when closed. */
  launchSubjectId?: EntityId | null;
  /** T5-5 annotation 6: a spawn refusal renders IN the sheet, never a toast. */
  launchRefusal?: { cause: string; detail: string } | null;
  /** True while the one permitted spawn request is unsettled. */
  launchInFlight?: boolean;
  onLaunchCancel?(): void;
  onLaunchSubmit?(config: LaunchSelection): void;
  /** D5 — hand the subject to the dispatcher instead of configuring a launch. */
  onLaunchDispatch?(request: DispatchSelection): void;
  /** Esc must not pop the panel under an open sheet (A1a finding 1). */
  isModalOpen?(): boolean;
  /** THE DOOR: A1c's quick-config "full options ▸" opens the full sheet. */
  onLaunchOpen?(id: EntityId): void;
  onSpawn?(input: ExecutionSpawnInput): void | Promise<void>;
}

export function WorkspaceView(props: WorkspaceViewProps) {
  const { data, nav, leftKind, rightKind, menuCollapsed, reasons } = props;
  const resolvingAttention = useRef(new Set<EntityId>());
  // Separate from `resolvingAttention`: a read mark is written on every open,
  // an attention resolve only sometimes, so one shared set would let either
  // suppress the other.
  const markingRead = useRef(new Set<EntityId>());

  // The measurement the whole engine hangs on. `null` until a real
  // ResizeObserver fires — never 0, which would be a claim that the centre is
  // zero-wide and would demote every pin at mount.
  const [centerRef, centerWidth] = useMeasuredWidth<HTMLDivElement>();
  const viewportWidth = useViewportWidth();

  const engine = usePanelEngine({ nav, centerWidth, onNotice: props.onNotice });

  /**
   * THE LAYOUT MODE OF EACH SIDE PANEL, held here rather than left to the
   * panel's own local state — because the WORKSPACE has to know. A board is
   * ~236px per column and the side tracks default to 240/319, so a board in a
   * side panel is one column wide and useless; in board mode the panel spans
   * the whole grid instead (`boardSide` below). The panel cannot arrange that
   * for itself: it does not own the grid.
   *
   * Uncontrolled from the panel's point of view is not an option here for the
   * same reason it was not in EntityView — two copies of the mode disagree the
   * moment one of them changes.
   */
  const [leftMode, setLeftMode] = useState<CollectionMode>(() => getKind(leftKind).defaultMode);
  const [rightMode, setRightMode] = useState<CollectionMode>(() => getKind(rightKind).defaultMode);

  /**
   * A mode the CURRENT kind hides is not a mode. Swapping a boarded panel to a
   * kind with no board (`hiddenModes`) would otherwise leave the switcher
   * claiming 'board' while the body drew a list — and, worse, leave the panel
   * spanning the grid with a list in it. Derived rather than reset by an
   * effect, so there is no frame in which the two disagree.
   */
  const effectiveMode = useCallback((kind: string, mode: CollectionMode): CollectionMode => {
    const config = getKind(kind);
    return config.hiddenModes.includes(mode) || config.list.board == null
      ? config.defaultMode
      : mode;
  }, []);

  const leftLayout = effectiveMode(leftKind, leftMode);
  const rightLayout = effectiveMode(rightKind, rightMode);
  /* Left wins if both are somehow boarded — one panel can own the grid. */
  const boardSide = leftLayout === 'board' ? 'left' : rightLayout === 'board' ? 'right' : null;

  /* D67 — the expanded row's state dropdown and archive control, on BOTH side
     panels. The same executor EntityView mounts. */
  const rowLifecycle = useRowLifecycle({
    data,
    viewerMemberId: props.viewerMemberId,
    onNotice: props.onNotice,
  });

  /**
   * The panel control strip's host, minus `kind` — the workspace is not scoped
   * to one, so each panel supplies its own entity's kind at the call site.
   * Everything else is the same executor the two side lists already use.
   */
  const controlHostBase = useMemo(
    () => ({
      livenessOf: data.livenessOf,
      capabilitiesOf: (id: string) => data.detailOf(id)?.capabilities,
      /* The read `capabilitiesOf` above is projecting. `pull` is the same
         idempotent fill `renderPanel` uses; before this it was the ONLY caller,
         so a row expanded in a LIST never learned its permissions and its
         whole control strip — Archive included — stayed inert. */
      onNeedDetail: (id: string) => data.pull?.(id),
      onSetState: rowLifecycle.setState,
      onArchive: rowLifecycle.archive,
      onSetValue: rowLifecycle.setValue,
      onAssign: rowLifecycle.assign,
      assignableActors: rowLifecycle.assignable,
      onMembership: rowLifecycle.membership,
      membershipSets: rowLifecycle.membershipSets,
      /* The live projection, not `detail.connections`: the ✓ marks must move
         with the write the menu just made. */
      connectionsOf: data.connectionsOf,
    }),
    [data, rowLifecycle],
  );

  const layout = useMemo(
    () =>
      solveWorkspace({
        viewport: viewportWidth,
        serverRail: false, // R10: Phase 1 wires only the implicit local server.
        stack: nav.stack,
        pinned: nav.pinned,
        menuCollapsedByUser: menuCollapsed,
        leftWidth: props.leftWidth ?? LEFT_PANEL_DEFAULT,
        rightWidth: props.rightWidth ?? RIGHT_PANEL_DEFAULT,
      }),
    [
      viewportWidth,
      nav.stack,
      nav.pinned,
      menuCollapsed,
      props.leftWidth,
      props.rightWidth,
    ],
  );

  const ctx = useMemo<ActionContext>(
    () => ({ spaceId: data.spaceId, viewerActorId: data.viewerActor?.id }),
    [data.spaceId, data.viewerActor],
  );
  /* Memoized on `data` so the port identity is stable — the feed hook's effects
     key on it, and a fresh object each render would re-read on every keystroke
     anywhere in the workspace. */
  const channelFeedPort = useMemo(() => channelFeedPortFromGateData(data), [data]);

  /* The panel action bar's executor AND the session tile's ✕, from one hook —
     see `usePanelPrimaries` for why the wiring is not written inline here. */
  /* REVIEW (2/2) #6 — the reporter is a useCallback, not an inline arrow. As
     an arrow it was a fresh identity every render, so `terminate`, `forEntity`
     and `primaries` all churned with it, and `handleSessionClose` — the
     session tile's ✕, a stable `useCallback` before this PR — became unstable.
     Nothing is memoised on it today; this keeps it that way by choice rather
     than by luck. */
  const notifyCloseFailed = useCallback(
    (_verb: ActionRef, _entityId: string, error: unknown) => {
      props.onNotice({
        id: 'session-close-failed',
        tone: 'error',
        title: 'Session could not be closed',
        body: String((error as { message?: string })?.message ?? error),
        ttlMs: 6_000,
      });
    },
    [props.onNotice],
  );
  const primaries = usePanelPrimaries({
    seam: data.seam,
    reconcileCommand: data.reconcileCommand,
    onError: notifyCloseFailed,
  });
  const handleSessionClose = primaries.terminate;

  /**
   * The session list's HEADER verbs (101). Same reason `primaries` is a hook:
   * this panel is mounted twice here and once in `EntityView`, and wiring it at
   * one site would leave `▮ Terminal` dead on the other two — the exact "two
   * screens, one wired and one not" shape `useLaunchPort` was extracted to end.
   *
   * No `projectId`: the header has no project picker, so a terminal opens in a
   * server-owned scratch directory rather than in a repository the member did
   * not name. See `SessionStartHost.projectId`.
   */

  /**
   * Resume — the inverse of close, and the reason the exited card has a button.
   *
   * `resumingId` is not cosmetic: resume boots a real agent process, and a
   * double-fire races two spawns onto one session id. The server refuses the
   * second with `conflict`, but the honest UI is to not send it.
   */
  const [resumingId, setResumingId] = useState<string | null>(null);
  const handleSessionResume = useCallback((entityId: string) => {
    setResumingId(entityId);
    void data.seam.commands.resume(entityId as EntityId, {
      clientMutationId: `resume:${entityId}:${Date.now()}`,
    }).then(data.reconcileCommand).catch((error: unknown) => {
      props.onNotice({
        id: 'session-resume-failed',
        tone: 'error',
        title: 'Session could not be resumed',
        // The server's refusal, verbatim. Resume fails for REASONS a user can
        // act on — no native id recorded, the concurrency cap, an ambiguous
        // Codex rollout — and paraphrasing them would discard the remedy.
        body: String((error as { message?: string })?.message ?? error),
        ttlMs: 8_000,
      });
    }).finally(() => setResumingId(null));
  }, [data.seam.commands, data.reconcileCommand, props.onNotice]);

  /** Opening is never blocked on the mutation. Resolve only when the rendered
      summary says attention is pending, and coalesce rapid repeated clicks. */
  const openEntity = useCallback((entityId: string) => {
    const id = entityId as EntityId;
    const summary = data.detailOf(id)
      ?? data.rowsFor(leftKind)(undefined).find((row) => row.id === id)
      ?? data.rowsFor(rightKind)(undefined).find((row) => row.id === id)
      ?? data.graph.nodes.find((row) => row.id === id);
    openEntityAndResolve({
      entityId: id,
      needsAttention: summary?.badges.attention != null,
      open: (id) => nav.push(id),
      commands: data.seam.commands,
      reconcile: data.reconcileCommand,
      resolving: resolvingAttention.current,
      marking: markingRead.current,
      onRead: data.refreshCounts,
      onError: (error) => props.onNotice({
          id: `attention-resolve-failed:${entityId}`,
          tone: 'error',
          title: 'Attention could not be resolved',
          body: String((error as { message?: string })?.message ?? error),
          ttlMs: 6_000,
        }),
    });
  }, [data, leftKind, nav, props.onNotice, rightKind]);

  /** Panels at the side-panel floors drop metas and abbreviate badges. */
  const leftCompact = layout.left <= 220;
  const rightCompact = layout.right <= 240;

  /* ATTACHMENTS — one port for every panel this view mounts, memoized on the
     seam and space so `renderPanel` does not hand the strip a fresh
     `startUpload` identity on each layout measurement. */
  const attachments = useMemo(
    () => attachmentsFor(data.seam, data.spaceId),
    [data.seam, data.spaceId],
  );

  /* COLLECTION MEMBERSHIP — the one shared composer (see `membershipSurface`).
     A hook called ONCE here, because `renderPanel` below renders one panel per
     id and cannot call hooks; each mount gets `authoringFor(detail)`. */
  const membership = useMembershipSurface({
    spaceId: data.spaceId,
    seam: data.seam,
    refetchDetail: (id) => props.data.refetchDetail(id),
    onNotice: props.onNotice,
  });

  /* ONE construction, shared with EntityView. It used to be built inline here,
     twice — and not at all on the kind screens, which is why their quick config
     showed no teammates and no models. See `useLaunchPort`.

     ABOVE `renderPanel`, which now consumes it: the panels' Run opens the same
     quick config the list rows do, and a port declared below its consumer
     would be a TDZ error rather than a lint note. */
  const launchPort = useLaunchPort(data, {
    ...(props.onSpawn ? { onSpawn: props.onSpawn } : {}),
    ...(props.onLaunchOpen
      ? { onFullOptions: (id: string) => props.onLaunchOpen?.(id as EntityId) }
      : {}),
  });

  const sessionStart = useSessionStart({
    spaceId: data.spaceId,
    seam: data.seam,
    reconcileCommand: data.reconcileCommand,
    onOpen: openEntity,
    onError: (_verb, error) => {
      props.onNotice({
        id: 'terminal-start-failed',
        tone: 'error',
        // The node's refusal, verbatim. This fails for reasons a member can
        // act on — the terminal cap, an untrusted project — and paraphrasing
        // them into "could not start" would discard the remedy.
        title: 'Terminal could not be started',
        body: String((error as { message?: string })?.message ?? error),
        ttlMs: 8_000,
      });
    },
  });

  const renderPanel = useCallback(
    (id: EntityId, host: 'pinned' | 'stack') => {
      const detail = data.detailOf(id);
      const messages = data.messagesOf(id);
      // Detail and Discussion are independent reads. A command result can
      // prefill the detail while the thread is still absent.
      if (
        !detail
        || messages === undefined
        || representedThreadMessageCount(messages) < detail.counters.messages
      ) {
        props.data.pull?.(id);
      }

      const admission = engine.canPin(id);
      const content = detail?.content as unknown as {
        interactionProfile?: WorkSessionInteractionProfileProjection | null;
      } | undefined;
      const recordedStatus = (detail?.state as unknown as { status?: string } | undefined)?.status;
      return (
        /* The action bar's executor — `edit` and `add-child` (a subchannel).
           A COMPONENT and not a hook call, because this is a callback that
           renders one panel per id and the workspace shows several at once;
           see `EntityVerbs`. Each panel therefore holds its own draft. */
        <EntityVerbs
          detail={detail ?? null}
          spaceId={data.spaceId}
          commands={data.seam.commands}
          onCreated={openEntity}
          onSaved={(saved) => props.data.refetchDetail(saved)}
        >
          {(verbs) => {
            const panelActions = composePanelActions([
              { onAction: primaries.forEntity(id), wiredActions: primaries.wiredActions },
              { onAction: verbs.onAction, wiredActions: verbs.wiredActions },
            ]);
            return (
        <EntityDetailPanel
          detail={detail ?? null}
          serverBaseUrl={props.serverBaseUrl}
          loading={!detail}
          host={host}
          reasons={reasons}
          ctx={{ ...ctx, entityId: id }}
          controls={{ ...controlHostBase, kind: detail?.kind ?? '', ctx: { ...ctx, entityId: id } }}
          /* The panel primaries, finally executable: Terminate commits here,
             Run expands the same launch config the list rows open, and edit /
             add-child come from `EntityVerbs` — see `composePanelActions`. */
          onAction={panelActions.onAction}
          wiredActions={panelActions.wiredActions}
          membershipAuthoring={membership.authoringFor(detail)}
          launch={launchPort}
          mergePr={mergePrPortFor(data.seam)}
          onRestore={() => rowLifecycle.archive('restore', id)}
          pinned={nav.pinned.includes(id)}
          // A1c's contract: the refusal string renders as the disabled pin
          // control in T1-4's two-line form (my D14). `undefined` ⇒ pin is live.
          pinRefusal={
            nav.pinned.includes(id) || admission.admitted
              ? undefined
              : `${admission.cause} — ${admission.remedy}`
          }
          liveness={data.livenessOf(id)}
          debugSurface={debugSurfaceFor(data.seam, id, data.livenessOf)}
          gitSurface={gitSurfaceFor(data.seam, id, data.livenessOf)}
          taskGitSection={taskGitSectionFor(data.seam, detail, openEntity)}
          graphSurface={graphSurfaceFor(data.seam, id, data.livenessOf, openEntity)}
          attachments={attachments}
          onAttachmentUploaded={() => props.data.refetchDetail(id)}
          livenessOf={data.livenessOf}
          /* Same one prop, same shared predicate, same reason as EntityView:
             the block signal must reach the terminal AND the chat surface, not
             whichever one is on top. */
          needsAttention={detail ? needsAttentionOf(detail, data.livenessOf) : false}
          attentionDetail={QUIET_SESSION_DETAIL}
          viewerMemberId={props.viewerMemberId}
          contentSurface={nav.surfaceOf?.(id) ?? null}
          onContentSurfaceChange={(surface) => nav.setContentSurface?.(id, surface)}
          /*
           * ONE SLOT, TWO SURFACES, CHOSEN BY ARCHETYPE — never by kind (§15.2).
           * `terminal` entities get the session chat; `hub` entities get their
           * channel feed, which is what makes a channel opened from the Entity
           * List Panel a channel you can actually read and post to (user ruling
           * 2026-08-01). Any other archetype gets no feed and HubBody's
           * unchanged front-door body.
           */
          chatSurface={detail && getKind(detail.kind).panel.archetype === 'hub' ? (
            <LazyChannelChatSurface
              port={channelFeedPort}
              channelId={id}
              connection={data.connection}
              onOpenEntity={(entityId) => openEntity(entityId)}
              threads={getKind(detail.kind).panel.threads === true}
              anchorTitle={`${getKind(detail.kind).chip.glyph}${detail.title}`}
            />
          ) : detail ? (
            <LazySessionChatSurface
              seam={data.seam}
              sessionId={id}
              spaceId={data.spaceId}
              viewerMemberId={props.viewerMemberId ?? 'anonymous'}
              connection={data.connection}
              sessionExited={recordedStatus === 'exited' || recordedStatus === 'failed'}
              defaultLimit={content?.interactionProfile?.feedPolicy.pageSize}
              composerPolicy={content?.interactionProfile?.composerPolicy}
              needsAttention={needsAttentionOf(detail, data.livenessOf)}
              attentionDetail={QUIET_SESSION_DETAIL}
              onOpenEntity={openEntity}
              onSwitchToTerminal={() => nav.setContentSurface?.(id, 'terminal')}
            />
          ) : undefined}
          messages={messages}
          connections={data.connectionsOf(id)}
          linkedPullRequests={data.linkedPullRequestsOf?.(id) ?? []}
          linkedPullRequestsOf={data.linkedPullRequestsOf}
          onPostMessage={(post) => data.postMessage({ clientMutationId: `post:${id}:${Date.now()}`, anchorIds: [id], ...post })}
          mentionOptions={data.mentionOptions}
          skillOptions={data.skillOptions}
          onResumeSession={() => handleSessionResume(id)}
          resumingSession={resumingId === id}
          /* GAP-2 (data-wiring handover): hand the seam commands down so the
             save path is live in the workspace panels too. */
          commands={data.seam.commands}
          onSaved={data.reconcileCommand}
          streaming={data.activity[id] ?? false}
          onPin={() => {
            if (nav.pinned.includes(id)) {
              nav.unpin(id);
              return;
            }
            const outcome = engine.requestPin(id);
            if (!outcome.admitted) props.onPinRefusal?.(id, `${outcome.cause} — ${outcome.remedy}`);
          }}
          onPromote={() => nav.promote(id)}
          onClose={() => nav.close(id)}
          onOpenEntity={openEntity}
        />
            );
          }}
        </EntityVerbs>
      );
    },
    [data, engine, nav, ctx, reasons, props, openEntity, channelFeedPort, attachments, primaries, launchPort, membership],
  );

  /** Keep the server's recent-activity order; EmptyCenter applies the bounded
      status groups without turning this summary into a second full list. */
  const rosterRows = useMemo(() => {
    if (!TERMINAL_ROSTER_KIND) return [];
    return data.rowsFor(TERMINAL_ROSTER_KIND)(undefined).map((summary) => toSessionRow(summary));
  }, [data]);

  /** Session task rows come from durable `working_on` edges already projected
      by the gate graph. The map updates with edge events and is shared by both
      side panels, so a moved panel keeps the same task evidence. */
  const linkedTasksBySession = useMemo(() => {
    const bySession = new Map<string, EntitySummary[]>();
    const currentById = new Map(data.graph.nodes.map((node) => [node.id, node]));
    for (const edge of data.graph.edges) {
      if (edge.type !== 'working_on' || edge.target.state.kind !== 'task') continue;
      const task = currentById.get(edge.target.id) ?? edge.target;
      bySession.set(edge.source.id, [...(bySession.get(edge.source.id) ?? []), task]);
    }
    return bySession;
  }, [data.graph.edges, data.graph.nodes]);
  const linkedTasksOf = useCallback(
    (id: string) => linkedTasksBySession.get(id) ?? [],
    [linkedTasksBySession],
  );

  const profileFor = launchPort.profileFor;

  /* Each dock owns a create-flow hook so a quick-create panel keeps the
     behavior when it crosses the center. Both run unconditionally (rules of
     hooks); the control only renders when registry data says quickCreate. */
  const leftConfig = getKind(leftKind);
  const rightConfig = getKind(rightKind);
  const leftCreateFlow = useNewTask({
    spaceId: data.spaceId,
    kind: leftConfig.kind,
    placeholderTitle: placeholderNameFor(leftConfig, placeholderTitleFor(leftConfig.label)),
    commands: data.seam.commands,
    onCreated: (id) => nav.push?.(id as EntityId),
  });
  const rightCreateFlow = useNewTask({
    spaceId: data.spaceId,
    kind: rightConfig.kind,
    placeholderTitle: placeholderNameFor(rightConfig, placeholderTitleFor(rightConfig.label)),
    commands: data.seam.commands,
    onCreated: (id) => nav.push?.(id as EntityId),
  });

  const centreIsEmpty = nav.stack.length === 0 && nav.pinned.length === 0;

  return (
    <WorkspaceGrid
      layout={layout}
      centerRef={centerRef}
      boardSide={boardSide}
      leftLabel={leftConfig.label}
      rightLabel={rightConfig.label}
      onMovePanel={props.onMoveSidePanel}
      onResizePanel={props.onResizeSidePanel}
      onResetPanelWidth={props.onResetSidePanelWidth}
      left={
        <EntityListPanel
          kind={leftKind}
          createSlot={
            leftConfig.list.quickCreate
            && (leftConfig.createForm || leftConfig.list.tile.anatomy === 'control-card') ? (
              <EntityCreateControl
                config={leftConfig}
                immediate={leftCreateFlow}
                spaceId={data.spaceId}
                commands={data.seam.commands}
                files={data.seam.files}
                onCreated={(id, result) => {
                  data.reconcileCommand(result);
                  nav.push?.(id);
                }}
              />
            ) : undefined
          }
          /* NO `as never` on the row seam. The cast was load-bearing
             camouflage: it made the panel's row seam unable to reject a
             mismatched shape, which is the same blindness that let `rowsFor`
             ignore its filter for so long. The signatures line up on their
             own now. */
          rowsFor={data.rowsFor(leftKind)}
          pageStateOf={data.pageStateOf(leftKind)}
          loadMore={data.loadMore(leftKind)}
          boardFor={data.boardFor(leftKind) as never}
          mode={leftLayout}
          onMode={setLeftMode}
          members={data.members}
          ctx={ctx}
          /* A boarded panel owns the whole grid, so it is not compact any
             more — keeping the dense chrome would shrink the filters and
             search of a full-width surface for no reason. */
          compact={boardSide === 'left' ? false : leftCompact}
          liveIds={data.liveIds}
          livenessOf={data.livenessOf}
          activity={data.activity}
          messagePulses={data.messagePulses}
          linkedTasksOf={linkedTasksOf}
          linkedPullRequestsOf={data.linkedPullRequestsOf}
          selectedId={nav.stack[nav.stack.length - 1] ?? null}
          onSelect={openEntity}
          onTerminate={leftConfig.list.tile.anatomy === 'session-tree' ? handleSessionClose : undefined}
          onSetState={rowLifecycle.setState}
          onArchive={rowLifecycle.archive}
          onSetValue={rowLifecycle.setValue}
          onAssign={rowLifecycle.assign}
          assignableActors={rowLifecycle.assignable}
          onMembership={rowLifecycle.membership}
          membershipSets={rowLifecycle.membershipSets}
          connectionsOf={data.connectionsOf}
          onKindChange={props.onLeftKindChange}
          // Capability truth comes from the DETAIL, not the summary
          // (EntityCapabilities lives on EntityDetail). A row whose detail is
          // not hydrated genuinely has unknown capabilities and correctly
          // stays refused — passing a literal all-true object here would make
          // the panel claim a permission the shell was never told it has,
          // which is the optimistic-enable the rule exists to prevent.
          //
          // "Not hydrated" must therefore be a state a row can LEAVE, and for
          // a list row nothing used to leave it: the expanded strip's Archive
          // sat in `CheckingPermission` forever. `onNeedDetail` is what asks.
          capabilitiesOf={(id) => data.detailOf(id)?.capabilities}
          onNeedDetail={(id) => data.pull?.(id)}
          // The quick-config's escape to the full sheet. A1c's
          // LaunchTeammateOption is deliberately NOT my LaunchTeammate:
          // panels/ importing views/ would point the dependency backwards,
          // since views compose panels. One map at the seam, no cast on
          // either side.
          launch={launchPort}
          /* The header verbs (101). `wiredActions` is what makes the pair
             honest: `▮ Terminal` commits, `Launch session ▸` renders its
             not-wired refusal beside it rather than being drawn as a live
             button this dispatcher would drop. */
          onAction={sessionStart.onAction}
          wiredActions={sessionStart.wiredActions}
        />
      }
      center={
        <>
          {/* USER RULING 2026-07-29 (D64): the live-session bar is UNMOUNTED —
              the strip above the terminal duplicated the panel header one row
              below it and taxed the canvas. Its facts survive elsewhere: the
              live count in the rail + list panels, focus via the lists. The
              component stays in-tree for any future non-center home; §5.4's
              never-scrolls clause retires with the mount. */}
          {/* 02-LAYOUT §2.2 — the empty centre is not a blank: it IS the live
              roster and it teaches the grammar. PanelStack still owns the slot
              and its C_min floor; this is the content that goes in it. */}
          {/* The launch sheet OVERLAYS the stack region — it is not a column,
              so it never enters V/cMin. See D52-as-amended and LaunchSheet's
              docblock for why a column would breach L4. */}
          {props.launchSubjectId && (
            <LaunchSheet
              refusal={props.launchRefusal}
              launching={props.launchInFlight}
              subjectId={props.launchSubjectId}
              fromChip="◔ Run ▸"
              // Not "task pre-associated" any more: the subject can be a doc, a
              // teammate, a memory, an artifact, a project, a pull request or a
              // worktree. Only `subjectId` reaches this mount — no kind — and
              // the sentence has to stay true for all of them, so it names the
              // relationship rather than the kind.
              fromCaption="subject pre-associated — the session links to it"
              teammates={data.launch.teammates}
              projects={data.launch.projects}
              profiles={data.launch.profiles}
              /* Undefined until the kind is hydrated, and the sheet draws that
                 as "unknown" rather than "none" — see the picker's comment. */
              memories={data.launch.memories}
              capacity={data.launch.capacity}
              loadCredentialStatus={data.seam.credentials.status}
              onCancel={() => props.onLaunchCancel?.()}
              onLaunch={(config) => props.onLaunchSubmit?.(config)}
              /* Passed straight through, unbound to any sheet state — see the
                 button's comment for why dispatch cannot carry a config. */
              onDispatch={props.onLaunchDispatch}
            />
          )}
          {centreIsEmpty ? (
            <EmptyCenter
              liveIds={data.liveIds}
              rows={rosterRows}
              livenessOf={data.livenessOf}
              onFocusSession={openEntity}
            />
          ) : (
            <PanelStack nav={nav} renderPanel={renderPanel} isKeyboardOwnedAbove={props.isModalOpen} />
          )}
        </>
      }
      right={
        <EntityListPanel
          kind={rightKind}
          createSlot={
            rightConfig.list.quickCreate
            && (rightConfig.createForm || rightConfig.list.tile.anatomy === 'control-card') ? (
              <EntityCreateControl
                config={rightConfig}
                immediate={rightCreateFlow}
                spaceId={data.spaceId}
                commands={data.seam.commands}
                files={data.seam.files}
                onCreated={(id, result) => {
                  data.reconcileCommand(result);
                  nav.push?.(id);
                }}
              />
            ) : undefined
          }
          rowsFor={data.rowsFor(rightKind)}
          pageStateOf={data.pageStateOf(rightKind)}
          loadMore={data.loadMore(rightKind)}
          boardFor={data.boardFor(rightKind) as never}
          mode={rightLayout}
          onMode={setRightMode}
          members={data.members}
          ctx={ctx}
          compact={boardSide === 'right' ? false : rightCompact}
          liveIds={data.liveIds}
          livenessOf={data.livenessOf}
          activity={data.activity}
          messagePulses={data.messagePulses}
          linkedTasksOf={linkedTasksOf}
          linkedPullRequestsOf={data.linkedPullRequestsOf}
          selectedId={nav.stack[nav.stack.length - 1] ?? null}
          onSelect={openEntity}
          onTerminate={rightConfig.list.tile.anatomy === 'session-tree' ? handleSessionClose : undefined}
          onSetState={rowLifecycle.setState}
          onArchive={rowLifecycle.archive}
          onSetValue={rowLifecycle.setValue}
          onAssign={rowLifecycle.assign}
          assignableActors={rowLifecycle.assignable}
          onMembership={rowLifecycle.membership}
          membershipSets={rowLifecycle.membershipSets}
          connectionsOf={data.connectionsOf}
          onKindChange={props.onRightKindChange}
          capabilitiesOf={(id) => data.detailOf(id)?.capabilities}
          onNeedDetail={(id) => data.pull?.(id)}
          launch={launchPort}
          /* The header verbs (101). `wiredActions` is what makes the pair
             honest: `▮ Terminal` commits, `Launch session ▸` renders its
             not-wired refusal beside it rather than being drawn as a live
             button this dispatcher would drop. */
          onAction={sessionStart.onAction}
          wiredActions={sessionStart.wiredActions}
        />
      }
    />
  );
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth,
  );

  useEffect(() => {
    const measure = () => setWidth(window.innerWidth);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  return width;
}
