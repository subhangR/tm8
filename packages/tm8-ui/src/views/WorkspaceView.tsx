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
import type { EntityId } from '@tm8/contract';
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
import { LiveSessionBar } from '../shell/LiveSessionBar';
import type { NavPort } from '../shell/nav-port';
import type { Notice } from '../shell/notices';
import { toSessionRow } from '../terminal';
import { EmptyCenter } from './EmptyCenter';
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

  const centreIsEmpty = nav.stack.length === 0 && nav.pinned.length === 0;

  const resolveSession = useCallback(
    (id: string) => {
      const summary = data.rowsFor(rightKind)(undefined).find((row) => row.id === id);
      return summary ? toSessionRow(summary) : undefined;
    },
    [data, rightKind],
  );

  return (
    <WorkspaceGrid
      layout={layout}
      centerRef={centerRef}
      left={
        <EntityListPanel
          kind={leftKind}
          rowsFor={data.rowsFor(leftKind) as never}
          ctx={ctx}
          compact={compact}
          liveIds={data.liveIds}
          livenessOf={data.livenessOf}
          activity={data.activity}
          selectedId={nav.stack[nav.stack.length - 1] ?? null}
          onSelect={(id) => nav.push?.(id as EntityId)}
          onKindChange={props.onLeftKindChange}
        />
      }
      center={
        <>
          {/* Fixed ~30px row: never scrolls, never collapses (§5.4). Its live
              set is the seam snapshot's, so no kind literal enters shell. */}
          <LiveSessionBar
            liveIds={data.liveIds}
            focusedId={nav.stack[nav.stack.length - 1] ?? null}
            resolve={resolveSession}
            livenessOf={data.livenessOf}
            activity={data.activity}
            onFocusSession={(id) => nav.push?.(id as EntityId)}
          />
          {/* 02-LAYOUT §2.2 — the empty centre is not a blank: it IS the live
              roster and it teaches the grammar. PanelStack still owns the slot
              and its C_min floor; this is the content that goes in it. */}
          {centreIsEmpty ? (
            <EmptyCenter
              liveIds={data.liveIds}
              rows={rosterRows}
              livenessOf={data.livenessOf}
              onFocusSession={(id) => nav.push(id as EntityId)}
            />
          ) : (
            <PanelStack nav={nav} renderPanel={renderPanel} />
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
