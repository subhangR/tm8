/**
 * PHASE 2 — the mount that makes `e/{id}` the Z4 full view (ruling M1).
 *
 * `EntityFullView` was built, tested and wired to nothing; `Z4Host` likewise.
 * What stood between them and the route was a WIRED PANEL: `EntityDetailPanel`
 * takes two required props and fifty-five optional ones, and the useful ones —
 * the four tabs' data, the control strip's executor, launch, membership
 * authoring, attachments, the injected surfaces — are built once per screen and
 * shared. That is why this file exists and why it is a component rather than a
 * block inside `GateApp`.
 *
 * WHY A SEPARATE COMPONENT AND NOT MORE HOOKS IN `GateApp`. Every port below is
 * an EXECUTOR: an in-flight set, an attachments port, a launch-source read. Two
 * executors that disagree about what a write means is the failure
 * `auxPanel.tsx` names in its own header, and hooks cannot be called
 * conditionally — so building them in `GateApp` would give the workspace a
 * second set on every render, for a screen it is not showing. Mounted here they
 * exist exactly when Z4 is on screen, and Z4 is never on screen beside
 * `EntityView` or `WorkspaceView`: the route arms are exclusive.
 *
 * THE PANEL IS THE SAME PANEL. `AuxEntityPanel` is the mount `EntityView`'s
 * third column uses, lifted out in #219 for precisely this second host; it
 * takes `panelHost='z4'`, which changes width and chrome and never anatomy
 * (§2.3). A second assembly here would be a poorer panel that drifts.
 *
 * ── WHAT THIS FILE DECIDES, AND WHAT IT REFUSES TO ─────────────────────────
 *
 * It decides ONE thing: what `port.lookup` answers, which is the §2.2
 * canonical-reload rule's input. It does NOT decide the history discipline
 * (`EntityFullView` computes that from `arrival` and hands it to `onLeave`), it
 * does not write the address, and it does not draw the dead-link tombstone —
 * that refusal is rendered ABOVE the shell fork by `GateApp`, because a refusal
 * must not fork. See `resolutionOf`.
 */
import { useCallback, useMemo } from 'react';
import type { EntityId, EntityKind, ExecutionSpawnInput } from '@tm8/contract';
import {
  EntityFullView,
  type EntityArrival,
  type EntityFullPort,
  type EntityLeaveStep,
  type EntityResolution,
} from './entity-full';
import { AuxEntityPanel } from './auxPanel';
import { attachmentsFor } from '../files/port';
import { getKind, kindOfSlug } from '../domain';
import type { ActionContext, ActionRef } from '../domain/types';
import type { ControlHost, DetailReasons } from '../panels';
import type { Origin } from '../routes';
import type { Notice } from '../shell/notices';
import type { GateData } from './useGateData';
import type { LinkedEntity } from './useLinkedEntity';
import { useLaunchPort } from './useLaunchPort';
import { useMembershipSurface } from './membershipSurface';
import { usePanelPrimaries } from './usePanelPrimaries';
import { useRowLifecycle } from './useRowLifecycle';

export interface EntityFullScreenProps {
  data: GateData & { pull?: (id: string) => void };
  entityId: EntityId;
  /** From the route. Null on a promote, and on the minimal shared link (R10). */
  origin: Origin | null;
  /** How the viewer got here — the ONLY thing that decides Back's behaviour. */
  arrival: EntityArrival;
  /** The read `useLinkedEntity` already made for this route. Never a second one. */
  linked: LinkedEntity;
  reasons: DetailReasons;
  onNotice(notice: Notice): void;
  /** Collapse ⤡ — given the destination and the history discipline it costs. */
  onLeave(step: EntityLeaveStep): void;
  /** Drilling sideways out of the full view. The host decides where that lands. */
  onOpenEntity(id: EntityId): void;
  onSpawn?(input: ExecutionSpawnInput): void | Promise<void>;
  onLaunchOpen?(id: EntityId): void;
  serverBaseUrl?: string | undefined;
  viewerMemberId?: string | null | undefined;
}

/**
 * THE FOUR STATES OF ONE READ (T7), mapped onto the port's three answers.
 *
 * · An `origin` in the address already names the companion, so the kind it
 *   implies IS the resolution: the link says "this entity lives on the tasks
 *   screen", and `kindOfSlug` turns that into the kind with no read at all.
 *   That is what keeps an origin-bearing link from flashing "Opening…" while a
 *   round trip it does not need completes.
 * · `checking` / `idle` — the read is in flight. `resolving`: a spinner, not a
 *   panel skeleton, because we do not yet know there is anything to draw.
 * · `live` — the entity is there. Its kind resolves the companion when the
 *   address carried no origin (the canonical-reload rule).
 * · `unreadable` — the node did not answer ABOUT THIS ENTITY. Not a tombstone:
 *   draw the panel, which runs its own read and states its own failure. The
 *   kind is null, so no companion and therefore no collapse affordance — a
 *   control that cannot perform is not drawn.
 * · `dead` — never reaches here. `GateApp` renders the standalone tombstone
 *   above the shell fork (no companion, no collapsed left panel — the §4.14
 *   shape), so `unavailable` is the one answer this adapter cannot produce and
 *   the tombstone cannot be drawn twice in two arrangements.
 */
export function resolutionOf(
  origin: Origin | null,
  linked: LinkedEntity,
  knownKind: EntityKind | null,
): EntityResolution {
  if (knownKind) return { status: 'ready', kind: knownKind } as const;
  if (origin) {
    const kind = kindOfSlug(origin.slug);
    if (kind) return { status: 'ready', kind } as const;
  }
  switch (linked.state) {
    case 'live':
      return { status: 'ready', kind: linked.kind } as const;
    case 'unreadable':
      return { status: 'ready', kind: null } as const;
    case 'dead':
      return { status: 'unavailable' } as const;
    default:
      return { status: 'resolving' } as const;
  }
}

/**
 * The kind a resolution knows, or null in every other state.
 *
 * Exported because `GateApp` needs the SAME answer for the share affordance:
 * the link a viewer copies off the full view and the companion the full view
 * collapses to must name one collection, and two derivations of "which kind is
 * this" would be two chances to disagree.
 */
export function kindOfResolution(resolution: EntityResolution): EntityKind | null {
  return resolution.status === 'ready' ? resolution.kind : null;
}

export function EntityFullScreen(props: EntityFullScreenProps) {
  const { data, entityId, origin, linked } = props;

  /* PROMOTE'S FAST PATH. The entity was on screen a moment ago, so its detail
     is already cached: a read to discover a kind we hold would be a round trip
     AND a loading flash on a purely local action. */
  const knownKind = data.detailOf(entityId)?.kind ?? null;

  /* Fill the cache the panel reads from. The same idempotent `pull` every
     other panel host calls from render (`WorkspaceView.renderPanel`,
     `EntityView`): it early-returns once the detail is there. */
  if (!data.detailOf(entityId)) data.pull?.(entityId);

  const ctx = useMemo<ActionContext>(
    () => ({ spaceId: data.spaceId, viewerActorId: data.viewerActor?.id }),
    [data.spaceId, data.viewerActor],
  );

  const attachments = useMemo(
    () => attachmentsFor(data.seam, data.spaceId),
    [data.seam, data.spaceId],
  );

  const launchPort = useLaunchPort(data, {
    ...(props.onSpawn ? { onSpawn: props.onSpawn } : {}),
    ...(props.onLaunchOpen
      ? { onFullOptions: (id: string) => props.onLaunchOpen?.(id as EntityId) }
      : {}),
  });

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
    [props.onNotice], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const primaries = usePanelPrimaries({
    seam: data.seam,
    reconcileCommand: data.reconcileCommand,
    onError: notifyCloseFailed,
  });

  const rowLifecycle = useRowLifecycle({
    data,
    viewerMemberId: props.viewerMemberId,
    onNotice: props.onNotice,
  });

  const membership = useMembershipSurface({
    spaceId: data.spaceId,
    seam: data.seam,
    refetchDetail: data.refetchDetail,
    onNotice: props.onNotice,
  });

  /* What the read (or the origin, or the cache) says this entity is. One
     expression, read by three consumers below, so they cannot disagree. */
  const resolved = resolutionOf(origin, linked, knownKind);
  const subjectKind = resolved.status === 'ready' ? resolved.kind : null;

  /* The panel's control strip, on the same executor as everywhere else — a
     task's state and assignment behave identically in Z4 and in the aside.

     `kind` is the SURFACE's kind, and Z4's surface is one entity, so it is the
     subject's own — it feeds only the "this kind has no state to set" refusal
     and the strip reads the real kind off the subject. Empty while unresolved
     rather than guessed: a refusal computed from a kind we do not have would
     be a sentence about the wrong thing. */
  const controlHost = useMemo<ControlHost>(
    () => ({
      kind: subjectKind ?? '',
      ctx,
      livenessOf: data.livenessOf,
      capabilitiesOf: (id: string) => data.detailOf(id)?.capabilities,
      onNeedDetail: (id: string) => data.pull?.(id),
      onSetState: rowLifecycle.setState,
      onArchive: rowLifecycle.archive,
      onSetValue: rowLifecycle.setValue,
      onAssign: rowLifecycle.assign,
      assignableActors: rowLifecycle.assignable,
      onMembership: rowLifecycle.membership,
      membershipSets: rowLifecycle.membershipSets,
      connectionsOf: data.connectionsOf,
    }),
    [subjectKind, ctx, data, rowLifecycle],
  );

  const port = useMemo<EntityFullPort>(
    () => ({ lookup: () => resolutionOf(origin, linked, knownKind) }),
    [origin, linked, knownKind],
  );

  /* Registry-supplied, never inferred here (§15.2): the work_session archetype
     declares `z4.immersive` and this host only forwards it. Unknown until the
     kind is, which is why it reads off the resolution rather than the id. */
  const immersive = subjectKind ? getKind(subjectKind).panel.z4?.immersive === true : false;

  return (
    <EntityFullView
      entityId={entityId}
      origin={origin}
      arrival={props.arrival}
      port={port}
      onLeave={props.onLeave}
      immersive={immersive}
      panel={
        <AuxEntityPanel
          panelHost="z4"
          host={{
            data,
            reasons: props.reasons,
            ctx,
            controls: controlHost,
            primaries,
            membership,
            launchPort,
            rowLifecycle,
            attachments,
            serverBaseUrl: props.serverBaseUrl,
            viewerMemberId: props.viewerMemberId,
          }}
          entityId={entityId}
          onOpenEntity={props.onOpenEntity}
          /* The panel's own ✕ means the same thing the ⤡ does here: there is
             no column to close, so closing IS collapsing. Drawn only when
             there is somewhere to collapse to, by the same rule. */
          onClose={() => props.onLeave({ destination: null, history: 'push' })}
        />
      }
    />
  );
}
