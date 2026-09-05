/**
 * THE BOARD'S ENTITY PANEL — the same `AuxEntityPanel` every other screen
 * mounts, opened OVER the board's last column when a card is pressed.
 *
 * NOT A NEW PANEL, for the reason `views/auxPanel.tsx` states and
 * `craft/CraftEntityColumn.tsx` obeys: there is ONE detail mount in this app,
 * and a board-specific dialect of it would be the sixth. The overlay, its
 * width and its dismissal are the BOARD's (a mount, not a layout); everything
 * inside is the panel every other host shows.
 *
 * WHY ITS OWN COMPONENT rather than a branch inside `BoardV2Screen`. The host
 * bundle is built from four more hooks (`useLaunchPort`, `usePanelPrimaries`,
 * `useMembershipSurface`, `attachmentsFor`), and hooks cannot be called
 * conditionally — so they live behind a component that mounts only while a
 * card is actually open, and cost the board nothing while it is not.
 *
 * THE ROW LIFECYCLE IS PASSED IN, not built here. `BoardV2Screen` already owns
 * one — it is what a drop writes through — and a second executor is the exact
 * failure `auxPanel`'s docblock names: two in-flight sets that disagree about
 * what a write means.
 */
import { useMemo } from 'react';
import type { EntityId } from '@tm8/contract';
import type { ControlHost, DetailReasons } from '../panels';
import { attachmentsFor } from '../files/port';
import { AuxEntityPanel, type AuxPanelHost } from '../views/auxPanel';
import type { GateData } from '../views/useGateData';
import { useLaunchPort } from '../views/useLaunchPort';
import { useMembershipSurface } from '../views/membershipSurface';
import { usePanelPrimaries } from '../views/usePanelPrimaries';
import type { RowLifecycle } from '../views/useRowLifecycle';
import type { Notice } from '../shell/notices';

export interface BoardEntityColumnProps {
  data: GateData & { pull?: (id: string) => void };
  reasons: DetailReasons;
  serverBaseUrl?: string | undefined;
  viewerMemberId?: string | null | undefined;
  onNotice: (notice: Notice) => void;
  /** The board's own executor — see the docblock. */
  rowLifecycle: RowLifecycle;
  entityId: EntityId;
  /** Drilling from inside the panel REPLACES the subject (the auxPanel law). */
  onOpenEntity(id: EntityId): void;
  onClose(): void;
}

export function BoardEntityColumn({
  data,
  reasons,
  serverBaseUrl,
  viewerMemberId,
  onNotice,
  rowLifecycle,
  entityId,
  onOpenEntity,
  onClose,
}: BoardEntityColumnProps) {
  const launchPort = useLaunchPort(data, {});
  const primaries = usePanelPrimaries({
    seam: data.seam,
    reconcileCommand: data.reconcileCommand,
    onError: (_verb, _entityId, error: unknown) =>
      onNotice({
        id: 'b2-panel-action-failed',
        tone: 'error',
        title: 'That action failed',
        body: String((error as { message?: string })?.message ?? error),
        ttlMs: 6_000,
      }),
    /* The version the viewer is LOOKING AT — see `versionOf` on the hook. */
    versionOf: (id) => data.detailOf(id)?.version,
  });
  const membership = useMembershipSurface({
    spaceId: data.spaceId,
    seam: data.seam,
    refetchDetail: (id) => data.refetchDetail(id),
    onNotice,
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
     mounted region — the same from-render hydration Craft, Channel and Home
     use. */
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
