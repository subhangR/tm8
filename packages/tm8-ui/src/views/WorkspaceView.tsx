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
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EntityId, ExecutionSpawnInput } from '@tm8/contract';
import { EntityDetailPanel, EntityListPanel, type DetailReasons } from '../panels';
import type { ActionContext } from '../domain/types';
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
import { NewTaskControl, placeholderTitleFor, useNewTask } from '../authoring';
import { getKind } from '../domain/registry';
import { newLaunchMutationId, type ProfileResolution } from '../domain/launch';
import { EmptyCenter } from './EmptyCenter';
import { LaunchSheet, type LaunchSelection } from './LaunchSheet';
import type { GateData } from './useGateData';

export interface WorkspaceViewProps {
  data: GateData & { pull?: (id: string) => void };
  serverBaseUrl?: string;
  nav: NavPort & { tabOf?: (id: EntityId) => never };
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
  onLaunchCancel?(): void;
  onLaunchSubmit?(config: LaunchSelection): void;
  /** Esc must not pop the panel under an open sheet (A1a finding 1). */
  isModalOpen?(): boolean;
  /** THE DOOR: A1c's quick-config "full options ▸" opens the full sheet. */
  onLaunchOpen?(id: EntityId): void;
  onSpawn?(input: ExecutionSpawnInput): void | Promise<void>;
}

export function WorkspaceView(props: WorkspaceViewProps) {
  const { data, nav, leftKind, rightKind, menuCollapsed, reasons } = props;

  // The measurement the whole engine hangs on. `null` until a real
  // ResizeObserver fires — never 0, which would be a claim that the centre is
  // zero-wide and would demote every pin at mount.
  const [centerRef, centerWidth] = useMeasuredWidth<HTMLDivElement>();
  const viewportWidth = useViewportWidth();

  const engine = usePanelEngine({ nav, centerWidth, onNotice: props.onNotice });

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

  const ctx = useMemo<ActionContext>(() => ({ spaceId: data.spaceId }), [data.spaceId]);

  /** Panels at the side-panel floors drop metas and abbreviate badges. */
  const leftCompact = layout.left <= 220;
  const rightCompact = layout.right <= 240;

  const renderPanel = useCallback(
    (id: EntityId, host: 'pinned' | 'stack') => {
      const detail = data.detailOf(id);
      // Ask for it if we do not have it; the panel renders its designed
      // loading state meanwhile rather than an empty frame.
      if (!detail) props.data.pull?.(id);

      const admission = engine.canPin(id);
      return (
        <EntityDetailPanel
          detail={detail ?? null}
          serverBaseUrl={props.serverBaseUrl}
          loading={!detail}
          host={host}
          reasons={reasons}
          ctx={{ ...ctx, entityId: id }}
          pinned={nav.pinned.includes(id)}
          // A1c's contract: the refusal string renders as the disabled pin
          // control in T1-4's two-line form (my D14). `undefined` ⇒ pin is live.
          pinRefusal={
            nav.pinned.includes(id) || admission.admitted
              ? undefined
              : `${admission.cause} — ${admission.remedy}`
          }
          liveness={data.livenessOf(id)}
          livenessOf={data.livenessOf}
          messages={data.messagesOf(id)}
          onPostMessage={(body) => data.postMessage({ clientMutationId: `post:${id}:${Date.now()}`, anchorIds: [id], body })}
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
        />
      );
    },
    [data, engine, nav, ctx, reasons, props],
  );

  /**
   * Roster rows for the empty centre, LIVE FIRST. Ordering is presentation, so
   * it happens here rather than in the component — and it reads the seam's live
   * set rather than sorting on any summary field, which would be the forbidden
   * inference (D6).
   */
  const rosterKind = useMemo(
    () =>
      [leftKind, rightKind].find((kind) => getKind(kind).list.liveTreatment != null) ?? rightKind,
    [leftKind, rightKind],
  );
  const rosterRows = useMemo(() => {
    const rows = data.rowsFor(rosterKind)(undefined).map((summary) => toSessionRow(summary));
    const live = new Set(data.liveIds);
    return [...rows].sort((a, b) => Number(live.has(b.id)) - Number(live.has(a.id)));
  }, [data, rosterKind]);

  const profileFor = useCallback((teamMemberId: string | null): ProfileResolution => {
    const teammate = data.launch.teammates.find((candidate) => candidate.id === teamMemberId);
    const teammateDefault = data.launch.profiles.find((profile) => profile.id === teammate?.defaultProfileId);
    if (teammateDefault) {
      return { profileId: teammateDefault.id, label: teammateDefault.name, source: 'teammate-default' };
    }
    const spaceDefault = data.launch.profiles.find((profile) => profile.isSpaceDefault);
    if (spaceDefault) {
      return { profileId: spaceDefault.id, label: spaceDefault.name, source: 'space-default' };
    }
    return { profileId: null, label: 'resolved by node at commit', source: 'none' };
  }, [data.launch.teammates, data.launch.profiles]);

  /* Each dock owns a create-flow hook so a quick-create panel keeps the
     behavior when it crosses the center. Both run unconditionally (rules of
     hooks); the control only renders when registry data says quickCreate. */
  const leftConfig = getKind(leftKind);
  const rightConfig = getKind(rightKind);
  const leftCreateFlow = useNewTask({
    spaceId: data.spaceId,
    placeholderTitle: placeholderTitleFor(leftConfig.label),
    commands: data.seam.commands,
    onCreated: (id) => nav.push?.(id as EntityId),
  });
  const rightCreateFlow = useNewTask({
    spaceId: data.spaceId,
    placeholderTitle: placeholderTitleFor(rightConfig.label),
    commands: data.seam.commands,
    onCreated: (id) => nav.push?.(id as EntityId),
  });

  const centreIsEmpty = nav.stack.length === 0 && nav.pinned.length === 0;

  return (
    <WorkspaceGrid
      layout={layout}
      centerRef={centerRef}
      leftLabel={leftConfig.label}
      rightLabel={rightConfig.label}
      onMovePanel={props.onMoveSidePanel}
      onResizePanel={props.onResizeSidePanel}
      onResetPanelWidth={props.onResetSidePanelWidth}
      left={
        <EntityListPanel
          kind={leftKind}
          createSlot={
            leftConfig.list.quickCreate && leftConfig.list.tile.anatomy === 'control-card' ? (
              <NewTaskControl
                flow={leftCreateFlow}
                label={leftConfig.palette?.createLabel ?? '＋ New'}
              />
            ) : undefined
          }
          rowsFor={data.rowsFor(leftKind) as never}
          ctx={ctx}
          compact={leftCompact}
          liveIds={data.liveIds}
          livenessOf={data.livenessOf}
          activity={data.activity}
          selectedId={nav.stack[nav.stack.length - 1] ?? null}
          onSelect={(id) => nav.push?.(id as EntityId)}
          onKindChange={props.onLeftKindChange}
          // Capability truth comes from the DETAIL, not the summary
          // (EntityCapabilities lives on EntityDetail). A row whose detail is
          // not hydrated genuinely has unknown capabilities and correctly
          // stays refused — passing a literal all-true object here would make
          // the panel claim a permission the shell was never told it has,
          // which is the optimistic-enable the rule exists to prevent.
          capabilitiesOf={(id) => data.detailOf(id)?.capabilities}
          // The quick-config's escape to the full sheet. A1c's
          // LaunchTeammateOption is deliberately NOT my LaunchTeammate:
          // panels/ importing views/ would point the dependency backwards,
          // since views compose panels. One map at the seam, no cast on
          // either side.
          launch={{
            spaceId: ctx.spaceId,
            teammates: data.launch.teammates.map((t) => ({
              id: t.id,
              label: t.name,
              agentTool: t.agentTool,
              model: t.model,
            })),
            projects: data.launch.projects.map((project) => ({
              projectId: project.id,
              name: project.name,
              trusted: project.trusted,
              ...(project.reason ? { untrustedReason: project.reason } : {}),
            })),
            capacity: data.launch.capacity,
            profileFor,
            mutationId: () => newLaunchMutationId(),
            onFullOptions: (id: string) => props.onLaunchOpen?.(id as EntityId),
            onSpawn: props.onSpawn,
          }}
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
              subjectId={props.launchSubjectId}
              fromChip="◔ Run ▸"
              fromCaption="task pre-associated — the session links to it"
              teammates={data.launch.teammates}
              projects={data.launch.projects}
              profiles={data.launch.profiles}
              capacity={data.launch.capacity}
              onCancel={() => props.onLaunchCancel?.()}
              onLaunch={(config) => props.onLaunchSubmit?.(config)}
            />
          )}
          {centreIsEmpty ? (
            <EmptyCenter
              liveIds={data.liveIds}
              rows={rosterRows}
              livenessOf={data.livenessOf}
              onFocusSession={(id) => nav.push(id as EntityId)}
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
            rightConfig.list.quickCreate && rightConfig.list.tile.anatomy === 'control-card' ? (
              <NewTaskControl
                flow={rightCreateFlow}
                label={rightConfig.palette?.createLabel ?? '＋ New'}
              />
            ) : undefined
          }
          rowsFor={data.rowsFor(rightKind) as never}
          ctx={ctx}
          compact={rightCompact}
          liveIds={data.liveIds}
          livenessOf={data.livenessOf}
          activity={data.activity}
          selectedId={nav.stack[nav.stack.length - 1] ?? null}
          onSelect={(id) => nav.push?.(id as EntityId)}
          onKindChange={props.onRightKindChange}
          capabilitiesOf={(id) => data.detailOf(id)?.capabilities}
          launch={{
            spaceId: ctx.spaceId,
            teammates: data.launch.teammates.map((t) => ({
              id: t.id,
              label: t.name,
              agentTool: t.agentTool,
              model: t.model,
            })),
            projects: data.launch.projects.map((project) => ({
              projectId: project.id,
              name: project.name,
              trusted: project.trusted,
              ...(project.reason ? { untrustedReason: project.reason } : {}),
            })),
            capacity: data.launch.capacity,
            profileFor,
            mutationId: () => newLaunchMutationId(),
            onFullOptions: (id: string) => props.onLaunchOpen?.(id as EntityId),
            onSpawn: props.onSpawn,
          }}
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
