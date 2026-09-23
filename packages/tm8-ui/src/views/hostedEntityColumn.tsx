/**
 * THE HOSTED ENTITY COLUMN — `AuxEntityPanel` plus the six hooks that feed it,
 * behind one component a screen can mount with a single prop bundle.
 *
 * WHAT THIS IS AND IS NOT. It is NOT a panel: `views/auxPanel.tsx` is still the
 * app's one detail mount, and its docblock's ruling holds here unchanged — this
 * is a MOUNT, not a layout. The aside, its header and its close affordance stay
 * with the host, and `onOpenEntity` REPLACES the column's subject rather than
 * opening a second one.
 *
 * WHY IT IS ITS OWN COMPONENT rather than a branch inside each host. The bundle
 * is built from six hooks (`useLaunchPort`, `usePanelPrimaries`,
 * `useRowLifecycle`, `useMembershipSurface`, `attachmentsFor`, plus the control
 * host) and every one of them needs `GateData`. Screens mount without
 * `GateData` in the vitest suite and in the pixel harnesses, and hooks cannot
 * be called conditionally — so the bundle lives behind a component that only
 * mounts when the shell has actually supplied the data. Absent the bundle a
 * host renders no column at all, which is the honest state rather than an
 * empty aside.
 *
 * IT ARRIVED AS `craft/CraftEntityColumn` (Craft P1) and moved here when Help
 * needed the identical mount. Two copies of this file would have been the
 * second dialect of a surface whose whole point is that there is one.
 */
import { useMemo } from 'react';
import type { EntityId } from '@tm8/contract';
import type { ControlHost, DetailReasons } from '../panels';
import { attachmentsFor } from '../files/port';
import { AuxEntityPanel, type AuxPanelHost } from './auxPanel';
import { useLaunchPort } from './useLaunchPort';
import { useMembershipSurface } from './membershipSurface';
import { usePanelPrimaries } from './usePanelPrimaries';
import { useRowLifecycle } from './useRowLifecycle';
import type { GateData } from './useGateData';

/**
 * The shell bundle a hosted column needs — the same four values every
 * three-region screen takes (`HomeViewProps`, `ChannelViewProps`).
 *
 * OPTIONAL AS A GROUP wherever a host declares it, and that is the point: a
 * screen that demanded `GateData` to render its other regions could not be
 * mounted by the fixture suites at all.
 */
export interface HostedColumnBundle {
  data: GateData & { pull?: (id: string) => void };
  reasons: DetailReasons;
  serverBaseUrl?: string | undefined;
  viewerMemberId?: string | null | undefined;
  onNotice?: ((text: string) => void) | undefined;
}

export interface HostedEntityColumnProps extends HostedColumnBundle {
  entityId: EntityId;
  /** Drilling from inside the panel REPLACES the subject (the auxPanel law). */
  onOpenEntity(id: EntityId): void;
  onClose(): void;
}

export function HostedEntityColumn({
  data,
  reasons,
  serverBaseUrl,
  viewerMemberId,
  onNotice,
  entityId,
  onOpenEntity,
  onClose,
}: HostedEntityColumnProps) {
  const notify = (text: string) => onNotice?.(text);

  const launchPort = useLaunchPort(data, {});
  const primaries = usePanelPrimaries({
    seam: data.seam,
    reconcileCommand: data.reconcileCommand,
    onError: (error: unknown) => notify(error instanceof Error ? error.message : 'That action failed.'),
     /* The version the viewer is LOOKING AT — see `versionOf` on the hook. */
    versionOf: (id) => data.detailOf(id)?.version,
  });
  const rowLifecycle = useRowLifecycle({
    data,
    viewerMemberId,
    onNotice: (notice) => notify(notice.body),
  });
  const membership = useMembershipSurface({
    spaceId: data.spaceId,
    seam: data.seam,
    refetchDetail: (id) => data.refetchDetail(id),
    onNotice: (notice) => notify(notice.body),
  });
  const attachments = useMemo(
    () => attachmentsFor(data.seam, data.spaceId),
    [data.seam, data.spaceId],
  );

  const ctx = useMemo(() => ({ spaceId: data.spaceId }), [data.spaceId]);
  const focusDetail = data.detailOf(entityId);
  const controls = useMemo<ControlHost>(
    () => ({
      kind: focusDetail?.kind ?? '',
      ctx,
      livenessOf: data.livenessOf,
      capabilitiesOf: (id) => data.detailOf(id)?.capabilities,
      onNeedDetail: (id: string) => data.pull?.(id),
      onAction: (ref, id) => primaries.forEntity(id)?.(ref),
      onSetState: rowLifecycle.setState,
      onArchive: rowLifecycle.archive,
      onSetValue: rowLifecycle.setValue,
      onAssign: rowLifecycle.assign,
      assignableActors: rowLifecycle.assignable,
      onMembership: rowLifecycle.membership,
      membershipSets: rowLifecycle.membershipSets,
      connectionsOf: data.connectionsOf,
    }),
    [focusDetail?.kind, ctx, data, primaries, rowLifecycle],
  );

  /* The panel reads `detailOf`; asking for the pull is the host's job, one per
     mounted region — the same from-render hydration Channel and Home use. */
  if (!focusDetail) data.pull?.(entityId);

  const host: AuxPanelHost = {
    data,
    reasons,
    ctx,
    controls,
    primaries,
    membership,
    launchPort,
    rowLifecycle,
    attachments,
    serverBaseUrl,
    viewerMemberId,
  };

  return (
    <AuxEntityPanel host={host} entityId={entityId} onOpenEntity={onOpenEntity} onClose={onClose} />
  );
}
