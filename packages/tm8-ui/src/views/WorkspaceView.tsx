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
import { useCallback, useMemo } from 'react';
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
} from '../shell';
import type { NavPort } from '../shell/nav-port';
import type { Notice } from '../shell/notices';
import { toSessionRow } from '../terminal';
import { NewTaskControl, placeholderTitleFor, useNewTask } from '../authoring';
import { getKind } from '../domain/registry';
import { EmptyCenter } from './EmptyCenter';
import { LaunchSheet } from './LaunchSheet';
import { LAUNCH_CAPACITY, LAUNCH_PROFILES, LAUNCH_PROJECTS, LAUNCH_TEAMMATES } from './launch-fixtures';
import type { GateData } from './useGateData';

export interface WorkspaceViewProps {
  data: GateData & { pull?: (id: string) => void };
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
  /** D44/D51 — the launch sheet's subject, or null when closed. */
  launchSubjectId?: EntityId | null;
  /** T5-5 annotation 6: a spawn refusal renders IN the sheet, never a toast. */
  launchRefusal?: { cause: string; detail: string } | null;
  onLaunchCancel?(): void;
  onLaunchSubmit?(config: { subjectId: EntityId; teammateId: string; projectIds: string[]; profileId: string }): void;
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

  const engine = usePanelEngine({ nav, centerWidth, onNotice: props.onNotice });

  const layout = useMemo(
    () =>
      solveWorkspace({
        viewport: typeof window === 'undefined' ? 1440 : window.innerWidth,
        serverRail: false, // R10: Phase 1 wires only the implicit local server.
        stack: nav.stack,
        pinned: nav.pinned,
        menuCollapsedByUser: menuCollapsed,
        leftWidth: LEFT_PANEL_DEFAULT,
        rightWidth: RIGHT_PANEL_DEFAULT,
      }),
    [nav.stack, nav.pinned, menuCollapsed],
  );

  const ctx = useMemo<ActionContext>(() => ({ spaceId: data.spaceId }), [data.spaceId]);

  /** Panels at the side-panel floors drop metas and abbreviate badges. */
  const compact = layout.left <= 220 || layout.right <= 240;

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
  const rosterRows = useMemo(() => {
    const rows = data.rowsFor(rightKind)(undefined).map((summary) => toSessionRow(summary));
    const live = new Set(data.liveIds);
    return [...rows].sort((a, b) => Number(live.has(b.id)) - Number(live.has(a.id)));
  }, [data, rightKind]);

  /* Authoring mount 7a: the LEFT panel's +New becomes the REAL create flow.
     Hook runs unconditionally (rules of hooks); the control renders only for
     kinds whose registry row says quickCreate — data, not a kind literal. */
  const leftConfig = getKind(leftKind);
  const createFlow = useNewTask({
    spaceId: data.spaceId,
    placeholderTitle: placeholderTitleFor(leftConfig.label),
    commands: data.seam.commands,
    onCreated: (id) => nav.push?.(id as EntityId),
  });

  const centreIsEmpty = nav.stack.length === 0 && nav.pinned.length === 0;

  return (
    <WorkspaceGrid
      layout={layout}
      centerRef={centerRef}
      left={
        <EntityListPanel
          kind={leftKind}
          createSlot={
            leftConfig.list.quickCreate ? (
              <NewTaskControl flow={createFlow} label={leftConfig.palette?.createLabel ?? '＋ New'} />
            ) : undefined
          }
          rowsFor={data.rowsFor(leftKind) as never}
          ctx={ctx}
          compact={compact}
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
            teammates: LAUNCH_TEAMMATES.map((t) => ({
              id: t.id,
              label: t.name,
              agentTool: t.agentTool,
              model: t.model,
            })),
            capacity: LAUNCH_CAPACITY,
            mutationId: (id: string) => `launch:${id}`,
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
              teammates={LAUNCH_TEAMMATES}
              projects={LAUNCH_PROJECTS}
              profiles={LAUNCH_PROFILES}
              capacity={LAUNCH_CAPACITY}
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
          rowsFor={data.rowsFor(rightKind) as never}
          ctx={ctx}
          compact={compact}
          liveIds={data.liveIds}
          livenessOf={data.livenessOf}
          activity={data.activity}
          selectedId={nav.stack[nav.stack.length - 1] ?? null}
          onSelect={(id) => nav.push?.(id as EntityId)}
          onKindChange={props.onRightKindChange}
        />
      }
    />
  );
}
