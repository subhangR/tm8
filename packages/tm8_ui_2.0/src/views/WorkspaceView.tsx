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
} from '@tm8/contract';
import {
  EntityDetailPanel,
  EntityListPanel,
  ListRootHeader,
  rootBirthAction,
  type DetailReasons,
} from '../panels';
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
import { placeholderTitleFor, useNewTask } from '../authoring';
import { homeRootKinds } from '../domain/home-rail';
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
import { conversationSurfaceFor } from './conversationSurface';
import { channelFeedPortFromGateData } from './channel-feed-port';
import { attentionSectionFor } from './attentionSurface';
import { debugSurfaceFor } from './debugSurface';
import { sessionStatsSurfaceFor } from './sessionStatsSurface';
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
  const visibleNav = useMemo(
    () => ({ ...nav, stack: engine.visible.stack, pinned: engine.visible.pinned }),
    [nav, engine.visible],
  );

  /**
   * THE LAYOUT MODE OF EACH SIDE PANEL, resolved here rather than left to the
   * panel — because the WORKSPACE has to know. A board is ~236px per column
   * and the side tracks default to 240/319, so a board in a side panel is one
   * column wide and useless; in board mode the panel spans the whole grid
   * instead (`boardSide` below). The panel cannot arrange that for itself: it
   * does not own the grid.
   *
   * It is the kind's registry default and nothing else now that the view
   * switcher is gone (2026-08-19): no control on this screen writes a mode, so
   * a piece of state behind it could only ever hold the value it was seeded
   * with. `board` still reaches here for a kind that DEFAULTS to one, which is
   * why `boardSide` below is still a live branch rather than a constant null.
   */
  const layoutFor = useCallback((kind: string): CollectionMode => getKind(kind).defaultMode, []);

  const leftLayout = layoutFor(leftKind);
  const rightLayout = layoutFor(rightKind);
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
      capabilitiesOf: (id: string) => data.capabilitiesOf(id),
      /* The read `capabilitiesOf` above is projecting, and it reads the
         SUMMARY first now, so a control strip is no longer waiting on `pull`
         to learn whether its verbs are permitted. `pull` remains the
         idempotent fill for the REST of the detail, and the fallback for a
         node whose summaries predate the capability projection. */
      onNeedDetail: (id: string) => data.pull?.(id),
      onSetState: rowLifecycle.setState,
      onArchive: rowLifecycle.archive,
      onSetValue: rowLifecycle.setValue,
      onSetAxis: rowLifecycle.setAxis,
      taskAxes: data.taskAxes,
      taskWorkflows: data.taskWorkflows,
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
        stack: engine.visible.stack,
        pinned: engine.visible.pinned,
        menuCollapsedByUser: menuCollapsed,
        leftWidth: props.leftWidth ?? LEFT_PANEL_DEFAULT,
        rightWidth: props.rightWidth ?? RIGHT_PANEL_DEFAULT,
      }),
    [
      viewportWidth,
      engine.visible.stack,
      engine.visible.pinned,
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
  const channelFeedPort = useMemo(
    () => channelFeedPortFromGateData(data, props.viewerMemberId),
    [
      data.seam, data.spaceId, data.liveIds, data.postMessage, data.spawn, data.launch.projects,
      // The viewer keys the drafts and the mutation journal, so a sign-in that
      // changes it must rebuild the port — omitting it here would hold the
      // previous viewer's draft slot open under the new one.
      props.viewerMemberId,
    ],
  );

  /* The panel action bar's executor AND the session tile's ✕, from one hook —
     see `usePanelPrimaries` for why the wiring is not written inline here. */
  /* REVIEW (2/2) #6 — the reporter is a useCallback, not an inline arrow. As
     an arrow it was a fresh identity every render, so `terminate`, `forEntity`
     and `primaries` all churned with it, and `handleSessionTerminate` — the
     session tile's ✕, a stable `useCallback` before this PR — became unstable.
     Nothing is memoised on it today; this keeps it that way by choice rather
     than by luck. */
  /* ONE reporter for BOTH halves of the process control, keyed on the verb it
     is handed. Resume's refusals are the ones a user can act on — no native id
     recorded, the concurrency cap, an ambiguous Codex rollout — so it gets the
     longer read; the body is the node's own message either way, never a
     paraphrase, because paraphrasing discards the remedy. */
  const notifySessionVerbFailed = useCallback(
    (verb: ActionRef, _entityId: string, error: unknown) => {
      const resumed = verb === 'resume';
      props.onNotice({
        id: resumed ? 'session-resume-failed' : 'session-terminate-failed',
        tone: 'error',
        title: resumed ? 'Session could not be resumed' : 'Session could not be terminated',
        body: String((error as { message?: string })?.message ?? error),
        ttlMs: resumed ? 8_000 : 6_000,
      });
    },
    [props.onNotice],
  );
  const primaries = usePanelPrimaries({
    seam: data.seam,
    reconcileCommand: data.reconcileCommand,
    onError: notifySessionVerbFailed,
  });
  const handleSessionTerminate = primaries.terminate;

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
   * Resume — the inverse of close, and now the OTHER HALF of the process
   * control rather than only the exited card's button.
   *
   * It moved into `usePanelPrimaries` beside terminate when the row cluster
   * and the panel bar grew their own Resume: three surfaces firing the same
   * command, and the in-flight guard (`resumingId` — resume boots a real agent
   * process, and a double-fire races two spawns onto one session id) is worth
   * nothing if only one of them consults it.
   */
  const handleSessionResume = primaries.resume;
  const resumingId = primaries.resumingId;

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
    /*
     * THE VANILLA TERMINAL TAKES THE SAME WORKING DIRECTORY A LAUNCH WOULD.
     *
     * `projectId` is optional on SessionStartHost and neither caller passed it,
     * so it arrived `undefined`, `projectId ?? null` sent null, and
     * `execution.terminal.start` minted a scratch directory — for EVERY terminal,
     * in every Space, however many trusted projects were linked. Not a default
     * anyone chose: the prop was simply never wired, so no arrangement of
     * projects could change the outcome.
     *
     * Same rule the launch sheet uses, so the terminal and a launched session
     * open in the same place rather than disagreeing.
     */
    projectId: data.launch.projects.find((p) => p.selectedByDefault && p.trusted)?.id ?? null,
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
          skillOptions={data.skillOptions}
          /* The dialog edits the panel's own subject, so a file inserted into
             a multiline field attaches to that entity. */
          attach={
            detail && attachments
              ? (file: File) => attachments.startUpload(file, detail.id)
              : undefined
          }
          onAttached={() => detail && props.data.refetchDetail(detail.id)}
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
          attentionSection={attentionSectionFor(data.seam, data.spaceId, id, () => data.pull?.(id))}
          debugSurface={debugSurfaceFor(data.seam, id, data.livenessOf)}
          sessionStatsSurface={sessionStatsSurfaceFor(data.seam, id)}
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
           * The fork itself lives in `conversationSurfaceFor`, shared by all five
           * EntityDetailPanel hosts (user ruling 2026-08-01 made a channel
           * opened from the Entity List Panel readable and postable; the shared
           * helper is what keeps the other hosts from un-learning it).
           */
          conversationSurface={conversationSurfaceFor(detail, id, {
            seam: data.seam,
            spaceId: data.spaceId,
            connection: data.connection,
            livenessOf: data.livenessOf,
            channelFeedPort,
            viewerMemberId: props.viewerMemberId,
            onOpenEntity: openEntity,
            onSwitchToTerminal: () => nav.setContentSurface?.(id, 'terminal'),
          })}
          discussionSurface={conversationSurfaceFor(detail, id, {
            seam: data.seam,
            spaceId: data.spaceId,
            connection: data.connection,
            livenessOf: data.livenessOf,
            channelFeedPort,
            viewerMemberId: props.viewerMemberId,
            onOpenEntity: openEntity,
            onSwitchToTerminal: () => nav.setContentSurface?.(id, 'terminal'),
          }, 'discussion')}
          messages={messages}
          connections={data.connectionsOf(id)}
          linkedPullRequests={data.linkedPullRequestsOf?.(id) ?? []}
          linkedPullRequestsOf={data.linkedPullRequestsOf}
          mentionOptions={data.mentionOptions}
          skillOptions={data.skillOptions}
          onResumeSession={() => handleSessionResume(id)}
          resumingSession={resumingId === id}
          /* The stale card's "mark exited" chip, wired to the SAME executor as
             the session tile's ✕ — `usePanelPrimaries.terminate` exists so the
             two controls cannot drift into meaning different things. Until now
             the chip called nothing at all, which mattered most in exactly the
             case it is drawn for: after a node restart, when every killed
             session claims to be running and only an operator at a shell could
             clear them. */
          onMarkSessionExited={() => handleSessionTerminate(id)}
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
  }, [data.rowsFor]);

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

  /** The INVERSE projection from the same edges: sessions per `working_on`
      target, for the tile's leading sessions chip (relational panel, user
      ruling 2026-08-16). Same freshness rule — the current node wins over
      the edge's embedded summary. */
  const linkedSessionsByTarget = useMemo(() => {
    const byTarget = new Map<string, EntitySummary[]>();
    const currentById = new Map(data.graph.nodes.map((node) => [node.id, node]));
    for (const edge of data.graph.edges) {
      if (edge.type !== 'working_on') continue;
      const session = currentById.get(edge.source.id) ?? edge.source;
      byTarget.set(edge.target.id, [...(byTarget.get(edge.target.id) ?? []), session]);
    }
    return byTarget;
  }, [data.graph.edges, data.graph.nodes]);
  const linkedSessionsOf = useCallback(
    (id: string) => linkedSessionsByTarget.get(id) ?? [],
    [linkedSessionsByTarget],
  );

  const profileFor = launchPort.profileFor;

  /* Each dock owns a create-flow hook so a quick-create panel keeps the
     behavior when it crosses the center. Both run unconditionally (rules of
     hooks).

     THESE NOW DRIVE THE ROOT HEADER'S ＋ (task 01a0102f, owner ruling R4),
     not an `EntityCreateControl` in the panel's header slot. Same flow, same
     hook, one button earlier: create an Untitled entity immediately and open
     it in the centre — Home's D3 behaviour, adopted verbatim so the two
     surfaces differ by layout and nothing else.

     `refusalFor` is what makes a non-creatable kind report refused instead of
     silently making an entity nobody asked for. It is applied at the HEADER
     (`birthFor`) rather than passed to the hook as `refusal`, because the
     header now asks about every kind in the menu and not only the bound one:
     a refusal bound into the hook would have answered "sessions aren't created
     from here" for the Docs row of a sessions list. */
  const leftConfig = getKind(leftKind);
  const rightConfig = getKind(rightKind);
  const refusalFor = (config: ReturnType<typeof getKind>) =>
    config.list.quickCreate
      ? null
      : {
          cause: `${config.labelPlural} aren’t created from here`,
          remedy: 'they are made by their own flow',
        };
  const leftCreateFlow = useNewTask({
    spaceId: data.spaceId,
    kind: leftConfig.kind,
    placeholderTitle: placeholderNameFor(leftConfig, placeholderTitleFor(leftConfig.label)),
    commands: data.seam.commands,
    /* The reconcile is NOT decoration and NOT inherited from Home: the
       retired `createSlot` did it, and dropping it would have created the
       entity, opened it, and left the list it came from without a row. */
    onCreated: (id, result) => {
      data.reconcileCommand(result);
      nav.push?.(id as EntityId);
    },
  });
  const rightCreateFlow = useNewTask({
    spaceId: data.spaceId,
    kind: rightConfig.kind,
    placeholderTitle: placeholderNameFor(rightConfig, placeholderTitleFor(rightConfig.label)),
    commands: data.seam.commands,
    onCreated: (id, result) => {
      data.reconcileCommand(result);
      nav.push?.(id as EntityId);
    },
  });

  /* THE ROOT HEADER, one per column (task 01a0102f). The same component Home
     draws — `panels/ListRootHeader` — minus the `chats` cell, which is not
     portable: Chats hosts no list, it swaps the surface's CENTRE to the
     conversation composer, and this surface's centre is the ink stage.

     The kind menu offers `homeRootKinds()`, which is `collectionKinds()` in
     the rail's order. Home already used it, and the population was always
     identical — taking the same function is what makes the ORDER identical
     too, so the two surfaces' menus cannot drift apart later.

     Kind switching moved here off the panel's own `onKindChange`. That prop
     is now unreachable (the panel takes `selectorSlot="host"`, which retires
     its KindSelector) and passing it would have left a dead menu: the panel
     calls `onKindChange?.()` optionally, with no disabled-with-reason guard,
     so a miswire there fails SILENTLY rather than visibly. */
  const columnHeader = (side: WorkspacePanelSide) => {
    const isLeft = side === 'left';
    const config = isLeft ? leftConfig : rightConfig;
    const flow = isLeft ? leftCreateFlow : rightCreateFlow;
    const onKindChange = isLeft ? props.onLeftKindChange : props.onRightKindChange;

    /**
     * HOW A KIND IS BORN FROM THIS HEADER — one function, answering for the
     * cell's ＋ and for every row of its menu, which is the point: pressing ＋
     * on the Sessions row and pressing ＋ on the Sessions cell must not do
     * different things.
     *
     * Two arms, and the registry decides which (never a kind literal, §15.2):
     *   - `rootBirthAction` ⇒ the kind is STARTED. Sessions are the case: the
     *     birth is `start-terminal`, dispatched through `useSessionStart`,
     *     which owns the space and the project a terminal needs.
     *   - otherwise ⇒ the generic create, with the TARGET kind's own
     *     placeholder. `flow` is the vehicle (its commands, its `onCreated`),
     *     not the subject — its bound kind is only the default.
     */
    const birthFor = (kind: string): { refusal: { cause: string; remedy: string } | null; perform: () => void } => {
      const action = rootBirthAction(kind);
      if (action) {
        const dispatch = sessionStart.onAction;
        /* The SAME gate the retired header button used: `onAction` is present
           exactly when a terminal can be started, so a surface without a
           command seam refuses out loud instead of throwing on click. */
        return dispatch
          ? { refusal: null, perform: () => dispatch(action, '') }
          : {
              refusal: {
                cause: `Starting ${getKind(kind).labelPlural.toLowerCase()} isn’t wired here`,
                remedy: 'this surface was mounted without a command executor',
              },
              perform: () => undefined,
            };
      }
      const target = getKind(kind);
      return {
        refusal: flow.unavailableFor(target.kind) ?? refusalFor(target),
        perform: () =>
          void flow.create({
            kind: target.kind,
            placeholderTitle: placeholderNameFor(target, placeholderTitleFor(target.label)),
          }),
      };
    };
    const birth = birthFor(config.kind);
    return (
      <ListRootHeader
        rootsLabel={`${isLeft ? 'Left' : 'Right'} panel list`}
        cell={{ kind: config.kind, label: config.labelPlural, single: config.label }}
        /* No Chats cell here, so this column's one root is always the
           selected one — there is nothing else it could be showing. */
        cellActive
        onSelectCell={() => undefined}
        {...(birth.refusal === null ? { onCreate: birth.perform } : {})}
        createUnavailable={birth.refusal}
        options={homeRootKinds().map((k) => ({
          kind: k.kind,
          label: k.labelPlural,
          single: k.label,
        }))}
        currentKind={config.kind}
        onPickKind={(kind) => onKindChange?.(kind)}
        onCreateKind={(kind) => birthFor(kind).perform()}
        createKindUnavailable={(kind) => birthFor(kind).refusal}
      />
    );
  };

  /* The empty CENTRE's first-run action always creates a TASK, whichever kinds
     the docks happen to show — a session launches on one, so it is the move
     that unblocks a workspace with nothing in it. The assignable kind comes
     from the registry (a badge that carries assignees), never a literal. */
  const taskConfig = allKinds().find((k) => k.list.tile.badges.some((b) => b.source === 'assignees'))
    ?? leftConfig;
  const centreCreateFlow = useNewTask({
    spaceId: data.spaceId,
    kind: taskConfig.kind,
    placeholderTitle: placeholderNameFor(taskConfig, placeholderTitleFor(taskConfig.label)),
    commands: data.seam.commands,
    onCreated: (id) => nav.push?.(id as EntityId),
  });

  const centreIsEmpty = engine.visible.stack.length === 0 && engine.visible.pinned.length === 0;

  return (
    <WorkspaceGrid
      layout={layout}
      centerRef={centerRef}
      boardSide={boardSide}
      leftLabel={leftConfig.label}
      rightLabel={rightConfig.label}
      onResizePanel={props.onResizeSidePanel}
      onResetPanelWidth={props.onResetSidePanelWidth}
      left={
        /* A FRAGMENT, not a wrapper div, and that is load-bearing:
           `.shell-ws__side-content > .lp` gives the panel `flex: 1` as a
           DIRECT child (shell.css:786). A wrapper would break that selector
           and the list would size to its content — the exact half-drawn
           column that rule was written to fix. The header is `flex: none`
           from `.tch-rootbar`, so the two share the column correctly. */
        <>
          {columnHeader('left')}
          <EntityListPanel
            kind={leftKind}
            /* R2: the panel's own KindSelector stands down — the root header
               above owns the kind, and with it go the total and live counts
               that row carried. Labels only, no counts (D16), same as Home. */
            selectorSlot="host"
            /* NO `as never` on the row seam. The cast was load-bearing
               camouflage: it made the panel's row seam unable to reject a
               mismatched shape, which is the same blindness that let `rowsFor`
               ignore its filter for so long. The signatures line up on their
               own now. */
            /* The kind's universe — bounds every lifecycle bucket (`bucketCountLabel`).
             The aggregate the rail already draws; no new read. */
          kindTotal={data.countsFor(leftKind)?.total}
            rowsFor={data.rowsFor(leftKind)}
            pageStateOf={data.pageStateOf(leftKind)}
            loadMore={data.loadMore(leftKind)}
            boardFor={data.boardFor(leftKind) as never}
            mode={leftLayout}
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
            linkedSessionsOf={linkedSessionsOf}
            linkedPullRequestsOf={data.linkedPullRequestsOf}
            selectedId={engine.visible.stack[engine.visible.stack.length - 1] ?? null}
            onSelect={openEntity}
            /* UNCONDITIONAL since the relational panel: the Tile only ever
               mounts the ✕ on session-tree anatomy rows, and a session tile
               expanded inline under a task (any panel kind) deserves the same
               close the sessions list gives it. */
            onTerminate={handleSessionTerminate}
            onResume={handleSessionResume}
            onSetState={rowLifecycle.setState}
            onArchive={rowLifecycle.archive}
            onComplete={rowLifecycle.complete}
            onSetValue={rowLifecycle.setValue}
            onSetAxis={rowLifecycle.setAxis}
            taskAxes={data.taskAxes}
            taskWorkflows={data.taskWorkflows}
            onAssign={rowLifecycle.assign}
            assignableActors={rowLifecycle.assignable}
            onMembership={rowLifecycle.membership}
            membershipSets={rowLifecycle.membershipSets}
            connectionsOf={data.connectionsOf}
            // Capability truth now rides the SUMMARY, so a row knows what it
            // permits the moment it renders. `data.capabilitiesOf` is the one
            // authority (summary first, detail as fallback) — never inline a
            // `detailOf(id)?.capabilities` here again.
            //
            // What that replaced, because the rule it upheld still stands: this
            // read used to be detail-only, and an unhydrated row genuinely had
            // unknown capabilities and correctly stayed refused. That was right
            // — an all-true literal would claim permission the shell was never
            // granted. It was also inescapable on a COLLAPSED tile, which
            // nothing ever hydrates, so Run/Archive/Collections were drawn and
            // permanently dead there. Absence is still refusal; there is simply
            // no longer a row that has to live in it.
            //
            // `onNeedDetail` stays: it fills the rest of the detail an expanded
            // strip reads, and it is the fallback path for a node too old to
            // send the summary field.
            capabilitiesOf={data.capabilitiesOf}
            onNeedDetail={(id) => data.pull?.(id)}
            // The quick-config's escape to the full sheet. A1c's
            // LaunchTeammateOption is deliberately NOT my LaunchTeammate:
            // panels/ importing views/ would point the dependency backwards,
            // since views compose panels. One map at the seam, no cast on
            // either side.
            launch={launchPort}
            /* The header verbs (101). `wiredActions` keeps the row honest,
               and since the 2026-08-17 ruling it also decides what the row
               CONTAINS: `▮ Terminal` commits and is drawn; `launch-session`
               is absent from the list, so it is not drawn at all rather than
               drawn as a live button this dispatcher would silently drop. */
            onAction={sessionStart.onAction}
            wiredActions={sessionStart.wiredActions}
          />
        </>
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
              newTask={{
                unavailable: centreCreateFlow.unavailable,
                create: centreCreateFlow.create,
              }}
              /* GATED ON THE SEAM'S OWN SIGNAL, never the raw handle. `onAction`
                 is present exactly when a terminal can be started (`canStart`),
                 which is exactly when `startTerminal` will NOT throw — so the
                 button renders only when it works. Passing `startTerminal`
                 unconditionally draws a live control that throws on click in the
                 same empty render where `＋ New task` honestly refuses. */
              onStartTerminal={sessionStart.onAction ? sessionStart.startTerminal : undefined}
            />
          ) : (
            <PanelStack nav={visibleNav} renderPanel={renderPanel} isKeyboardOwnedAbove={props.isModalOpen} />
          )}
        </>
      }
      right={
        /* Same fragment rule as the left column — see the comment there. */
        <>
          {columnHeader('right')}
          <EntityListPanel
            kind={rightKind}
              selectorSlot="host"
            /* The kind's universe — bounds every lifecycle bucket (`bucketCountLabel`).
             The aggregate the rail already draws; no new read. */
          kindTotal={data.countsFor(rightKind)?.total}
            rowsFor={data.rowsFor(rightKind)}
            pageStateOf={data.pageStateOf(rightKind)}
            loadMore={data.loadMore(rightKind)}
            boardFor={data.boardFor(rightKind) as never}
            mode={rightLayout}
            members={data.members}
            ctx={ctx}
            compact={boardSide === 'right' ? false : rightCompact}
            liveIds={data.liveIds}
            livenessOf={data.livenessOf}
            activity={data.activity}
            messagePulses={data.messagePulses}
            linkedTasksOf={linkedTasksOf}
            linkedSessionsOf={linkedSessionsOf}
            linkedPullRequestsOf={data.linkedPullRequestsOf}
            selectedId={engine.visible.stack[engine.visible.stack.length - 1] ?? null}
            onSelect={openEntity}
            /* Same rule as the left dock — see the comment there. */
            onTerminate={handleSessionTerminate}
            onResume={handleSessionResume}
            onSetState={rowLifecycle.setState}
            onArchive={rowLifecycle.archive}
            onComplete={rowLifecycle.complete}
            onSetValue={rowLifecycle.setValue}
            onSetAxis={rowLifecycle.setAxis}
            taskAxes={data.taskAxes}
            taskWorkflows={data.taskWorkflows}
            onAssign={rowLifecycle.assign}
            assignableActors={rowLifecycle.assignable}
            onMembership={rowLifecycle.membership}
            membershipSets={rowLifecycle.membershipSets}
            connectionsOf={data.connectionsOf}
            capabilitiesOf={data.capabilitiesOf}
            onNeedDetail={(id) => data.pull?.(id)}
            launch={launchPort}
            /* The header verbs (101). `wiredActions` keeps the row honest,
               and since the 2026-08-17 ruling it also decides what the row
               CONTAINS: `▮ Terminal` commits and is drawn; `launch-session`
               is absent from the list, so it is not drawn at all rather than
               drawn as a live button this dispatcher would silently drop. */
            onAction={sessionStart.onAction}
            wiredActions={sessionStart.wiredActions}
          />
        </>
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
