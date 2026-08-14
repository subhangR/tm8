/**
 * EntityView — the per-kind screen every rail kind-row opens.
 *
 * THE 2026-07-31 USER RULING, which supersedes D65's wide-list-in-the-middle:
 * an entity screen is a THREE-REGION READING SURFACE, not a list with a peek.
 *
 *   LEFT   the entity list panel — the SAME `EntityListPanel` the workspace
 *          uses (search, filter chips, lifecycle tabs, sections, tiles), at a
 *          fixed rail width. Not the wide `EntityTree`: the list is now a
 *          navigator, and a navigator wants search more than it wants width.
 *   CENTRE the COMPLETE entity — `EntityDetailPanel` with the whole remaining
 *          width, not a 440px aside. This is the screen's subject.
 *   RIGHT  the AUX column, opened by clicking something INSIDE the centre:
 *          a linked entity, Discussion, or Connections. Absent until asked
 *          for; it never reserves space it is not using.
 *
 * WHY THE AUX COLUMN IS NOT A FOURTH TAB. Discussion and Connections are the
 * two tabs a reader wants BESIDE the document rather than instead of it —
 * "who said what about this paragraph" is a question you ask while looking at
 * the paragraph. Routing them out of the tab strip is what buys that, and it
 * is why `activeTab` is controlled here: the centre never navigates away from
 * Content on their account.
 *
 * GENERIC, ALL KINDS (§15.2). Nothing below asks which kind it is holding.
 * Docs are the kind this was verified against; tasks, teammates, sessions and
 * projects get the same three regions from the same code, because the only
 * per-kind facts on this screen — tiles, sections, filters, body archetype —
 * were already registry DATA before this change.
 *
 * ESC WALKS DOWN ONE RUNG PER PRESS: aux → centre → list.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EntityId, EntityKind, ExecutionSpawnInput, WorkSessionInteractionProfileProjection } from '@tm8/contract';
import {
  EntityDetailPanel,
  EntityListPanel,
  EmptyBody,
  type ControlHost,
  type DetailReasons,
  type PanelTab,
} from '../panels';
import { AttentionInbox } from '../attention/AttentionInbox';
import { PanelResizer, useElementWidth, usePanelFlag, usePanelWidth } from '../kit';
import { ConnectionsTab, DiscussionTab } from '../panels/detail/tabs';
import type { ActionContext, ActionRef, CollectionMode } from '../domain/types';
import { getKind } from '../domain/registry';
import { placeholderNameFor } from '../domain/title-grammar';
import { QUIET_SESSION_DETAIL, needsAttentionOf } from '../domain/needs-attention';
import {
  creatableKind,
  EditEntityDialog,
  EntityCreateControl,
  MemoryComposer,
  MemoryMarkComposer,
  placeholderTitleFor,
  useMemoryMarks,
  useMemoryWorkingSet,
  useNewTask,
} from '../authoring';
import { useEntityVerbs } from './useEntityVerbs';
import { screenKeyOf, useScreenStack } from '../stores/screenStackStore';
import type { Notice } from '../shell/notices';
import type { GateData } from './useGateData';
import { attachmentsFor } from '../files/port';
import { openEntityAndResolve } from './open-entity';
import { useLaunchPort } from './useLaunchPort';
import { mergePrPortFor } from './mergePrPort';
import { LaunchSheet, type DispatchSelection, type LaunchSelection } from './LaunchSheet';
import { composePanelActions, usePanelPrimaries } from './usePanelPrimaries';
import { useSessionStart } from './useSessionStart';
import { useRowLifecycle } from './useRowLifecycle';
import { useMembershipSurface } from './membershipSurface';
import type { ContentSurface } from '../routes';
import { LazySessionChatSurface } from '../channel-screen/LazySessionChatSurface';
import { LazyChannelChatSurface } from '../channel-screen/LazyChannelChatSurface';
import { channelFeedPortFromGateData } from './channel-feed-port';
import './entity-view.css';
import { debugSurfaceFor } from './debugSurface';
import { gitSurfaceFor } from './gitSurface';
import { taskGitSectionFor } from './taskGitSection';
import { graphSurfaceFor } from './graphSurface';
import { representedThreadMessageCount } from './message-thread';

export interface EntityViewProps {
  data: GateData & { pull?: (id: string) => void };
  serverBaseUrl?: string;
  kind: string;
  reasons: DetailReasons;
  viewerMemberId?: string | null;
  onNotice(notice: Notice): void;
  /** The rail row is the source of truth for WHICH kind; the in-panel kind
      switcher re-routes through it so the rail highlight never lies. */
  onKindChange?(kind: string): void;
  /**
   * Commits a quick-config spawn from a list tile's Run expand.
   *
   * This screen used to pass the list panel NO launch sources at all, so the
   * expand opened with an empty teammate select and an empty model select while
   * the identical panel in the workspace was fully populated. Reloading the page
   * returns to the workspace (GateApp's `activeTarget` starts there and is not
   * persisted), which is why the dropdowns "started working after a refresh".
   */
  onSpawn?(input: ExecutionSpawnInput): void | Promise<void>;
  /**
   * The full launch sheet, HERE TOO (user report 2026-08-09): tasks live on
   * this screen, and Run falling back to the inline expand exactly where
   * people launch from made the reorganized sheet unreachable in practice.
   * The shell owns the sheet state (same `useLaunchSheet` the workspace
   * uses); this screen only mounts the overlay and forwards the verbs.
   * All optional — a host that wires none keeps the honest inline fallback.
   */
  onLaunchOpen?(id: EntityId): void;
  launchSubjectId?: EntityId | null;
  launchRefusal?: { cause: string; detail: string } | null;
  launchInFlight?: boolean;
  onLaunchCancel?(): void;
  onLaunchSubmit?(config: LaunchSelection): void;
  /** D5 — hand the subject to the dispatcher without forwarding launch config. */
  onLaunchDispatch?(request: DispatchSelection): void;
  /**
   * §1.1 mode wiring: the shell holds the layout mode (it is route state) and
   * this screen passes it through to the panel. Absent ⇒ the panel's local
   * fallback, exactly as before.
   */
  mode?: CollectionMode;
  onMode?(mode: CollectionMode): void;
}

/**
 * What the right column is showing. Two sorts rather than one id, because
 * "the doc's discussion" has no entity of its own to point at — flattening
 * them would mean inventing a synthetic id for a tab.
 */
type AuxTarget =
  | { sort: 'entity'; id: EntityId }
  | { sort: 'tab'; tab: 'discussion' | 'connections' };

/** The tabs that stay INSIDE the centre panel. The other two go right. */
const AUX_TABS = new Set<PanelTab>(['discussion', 'connections']);

/* ---------------------------------------------------------------------------
 * THE THREE REGIONS ARE NOW DRAGGABLE, AND THEIR FLOORS ARE THE LAW
 *
 * The widths below were literals in `entity-view.css` with a media-query ladder
 * stepping them down. That ladder is what the user reported as the bug: the
 * workspace's identical three-region layout has resizable side columns, so a
 * detail screen that refuses the same gesture reads as a broken control. The
 * literals move here because the DRAG has to clamp against them and a number
 * that lives in a stylesheet cannot be clamped against — CSS is now handed the
 * solved widths as custom properties instead, the same trade `WorkspaceGrid`
 * already makes with `--ws-left`.
 *
 * `EV_CENTER_MIN` is what makes the drag honest. The centre is the SUBJECT of
 * this screen (the 2026-07-31 ruling), so it is the one region a resize is
 * never allowed to eat; every max width below is derived from the measured root
 * minus this floor, never from a breakpoint.
 * ------------------------------------------------------------------------- */

/** The list rail is a navigator: wide enough to read a title, never a column. */
export const EV_LIST_MIN = 220;
export const EV_LIST_DEFAULT = 320;
/** Same reading width the workspace's stacked panel uses — same content. */
export const EV_AUX_MIN = 320;
export const EV_AUX_DEFAULT = 420;
/** The subject's floor. Nothing outbids the centre (D63's rule, one level up). */
export const EV_CENTER_MIN = 420;
/** Collapsed, the rail keeps a strip — a hidden panel with no way back is a trap. */
export const EV_LIST_COLLAPSED = 34;

/**
 * THE CHROME BETWEEN THE COLUMNS IS PART OF THE BUDGET.
 *
 * A separator is 8px of real, occupied row (`.kit-resizer`), and each side
 * column paints a 1px hairline that ADDS to its width — no stylesheet in this
 * package sets `box-sizing: border-box` globally, so `.ev-list` and `.ev-aux`
 * are content-box and `width: 320px` occupies 321.
 *
 * Omitting these was a real arithmetic bug, not a rounding quibble: dragging to
 * `End` handed the centre `outer − EV_CENTER_MIN` of room that the chrome had
 * already spent, leaving 411px with one side column and 402px with both —
 * under the 420px floor this file declares. It is the WLT `Σb` term, which the
 * workspace's own solver takes as a parameter for exactly this reason.
 * (Reported by review of PR #213.)
 */
export const EV_RESIZER = 8;
export const EV_PANEL_BORDER = 1;
/** What one side column costs BEYOND its own width. */
const SIDE_CHROME = EV_RESIZER + EV_PANEL_BORDER;

const clampWidth = (want: number, min: number, max: number): number =>
  Math.min(Math.max(min, want), Math.max(min, max));

export function EntityView(props: EntityViewProps) {
  const { data, kind, reasons } = props;

  /*
   * THE OPEN ENTITY LIVES OUTSIDE THIS COMPONENT (user report, 2026-07-31).
   * It was `useState` here, and the menu rail switches screens by swapping a
   * branch of GateApp's ternary — which unmounts this view and destroyed the
   * selection with it. The stack is keyed by THIS screen, so returning to it
   * restores what was open, and a different screen's stack is unreachable
   * from here.
   */
  const screen = useScreenStack(screenKeyOf.kind(kind));
  const selectedId = screen.selected;
  const setSelectedId = useCallback(
    (id: EntityId | null) => {
      if (id === null) screen.clear();
      else screen.open(id);
    },
    // `screen` is rebuilt each render; its key is the only identity that
    // matters and it is derived from `kind`.
    [kind], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [aux, setAux] = useState<AuxTarget | null>(null);
  const [detailTab, setDetailTab] = useState<PanelTab>('content');
  const [contentSurfaces, setContentSurfaces] = useState<Record<string, ContentSurface>>({});
  const resolvingAttention = useRef(new Set<EntityId>());
  // Separate from `resolvingAttention`: a read mark is written on every open,
  // an attention resolve only sometimes, so one shared set would let either
  // suppress the other.
  const markingRead = useRef(new Set<EntityId>());

  /*
   * A kind switch is a NEW screen, and the rule that produced this effect
   * still holds: carrying a selection across kinds would show a doc in the
   * "Tasks" view's centre. It is now enforced STRUCTURALLY instead — a doc and
   * a task sit under different stack keys, so neither can reach the other's
   * selection and there is nothing to reset.
   *
   * What still must reset is the per-subject chrome: `aux` and `detailTab` are
   * about whichever entity was open, so they cannot survive into a screen
   * whose subject is a different entity. Clearing the SELECTION here is what
   * would now be wrong — it would wipe the stack this screen just restored.
   */
  useEffect(() => {
    setAux(null);
    setDetailTab('content');
  }, [kind]);

  useEffect(() => {
    data.ensureKind(kind);
  }, [data, kind]);

  const ctx = useMemo<ActionContext>(
    () => ({ spaceId: data.spaceId, viewerActorId: data.viewerActor?.id }),
    [data.spaceId, data.viewerActor],
  );

  /*
   * ATTACHMENTS, one port for the whole view. Memoized on the seam+space so
   * the panel's strip does not get a fresh `startUpload` identity on every
   * keystroke elsewhere in the view.
   */
  const attachments = useMemo(
    () => attachmentsFor(data.seam, data.spaceId),
    [data.seam, data.spaceId],
  );
  const config = getKind(kind);
  /**
   * THE LAYOUT MODE IS RESOLVED HERE, not twice.
   *
   * The panel carries the same controlled/uncontrolled pair, and if the screen
   * read `props.mode` while the panel fell back to its OWN local state the two
   * would disagree the moment a host mounts this view without `onMode` — the
   * switcher would draw a board inside a rail sized for a list. Resolving once
   * and passing the pair down leaves the panel's fallback unreachable.
   */
  const [uncontrolledMode, setUncontrolledMode] = useState<CollectionMode>(config.defaultMode);
  const mode = props.mode ?? uncontrolledMode;
  const setMode = props.onMode ?? setUncontrolledMode;
  /**
   * THE BOARD IS THE WHOLE SCREEN, not a body inside the 320px rail.
   *
   * A board's unit is a COLUMN and a column has a floor width, so the three
   * regions below reduce to one: the list panel takes the full width and the
   * centre is not rendered. Gated on `list.board` for the same reason the
   * panel's body is — without a board spec the mode has nothing to draw.
   */
  const boardMode = mode === 'board' && config.list.board != null;

  /*
   * THE COLUMN GEOMETRY — stored preference, measured clamp.
   *
   * Two numbers per column, deliberately: `listPref.width` is what the viewer
   * ASKED for and outlives a narrow window, while `listWidth` below it is what
   * currently FITS. Clamping on write instead would let one narrow window
   * silently overwrite a preference the viewer set on a wide one.
   *
   * The widths are keyed per kind, not per screen instance. Someone who wants a
   * wide list for Tasks and a narrow one for Docs gets both, and the choice
   * survives a reload the way the theme does.
   */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rootWidth = useElementWidth(rootRef);
  const listPref = usePanelWidth(`entity.${kind}.list`, EV_LIST_DEFAULT, EV_LIST_MIN);
  const auxPref = usePanelWidth('entity.aux', EV_AUX_DEFAULT, EV_AUX_MIN);
  const [listCollapsed, setListCollapsed] = usePanelFlag(`entity.${kind}.list-collapsed`, false);

  /* On the board the list IS the screen — it takes the whole width and there is
     no centre to protect, so neither the drag nor the collapse applies. */
  const listResizable = !boardMode && !listCollapsed;
  /*
   * BEFORE THE FIRST MEASUREMENT, THE WINDOW STANDS IN FOR THE ROOT.
   *
   * `rootWidth` is 0 until the observer fires (and stays 0 in environments with
   * no ResizeObserver at all). Falling back to the CURRENT width would be worse
   * than useless: it makes `maxWidth === width`, so the column can be narrowed
   * and never widened — a separator that only works one way. The window is a
   * genuine upper bound on any element inside it, so it is a loose but HONEST
   * ceiling for the one frame before the real number lands.
   */
  const outerWidth = rootWidth > 0
    ? rootWidth
    : (typeof window === 'undefined' ? 0 : window.innerWidth);
  /* Every term the centre does NOT get: the other column's width, and the
     separator + hairline each side column costs on top of it. The list keeps
     its chrome while collapsed — the strip still has a border and the separator
     is still mounted — so `SIDE_CHROME` is unconditional on that side. */
  const auxRoom = aux ? auxPref.width + SIDE_CHROME : 0;
  const listRoom = listCollapsed ? EV_LIST_COLLAPSED : EV_LIST_MIN;
  const listMax = Math.max(EV_LIST_MIN, outerWidth - EV_CENTER_MIN - SIDE_CHROME - auxRoom);
  const listWidth = listCollapsed
    ? EV_LIST_COLLAPSED
    : clampWidth(listPref.width, EV_LIST_MIN, listMax);
  const auxMax = Math.max(
    EV_AUX_MIN,
    outerWidth - EV_CENTER_MIN - SIDE_CHROME - listRoom - SIDE_CHROME,
  );
  const auxWidth = clampWidth(auxPref.width, EV_AUX_MIN, auxMax);

  /* Stable identity so the feed hook's effects do not re-run every render. */
  const channelFeedPort = useMemo(() => channelFeedPortFromGateData(data), [data]);

  /* The list panel's Run expand, wired from the SAME source the workspace uses
     (`useLaunchPort`). Without this the expand rendered with `teammates ?? []`
     and the teammate and model selects were both empty. */
  const launchPort = useLaunchPort(data, {
    ...(props.onSpawn ? { onSpawn: props.onSpawn } : {}),
    ...(props.onLaunchOpen
      ? { onFullOptions: (id: string) => props.onLaunchOpen?.(id as EntityId) }
      : {}),
  });

  /* The panel action bar's executor. Same hook the workspace uses, so the
     Terminate button behaves identically wherever a session panel is opened. */
  /* A useCallback, not an inline arrow — see WorkspaceView for why an unstable
     reporter churns the whole dispatcher's identity every render. */
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

  /* D67 — the expanded row's state dropdown and archive control. Same executor
     the workspace uses, so a task behaves identically in both surfaces. */
  const rowLifecycle = useRowLifecycle({
    data,
    viewerMemberId: props.viewerMemberId,
    onNotice: props.onNotice,
  });

  /**
   * The PANEL's control strip, on the SAME executor as the list's.
   *
   * One host object, both surfaces: a task's state, priority and assignment
   * behave identically whether the user changes them from a row in the list or
   * from the panel that the ＋ New flow just opened. Wiring the panel to a
   * second executor is how the two would come to disagree about what a write
   * means — and the panel is where a just-created task is FIRST seen, so it is
   * the surface that most needs the controls to be real.
   *
   * `kind` is the list's kind: it feeds only the "this kind has no state to
   * set" refusal, and the strip reads the actual kind off the subject.
   */
  const controlHost = useMemo<ControlHost>(
    () => ({
      kind: config.kind,
      ctx,
      livenessOf: data.livenessOf,
      capabilitiesOf: (id) => data.detailOf(id)?.capabilities,
      /* See WorkspaceView's copy: without this the expanded row's controls
         never learn their permissions and Archive never fires. */
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
    [config.kind, ctx, data, rowLifecycle],
  );

  /* Authoring mount 7a, EntityView host: +New in the list head creates for
     real and opens the new entity in the centre. quickCreate gates by
     registry data. */
  const createFlow = useNewTask({
    spaceId: data.spaceId,
    kind: config.kind,
    // "Untitled channel" is neither a legal channel name nor a unique one, and
    // the create commits before the user types. `placeholderNameFor` settles both.
    placeholderTitle: placeholderNameFor(config, placeholderTitleFor(config.label)),
    commands: data.seam.commands,
    onCreated: (id) => setSelectedId(id as EntityId),
  });

  // Esc walks DOWN one level per press — the canvas's own law, extended one
  // rung now that there is a third region above the centre.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (aux === null && selectedId === null) return;
      // A focused terminal, an open sheet, or the doc editor's own esc-cancels
      // owns its Esc; only act when the event reaches the document unclaimed.
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (aux !== null) {
        setAux(null);
        return;
      }
      /*
       * Esc still walks DOWN one rung per press, but the rung below the centre
       * is now the entity you opened this one FROM, not the bare list. Popping
       * an empty-but-for-one stack lands on the list exactly as before, so the
       * gesture is unchanged for anyone who never drilled in.
       */
      setAux(null);
      setDetailTab('content');
      screen.pop();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // `screen.pop` is stable per key; `kind` is that key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, aux, kind]);

  const openEntity = useCallback((id: EntityId, open: (id: EntityId) => void) => {
    const summary = data.detailOf(id)
      ?? data.rowsFor(kind)(undefined).find((row) => row.id === id)
      ?? data.graph.nodes.find((row) => row.id === id);
    openEntityAndResolve({
      entityId: id,
      needsAttention: summary?.badges.attention != null,
      open,
      commands: data.seam.commands,
      reconcile: data.reconcileCommand,
      resolving: resolvingAttention.current,
      marking: markingRead.current,
      onRead: data.refreshCounts,
      onError: (error) => props.onNotice({
          id: `attention-resolve-failed:${id}`,
          tone: 'error',
          title: 'Attention could not be resolved',
          body: String((error as { message?: string })?.message ?? error),
          ttlMs: 6_000,
        }),
    });
  }, [data, kind, props.onNotice]);

  /**
   * A row in the LEFT list replaces the subject of the whole screen, so the
   * aux column — which is always ABOUT the old subject — must go with it.
   * Leaving it would put one entity's backlinks beside another's body.
   *
   * ON THE BOARD there is no centre to replace: the board IS the screen, so a
   * card opens the aux column instead. Routing it to the centre would set a
   * subject nothing renders — a click into a black hole.
   */
  const selectFromList = useCallback((id: string) => {
    if (boardMode) {
      openEntity(id as EntityId, (opened) => setAux({ sort: 'entity', id: opened }));
      return;
    }
    setAux(null);
    setDetailTab('content');
    openEntity(id as EntityId, setSelectedId);
  }, [openEntity, boardMode, setSelectedId]);

  /**
   * The session list's HEADER verbs (101) — the SAME hook the workspace calls,
   * for the reason `useLaunchPort`'s docblock gives: this screen mounts the
   * same `EntityListPanel`, and wiring only the workspace would leave
   * `▮ Terminal` dead here and working there, which reads from outside like
   * flaky state rather than like a missing call.
   *
   * `selectFromList` as `onOpen`, not `setSelectedId`: a terminal the member
   * just started should land the same way a row they clicked does, including
   * the board-mode branch.
   */
  const sessionStart = useSessionStart({
    spaceId: data.spaceId,
    seam: data.seam,
    reconcileCommand: data.reconcileCommand,
    onOpen: selectFromList,
    onError: (_verb, error) => props.onNotice({
      id: 'terminal-start-failed',
      tone: 'error',
      title: 'Terminal could not be started',
      body: String((error as { message?: string })?.message ?? error),
      ttlMs: 8_000,
    }),
  });

  /**
   * Titles for the attention list. Attention spans every kind, so the left
   * list (one kind) is not enough — the graph hydration is the widest set of
   * summaries already in memory. A miss returns undefined and the inbox reads
   * the name over the wire rather than showing a guess.
   */
  const nameOf = useCallback((id: EntityId) => {
    const detail = data.detailOf(id);
    if (detail) return { title: detail.title, kind: detail.state.kind };
    const node = data.graph.nodes.find((row) => row.id === id);
    return node ? { title: node.title, kind: node.state.kind } : undefined;
  }, [data]);

  const detail = selectedId ? data.detailOf(selectedId) : null;
  const messages = selectedId ? data.messagesOf(selectedId) : undefined;
  if (selectedId && (
    !detail
    || messages === undefined
    || representedThreadMessageCount(messages) < detail.counters.messages
  )) props.data.pull?.(selectedId);
  const selectedContent = detail?.content as unknown as {
    interactionProfile?: WorkSessionInteractionProfileProjection | null;
  } | undefined;
  const recordedStatus = (detail?.state as unknown as { status?: string } | undefined)?.status;

  // The aux entity's own detail. Hydration is the same read-through the
  // centre uses — an unhydrated id renders the panel's loading state rather
  // than an empty one pretending the entity has no content.
  const auxId = aux?.sort === 'entity' ? aux.id : null;
  const auxDetail = auxId ? data.detailOf(auxId) : null;
  if (auxId && !auxDetail) props.data.pull?.(auxId);

  /**
   * The panel action bar's executor — `edit` (the `editFields` dialog) and
   * `add-child` (a subchannel, when the open entity is a channel).
   *
   * SUBJECT-DRIVEN, NOT LIST-DRIVEN: it reads `detail`, so drilling from a task
   * list into a channel offers the channel's verbs and the channel's fields.
   * The created child opens exactly as `＋ New` opens a new root, so the two
   * creates land the user in the same place.
   */
  const verbs = useEntityVerbs({
    detail,
    spaceId: data.spaceId,
    commands: data.seam.commands,
    onCreated: (id) => setSelectedId(id),
    /* The topic lives in the DETAIL and the echo carries only the summary —
       without this the header renames and the hub body keeps the old topic. */
    onSaved: (id) => props.data.refetchDetail(id),
  });

  /**
   * The `remembers` working-set authoring for whatever the centre is showing.
   *
   * WHICH ENTITIES HOST ONE IS A REGISTRY QUESTION, not a kind check here: the
   * set is offered exactly where a row declares a `memory-set` block. 085
   * widened `remembers.src_kinds` to the wildcard, so adding that block to the
   * task row is all it takes to give tasks a working set — no edit in this file.
   *
   * `canEdit` is the server's own answer about this subject, so the controls
   * refuse for the same reason the node would rather than guessing.
   */
  const memorySetBlock = detail
    ? (getKind(detail.state.kind).panel.blocks ?? []).find((block) => block.block === 'memory-set')
    : undefined;
  const memorySetHost = memorySetBlock ? detail : null;
  const memoryWorkingSet = useMemoryWorkingSet({
    spaceId: data.spaceId,
    holderId: memorySetHost?.id ?? null,
    /* Both read off the block the registry declared — see the row's comment for
       why the authoring lane cannot carry these as literals. */
    memberKind: creatableKind(String(memorySetBlock?.params?.dstKind ?? '') as EntityKind),
    edgeType: String(memorySetBlock?.params?.edgeType ?? ''),
    refusal: memorySetHost && !memorySetHost.capabilities.canEdit
      ? 'The node refuses edits to this entity, so its working set is read-only here.'
      : null,
    commands: data.seam.commands,
    onChanged: (id) => props.data.refetchDetail(id),
    onError: (title, body) => props.onNotice({
      id: `memory-working-set:${String(memorySetHost?.id ?? 'none')}`,
      tone: 'error',
      title,
      body,
      ttlMs: 12_000,
    }),
  });

  /**
   * Collection-membership authoring, through the ONE composer every panel
   * host shares (`membershipSurface`, the `gitSurface` pattern) — hand-wiring
   * it per host is how four of the five mounts shipped without an add
   * control. Which panels offer it stays a registry question inside the
   * surface, and it serves BOTH mounts here: the centre and the aux column.
   */
  const membership = useMembershipSurface({
    spaceId: data.spaceId,
    seam: data.seam,
    refetchDetail: (id) => props.data.refetchDetail(id),
    onNotice: props.onNotice,
  });

  /**
   * Marking a memory (`supersedes` / `disputes`, 056 §5).
   *
   * OFFERED WHERE THE ROW DECLARES AN `epistemics` BLOCK — the same registry
   * test the working set uses, so no kind is named here either. The memory's
   * CURRENT version is threaded through because `disputes.props.pinnedVersion`
   * must pin it: a dispute pinned at an older version stops applying the moment
   * the content moves, so a guessed number authors a mark that does nothing.
   */
  const marksHost = detail
    && (getKind(detail.state.kind).panel.blocks ?? []).some((block) => block.block === 'epistemics')
    ? detail
    : null;
  const memoryMarks = useMemoryMarks({
    spaceId: data.spaceId,
    target: marksHost
      ? { id: marksHost.id, version: marksHost.version, title: marksHost.title }
      : null,
    memberKind: creatableKind(String(memorySetBlock?.params?.dstKind ?? 'memory') as EntityKind),
    commands: data.seam.commands,
    onChanged: (id) => props.data.refetchDetail(id),
    onError: (title, body) => props.onNotice({
      id: `memory-mark:${String(marksHost?.id ?? 'none')}`,
      tone: 'error',
      title,
      body,
      ttlMs: 12_000,
    }),
  });

  const panelActions = composePanelActions([
    { onAction: selectedId ? primaries.forEntity(selectedId) : undefined, wiredActions: primaries.wiredActions },
    { onAction: verbs.onAction, wiredActions: verbs.wiredActions },
  ]);

  const detailPanel = selectedId ? (
    <EntityDetailPanel
      detail={detail ?? null}
      serverBaseUrl={props.serverBaseUrl}
      loading={!detail}
      host="stack"
      reasons={reasons}
      ctx={{ ...ctx, entityId: selectedId }}
      controls={controlHost}
      /* Terminate comes from `primaries`, edit and add-child from `verbs` —
         see `composePanelActions` for why neither can be passed alone. */
      onAction={panelActions.onAction}
      wiredActions={panelActions.wiredActions}
      memoryAuthoring={memoryWorkingSet.authoring}
      membershipAuthoring={membership.authoringFor(detail)}
      onMarkMemory={memoryMarks.begin}
      launch={launchPort}
      mergePr={mergePrPortFor(data.seam)}
      /* The tombstone's way back. `restore` is the same verb the strip's
         archive control flips to, through the same executor — so an archived
         task reopens from wherever the user meets it. */
      onRestore={() => rowLifecycle.archive('restore', selectedId)}
      pinned={false}
      // Pinning belongs to the workspace's stack economy; here the panel HAS
      // a permanent slot, so the verb is refused with the true reason rather
      // than hidden (L6).
      pinRefusal="Pinning lives in the Workspace — this view keeps the panel beside the list already"
      liveness={data.livenessOf(selectedId)}
      livenessOf={data.livenessOf}
      /* The block signal reaches BOTH content surfaces through this one prop —
         a session that needs you must not be visible only to whichever surface
         happens to be selected. Evaluated through the shared predicate so this
         view and the entity list can never disagree about the same session. */
      needsAttention={detail ? needsAttentionOf(detail, data.livenessOf) : false}
      attentionDetail={QUIET_SESSION_DETAIL}
      attachments={attachments}
      onAttachmentUploaded={() => props.data.refetchDetail(selectedId)}
      viewerMemberId={props.viewerMemberId}
      contentSurface={contentSurfaces[selectedId] ?? null}
      onContentSurfaceChange={(surface) => {
        setContentSurfaces((current) => ({ ...current, [selectedId]: surface }));
      }}
      /* Same archetype fork as WorkspaceView, and it belongs in BOTH hosts:
         this one was missed when channels became a collection, so opening a
         channel from its `k/` list handed the SESSION chat surface a channel
         anchor and the server refused it — "feed scope session_chat_v1 is not
         applicable to a channel anchor". The kind literal stays out of it; the
         registry's archetype decides. */
      chatSurface={detail && getKind(detail.kind).panel.archetype === 'hub' ? (
        <LazyChannelChatSurface
          port={channelFeedPort}
          channelId={selectedId}
          connection={data.connection}
          onOpenEntity={(id) => setAux({ sort: 'entity', id: id as EntityId })}
          threads={getKind(detail.kind).panel.threads === true}
          anchorTitle={`${getKind(detail.kind).chip.glyph}${detail.title}`}
        />
      ) : detail ? (
        <LazySessionChatSurface
          seam={data.seam}
          sessionId={selectedId}
          spaceId={data.spaceId}
          viewerMemberId={props.viewerMemberId ?? 'anonymous'}
          connection={data.connection}
          sessionExited={recordedStatus === 'exited' || recordedStatus === 'failed'}
          defaultLimit={selectedContent?.interactionProfile?.feedPolicy.pageSize}
          composerPolicy={selectedContent?.interactionProfile?.composerPolicy}
          needsAttention={detail ? needsAttentionOf(detail, data.livenessOf) : false}
          attentionDetail={QUIET_SESSION_DETAIL}
          onOpenEntity={(id) => setAux({ sort: 'entity', id: id as EntityId })}
          onSwitchToTerminal={() => {
            setContentSurfaces((current) => ({ ...current, [selectedId]: 'terminal' }));
          }}
        />
      ) : undefined}
      debugSurface={detail ? debugSurfaceFor(data.seam, selectedId, data.livenessOf) : undefined}
      gitSurface={detail ? gitSurfaceFor(data.seam, selectedId, data.livenessOf) : undefined}
      taskGitSection={taskGitSectionFor(data.seam, detail, (id) => setAux({ sort: 'entity', id: id as EntityId }))}
      graphSurface={
        detail
          ? graphSurfaceFor(data.seam, selectedId, data.livenessOf, (id) =>
              setAux({ sort: 'entity', id: id as EntityId }),
            )
          : undefined
      }
      messages={messages}
      connections={data.connectionsOf(selectedId)}
      linkedPullRequests={data.linkedPullRequestsOf?.(selectedId) ?? []}
      linkedPullRequestsOf={data.linkedPullRequestsOf}
      /* `post` now carries what the composer can express: the body, the ids
         the `@` picker committed, and the files it staged. Spread whole so a
         field added to `DiscussionPostInput` cannot be silently dropped by
         this adapter — which is exactly how `mentionIds` went unsent for as
         long as it did. */
      onPostMessage={(post) => data.postMessage({ clientMutationId: `post:${selectedId}:${Date.now()}`, anchorIds: [selectedId], ...post })}
      mentionOptions={data.mentionOptions}
      skillOptions={data.skillOptions}
      /* GAP-2 (data-wiring handover): the save path — inline title + Save +
         conflict card, and now the doc editor behind the reader archetype —
         is live only where the host hands down the seam's commands.
         AuthoringCommands is a structural subset, no cast. */
      commands={data.seam.commands}
      onSaved={data.reconcileCommand}
      streaming={data.activity[selectedId] ?? false}
      /* THE AUX ROUTE. A reference inside the body opens BESIDE the document
         rather than replacing it — the whole point of the third column. The
         subject of the screen is only ever changed from the left list. */
      onOpenEntity={(id) => setAux({ sort: 'entity', id: id as EntityId })}
      activeTab={detailTab}
      onTabChange={(tab) => {
        if (AUX_TABS.has(tab)) setAux({ sort: 'tab', tab: tab as 'discussion' | 'connections' });
        else setDetailTab(tab);
      }}
      onClose={() => {
        setSelectedId(null);
        setAux(null);
      }}
    />
  ) : null;

  return (
    <div
      className="ev-root"
      ref={rootRef}
      data-testid="entity-view"
      data-kind={kind}
      data-mode={selectedId ? 'detail' : 'list'}
      data-aux={aux ? aux.sort : 'none'}
      data-layout={boardMode ? 'board' : 'columns'}
      data-list-collapsed={listCollapsed && !boardMode ? true : undefined}
      /* The solved widths reach the stylesheet as custom properties rather than
         as inline widths on each column, so the CSS keeps owning the floors and
         the borders while this file owns the arithmetic. */
      style={{
        '--ev-list': `${listWidth}px`,
        '--ev-aux': `${auxWidth}px`,
        '--ev-list-min': `${EV_LIST_MIN}px`,
        '--ev-aux-min': `${EV_AUX_MIN}px`,
      } as React.CSSProperties}
    >
      {/* AT THE VIEW ROOT, NOT INSIDE THE PANEL. The dialog is `position:
          fixed` over a scrim, so nesting it in the panel's own overflow
          context would clip it against a column it is supposed to cover. */}
      <EditEntityDialog
        flow={verbs.edit}
        fields={verbs.editFields}
        title={verbs.editTitle}
        skillOptions={data.skillOptions}
        /* The dialog edits the entity this view has open, so its multiline
           fields upload against that entity's own id. Absent while nothing
           is selected — an upload needs an anchor, and there is none. */
        attach={
          selectedId && attachments
            ? (file: File) => attachments.startUpload(file, selectedId as EntityId)
            : undefined
        }
        onAttached={() => selectedId && data.refetchDetail(selectedId)}
      />
      {/* The full launch sheet, overlaying this screen the same way it
          overlays the workspace centre (`.ls` is absolute against the view
          root). Mounted only while the shell holds a subject. */}
      {props.launchSubjectId && (
        <LaunchSheet
          refusal={props.launchRefusal}
          launching={props.launchInFlight}
          subjectId={props.launchSubjectId}
          fromChip="◔ Run ▸"
          fromCaption="subject pre-associated — the session links to it"
          teammates={data.launch.teammates}
          projects={data.launch.projects}
          profiles={data.launch.profiles}
          memories={data.launch.memories}
          capacity={data.launch.capacity}
          loadCredentialStatus={data.seam.credentials.status}
          onCancel={() => props.onLaunchCancel?.()}
          onLaunch={(config) => props.onLaunchSubmit?.(config)}
          onDispatch={props.onLaunchDispatch}
        />
      )}
      {/* Same reason as the dialog above: fixed over a scrim, so it belongs at
          the view root and not inside the panel's overflow context. */}
      <MemoryComposer
        composer={memoryWorkingSet.composer}
        holderLabel={memorySetHost?.title ?? 'this entity'}
        skillOptions={data.skillOptions}
      />
      <MemoryMarkComposer
        composer={memoryMarks.composer}
        targetTitle={marksHost?.title ?? 'this memory'}
        skillOptions={data.skillOptions}
      />
      {/* COLLAPSED, THE RAIL IS A STRIP, NOT A DISAPPEARANCE (L6). The list is
          how you change the subject of this screen; hiding it with no visible
          way back would strand a viewer who collapsed it by accident. The strip
          carries the reopen control and the kind's own label, so it says what
          bringing it back would bring back. */}
      {listCollapsed && !boardMode ? (
        <section
          className="ev-list ev-list--collapsed"
          id="entity-view-list"
          aria-label={`${config.labelPlural} list, collapsed`}
        >
          <button
            type="button"
            className="ev-list__toggle"
            data-testid="entity-view-list-expand"
            aria-expanded={false}
            title={`Show the ${config.labelPlural.toLowerCase()} list`}
            aria-label={`Show the ${config.labelPlural.toLowerCase()} list`}
            onClick={() => setListCollapsed(false)}
          >
            <span aria-hidden>»</span>
          </button>
          <span className="ev-list__spine" aria-hidden>{config.labelPlural}</span>
        </section>
      ) : (
      <section className="ev-list" id="entity-view-list" aria-label={`${config.labelPlural} list`}>
        {/* NOT OFFERED ON THE BOARD: there the list is the subject of the
            screen, so collapsing it would leave nothing behind. */}
        {boardMode ? null : (
          <button
            type="button"
            className="ev-list__toggle ev-list__toggle--floating"
            data-testid="entity-view-list-collapse"
            aria-expanded
            title={`Hide the ${config.labelPlural.toLowerCase()} list`}
            aria-label={`Hide the ${config.labelPlural.toLowerCase()} list`}
            onClick={() => setListCollapsed(true)}
          >
            <span aria-hidden>«</span>
          </button>
        )}
        <EntityListPanel
          kind={kind}
          rowsFor={data.rowsFor(kind)}
          pageStateOf={data.pageStateOf(kind)}
          loadMore={data.loadMore(kind)}
          boardFor={data.boardFor(kind) as never}
          mode={mode}
          onMode={setMode}
          members={data.members}
          ctx={ctx}
          createSlot={
            config.list.quickCreate ? (
              <EntityCreateControl
                config={config}
                immediate={createFlow}
                spaceId={data.spaceId}
                commands={data.seam.commands}
                files={data.seam.files}
                onCreated={(id, result) => {
                  data.reconcileCommand(result);
                  setSelectedId(id);
                }}
              />
            ) : undefined
          }
          liveIds={data.liveIds}
          livenessOf={data.livenessOf}
          activity={data.activity}
          messagePulses={data.messagePulses}
          linkedPullRequestsOf={data.linkedPullRequestsOf}
          // Capability truth comes from the DETAIL, never the summary: a row
          // whose detail is not hydrated genuinely has unknown capabilities
          // and correctly stays refused (WorkspaceView states the same rule).
          // `onNeedDetail` is how an expanded row leaves that state.
          capabilitiesOf={(id) => data.detailOf(id)?.capabilities}
          onNeedDetail={(id) => data.pull?.(id)}
          selectedId={selectedId}
          onSelect={selectFromList}
          onKindChange={props.onKindChange}
          onSetState={rowLifecycle.setState}
          onArchive={rowLifecycle.archive}
          onSetValue={rowLifecycle.setValue}
          onAssign={rowLifecycle.assign}
          assignableActors={rowLifecycle.assignable}
          onMembership={rowLifecycle.membership}
          membershipSets={rowLifecycle.membershipSets}
          connectionsOf={data.connectionsOf}
          /* The SAME sources the workspace passes. `onFullOptions` rides in
             when the shell wired `onLaunchOpen` — this screen mounts the
             sheet itself now — and stays absent otherwise, keeping the
             honest disabled-with-reason state on hosts without one. */
          launch={launchPort}
          /* The header verbs (101) — see the same pair in `WorkspaceView`. */
          onAction={sessionStart.onAction}
          wiredActions={sessionStart.wiredActions}
        />
      </section>
      )}

      {/* The rail's drag handle. It stays MOUNTED while the rail is collapsed
          and refuses instead (`disabled`), because a control that vanishes and
          reappears under the cursor is how a resize gesture gets lost. */}
      {boardMode ? null : (
        <PanelResizer
          side="left"
          label={`${config.labelPlural} list`}
          controls="entity-view-list"
          width={listWidth}
          minWidth={EV_LIST_MIN}
          maxWidth={listMax}
          disabled={!listResizable}
          onResize={listPref.setWidth}
          onReset={listPref.reset}
        />
      )}

      {/* NOT RENDERED ON THE BOARD. The board took this width; a centre that
          is only display:none would still mount the open entity's panel — its
          chat surface, its terminal, its polling — behind an invisible region. */}
      {boardMode ? null : (
        <main className="ev-detail" aria-label={`${config.label} detail`} data-testid="entity-view-detail">
          {/* The blank centre is the space-wide triage list, not a placeholder:
              every entity waiting on a human, its requests combined into one row.
              Deliberately NOT filtered to `kind` — attention lives on entities,
              so a doc waiting on you must show while the Tasks list is open. */}
          {detailPanel ?? (
            <AttentionInbox
              seam={data.seam}
              spaceId={data.spaceId}
              nameOf={nameOf}
              onOpenEntity={selectFromList}
            />
          )}
        </main>
      )}

      {aux ? (
        <PanelResizer
          side="right"
          label="Related"
          controls="entity-view-aux"
          width={auxWidth}
          minWidth={EV_AUX_MIN}
          maxWidth={auxMax}
          onResize={auxPref.setWidth}
          onReset={auxPref.reset}
        />
      ) : null}

      {aux ? (
        <aside className="ev-aux" id="entity-view-aux" aria-label="Related" data-testid="entity-view-aux">
          <div className="ev-aux__head">
            <span className="ev-aux__crumb">{auxCrumb(aux, auxDetail?.title)}</span>
            <span className="ev-aux__spacer" />
            <span className="ev-aux__esc">esc</span>
            <button
              type="button"
              className="ev-aux__close"
              aria-label="Close related panel"
              data-testid="entity-view-aux-close"
              onClick={() => setAux(null)}
            >
              ✕
            </button>
          </div>
          <div className="ev-aux__body">
            {aux.sort === 'entity' ? (
              <EntityDetailPanel
                detail={auxDetail ?? null}
                serverBaseUrl={props.serverBaseUrl}
                loading={!auxDetail}
                host="stack"
                reasons={reasons}
                ctx={{ ...ctx, entityId: aux.id }}
                controls={controlHost}
                onAction={primaries.forEntity(aux.id)}
                wiredActions={primaries.wiredActions}
                membershipAuthoring={membership.authoringFor(auxDetail)}
                launch={launchPort}
                mergePr={mergePrPortFor(data.seam)}
                onRestore={() => rowLifecycle.archive('restore', aux.id)}
                pinned={false}
                pinRefusal="Pinning lives in the Workspace"
                liveness={data.livenessOf(aux.id)}
                debugSurface={debugSurfaceFor(data.seam, aux.id, data.livenessOf)}
                gitSurface={gitSurfaceFor(data.seam, aux.id, data.livenessOf)}
                taskGitSection={taskGitSectionFor(data.seam, data.detailOf(aux.id), (id) => setAux({ sort: 'entity', id: id as EntityId }))}
                graphSurface={graphSurfaceFor(data.seam, aux.id, data.livenessOf, (id) =>
                  setAux({ sort: 'entity', id: id as EntityId }),
                )}
                livenessOf={data.livenessOf}
                attachments={attachments}
                onAttachmentUploaded={() => props.data.refetchDetail(aux.id)}
                viewerMemberId={props.viewerMemberId}
                messages={data.messagesOf(aux.id)}
                connections={data.connectionsOf(aux.id)}
                linkedPullRequests={data.linkedPullRequestsOf?.(aux.id) ?? []}
                linkedPullRequestsOf={data.linkedPullRequestsOf}
                commands={data.seam.commands}
                onSaved={data.reconcileCommand}
                // Drilling from the aux REPLACES the aux, it does not open a
                // fourth column. Three regions is the ruling; a stack here
                // would grow the screen sideways without anyone asking.
                onOpenEntity={(id) => setAux({ sort: 'entity', id: id as EntityId })}
                onClose={() => setAux(null)}
              />
            ) : detail && aux.tab === 'discussion' ? (
              <DiscussionTab
                messages={messages ?? []}
                provenanceHollowReason={reasons.provenanceHollow}
                canPost={detail.capabilities.canEdit || detail.capabilities.canReact}
                onPost={(post) => data.postMessage({
                  clientMutationId: `post:${selectedId}:${Date.now()}`,
                  anchorIds: [selectedId as EntityId],
                  ...post,
                })}
                /* The aux column is the SAME composer as the panel's, so it
                   gets the same subjects; the attach port is deliberately not
                   forwarded here — this column is a bounded read of another
                   entity's thread, and `attachments` is bound to the panel's
                   own anchor above. Absent ⇒ the attach control says so. */
                mentionOptions={data.mentionOptions}
                skillOptions={data.skillOptions}
              />
            ) : detail && aux.tab === 'connections' ? (
              <ConnectionsTab
                detail={detail}
                connections={data.connectionsOf(detail.id)}
                onOpenEntity={(id) => setAux({ sort: 'entity', id: id as EntityId })}
              />
            ) : (
              <EmptyBody sentence="The entity this panel belongs to is no longer open." />
            )}
          </div>
        </aside>
      ) : null}
    </div>
  );
}

function auxCrumb(aux: AuxTarget, title: string | undefined): string {
  if (aux.sort === 'tab') return aux.tab;
  return title ?? 'loading…';
}
