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
import type { EntityId, ExecutionSpawnInput, WorkSessionInteractionProfileProjection } from '@tm8/contract';
import {
  EntityDetailPanel,
  EntityListPanel,
  EmptyBody,
  type ControlHost,
  type DetailReasons,
  type PanelTab,
} from '../panels';
import { AttentionInbox } from '../attention/AttentionInbox';
import { ConnectionsTab, DiscussionTab } from '../panels/detail/tabs';
import type { ActionContext, ActionRef, CollectionMode } from '../domain/types';
import { getKind } from '../domain/registry';
import { placeholderNameFor } from '../domain/title-grammar';
import { QUIET_SESSION_DETAIL, needsAttentionOf } from '../domain/needs-attention';
import { EditEntityDialog, NewTaskControl, placeholderTitleFor, useNewTask } from '../authoring';
import { useEntityVerbs } from './useEntityVerbs';
import { screenKeyOf, useScreenStack } from '../stores/screenStackStore';
import type { Notice } from '../shell/notices';
import type { GateData } from './useGateData';
import { attachmentsFor } from '../files/port';
import { openEntityAndResolve } from './open-entity';
import { useLaunchPort } from './useLaunchPort';
import { composePanelActions, usePanelPrimaries } from './usePanelPrimaries';
import { useRowLifecycle } from './useRowLifecycle';
import type { ContentSurface } from '../routes';
import { LazySessionChatSurface } from '../channel-screen/LazySessionChatSurface';
import { LazyChannelChatSurface } from '../channel-screen/LazyChannelChatSurface';
import { channelFeedPortFromGateData } from './channel-feed-port';
import './entity-view.css';
import { debugSurfaceFor } from './debugSurface';
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
  /* Stable identity so the feed hook's effects do not re-run every render. */
  const channelFeedPort = useMemo(() => channelFeedPortFromGateData(data), [data]);

  /* The list panel's Run expand, wired from the SAME source the workspace uses
     (`useLaunchPort`). Without this the expand rendered with `teammates ?? []`
     and the teammate and model selects were both empty. */
  const launchPort = useLaunchPort(data, props.onSpawn ? { onSpawn: props.onSpawn } : {});

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
      onSetState: rowLifecycle.setState,
      onArchive: rowLifecycle.archive,
      onSetValue: rowLifecycle.setValue,
      onAssign: rowLifecycle.assign,
      assignableActors: rowLifecycle.assignable,
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
      launch={launchPort}
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
      graphSurface={
        detail
          ? graphSurfaceFor(data.seam, selectedId, data.livenessOf, (id) =>
              setAux({ sort: 'entity', id: id as EntityId }),
            )
          : undefined
      }
      messages={messages}
      connections={data.connectionsOf(selectedId)}
      onPostMessage={(body) => data.postMessage({ clientMutationId: `post:${selectedId}:${Date.now()}`, anchorIds: [selectedId], body })}
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
      data-testid="entity-view"
      data-kind={kind}
      data-mode={selectedId ? 'detail' : 'list'}
      data-aux={aux ? aux.sort : 'none'}
      data-layout={boardMode ? 'board' : 'columns'}
    >
      {/* AT THE VIEW ROOT, NOT INSIDE THE PANEL. The dialog is `position:
          fixed` over a scrim, so nesting it in the panel's own overflow
          context would clip it against a column it is supposed to cover. */}
      <EditEntityDialog
        flow={verbs.edit}
        fields={verbs.editFields}
        title={verbs.editTitle}
      />
      <section className="ev-list" aria-label={`${config.labelPlural} list`}>
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
              <NewTaskControl flow={createFlow} label={config.palette?.createLabel ?? '＋ New'} />
            ) : undefined
          }
          liveIds={data.liveIds}
          livenessOf={data.livenessOf}
          activity={data.activity}
          messagePulses={data.messagePulses}
          // Capability truth comes from the DETAIL, never the summary: a row
          // whose detail is not hydrated genuinely has unknown capabilities
          // and correctly stays refused (WorkspaceView states the same rule).
          capabilitiesOf={(id) => data.detailOf(id)?.capabilities}
          selectedId={selectedId}
          onSelect={selectFromList}
          onKindChange={props.onKindChange}
          onSetState={rowLifecycle.setState}
          onArchive={rowLifecycle.archive}
          onSetValue={rowLifecycle.setValue}
          onAssign={rowLifecycle.assign}
          assignableActors={rowLifecycle.assignable}
          /* The SAME sources the workspace passes. `onFullOptions` is
             deliberately absent: the five-section sheet is mounted by the
             workspace centre and does not exist on this screen, so the escape
             keeps its honest disabled-with-reason state rather than pretending
             to open something that is not here. */
          launch={launchPort}
        />
      </section>

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
        <aside className="ev-aux" aria-label="Related" data-testid="entity-view-aux">
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
                launch={launchPort}
                onRestore={() => rowLifecycle.archive('restore', aux.id)}
                pinned={false}
                pinRefusal="Pinning lives in the Workspace"
                liveness={data.livenessOf(aux.id)}
                debugSurface={debugSurfaceFor(data.seam, aux.id, data.livenessOf)}
                graphSurface={graphSurfaceFor(data.seam, aux.id, data.livenessOf, (id) =>
                  setAux({ sort: 'entity', id: id as EntityId }),
                )}
                livenessOf={data.livenessOf}
                attachments={attachments}
                onAttachmentUploaded={() => props.data.refetchDetail(aux.id)}
                viewerMemberId={props.viewerMemberId}
                messages={data.messagesOf(aux.id)}
                connections={data.connectionsOf(aux.id)}
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
                onPost={(body) => data.postMessage({
                  clientMutationId: `post:${selectedId}:${Date.now()}`,
                  anchorIds: [selectedId as EntityId],
                  body,
                })}
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
