/**
 * CRAFT'S REGION C — the entity detail column, mounted from the SAME shared
 * `AuxEntityPanel` every other three-region screen mounts.
 *
 * NOT A NEW PANEL. `views/auxPanel.tsx` is the app's one detail mount (Home
 * uses it twice; Channel, Entity, Workspace and Graph mount the panel beneath
 * it), and its docblock states the ruling this file obeys: it is a MOUNT, not
 * a layout — the aside, its header and its close affordance stay with the
 * host, and `onOpenEntity` REPLACES this column's subject rather than opening
 * a fourth one. Writing a Craft-specific detail panel would have been the
 * fifth dialect of the same surface.
 *
 * WHY IT IS ITS OWN COMPONENT rather than a branch inside `CraftScreen`.
 * The host bundle is built from six hooks (`useLaunchPort`,
 * `usePanelPrimaries`, `useRowLifecycle`, `useMembershipSurface`,
 * `attachmentsFor`, plus the control host), and every one of them needs
 * `GateData`. `CraftScreen` mounts without `GateData` in both the vitest
 * suite and the pixel harness, and hooks cannot be called conditionally — so
 * the bundle lives behind a component that only mounts when the shell has
 * actually supplied the data. Absent shell data, Craft renders no column at
 * all, which is the honest state rather than an empty aside.
 */
import { useMemo } from 'react';
import type { EntityId } from '@tm8/contract';
import type { ControlHost } from '../panels';
import { attachmentsFor } from '../files/port';
import { AuxEntityPanel, type AuxPanelHost } from '../views/auxPanel';
import { useLaunchPort } from '../views/useLaunchPort';
import { useMembershipSurface } from '../views/membershipSurface';
import { usePanelPrimaries } from '../views/usePanelPrimaries';
import { useRowLifecycle } from '../views/useRowLifecycle';
import type { CraftPanelHostProps } from './types';

export interface CraftEntityColumnProps extends CraftPanelHostProps {
  entityId: EntityId;
  /** Drilling from inside the panel REPLACES the subject (the auxPanel law). */
  onOpenEntity(id: EntityId): void;
  onClose(): void;
}

export function CraftEntityColumn({
  data,
  reasons,
  serverBaseUrl,
  viewerMemberId,
  onNotice,
  entityId,
  onOpenEntity,
  onClose,
}: CraftEntityColumnProps) {
  const notify = (text: string) => onNotice?.(text);

  const launchPort = useLaunchPort(data, {});
  const primaries = usePanelPrimaries({
    seam: data.seam,
    reconcileCommand: data.reconcileCommand,
    onError: (error: unknown) => notify(error instanceof Error ? error.message : 'That action failed.'),
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
