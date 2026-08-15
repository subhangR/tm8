/**
 * The AUX PANEL — one entity, opened BESIDE the thing that referenced it.
 *
 * This is the mount `EntityView`'s third column has always used, lifted out of
 * that screen so a second host can render the same panel without re-deriving
 * eleven props from memory. It is a MOUNT, not a layout: the aside, its header
 * and its close affordance stay with the host, because the chrome differs per
 * screen while the panel inside it must not.
 *
 * WHY A HOST BUNDLE RATHER THAN HOOKS IN HERE. Every port below
 * (`primaries`, `membership`, `launchPort`, `rowLifecycle`, `attachments`,
 * `controls`) is already built ONCE per screen and shared with that screen's
 * other panel mounts. Calling the hooks inside this component would give the
 * aux column a SECOND executor — a second in-flight set, a second attachment
 * port, a second launch source read — and two executors that disagree about
 * what a write means is the exact failure `controlHost`'s docblock in
 * `EntityView` exists to prevent. So the host hands its own ports down.
 *
 * `onOpenEntity` REPLACES the subject; it never opens a fourth column. That is
 * EntityView's ruling and it travels with the mount: drilling from an aux panel
 * is reading sideways, not growing the screen. The same callback drives the
 * task-git and graph surfaces, so every route out of this panel lands in the
 * same place.
 */
import type { EntityId } from '@tm8/contract';
import {
  EntityDetailPanel,
  type ControlHost,
  type DetailReasons,
  type PanelHost,
} from '../panels';
import type { ActionContext } from '../domain/types';
import type { AttachmentsPort } from '../files/port';
import type { GateData } from './useGateData';
import type { LaunchPort } from './useLaunchPort';
import type { MembershipSurface } from './membershipSurface';
import type { PanelPrimaries } from './usePanelPrimaries';
import type { RowLifecycle } from './useRowLifecycle';
import { mergePrPortFor } from './mergePrPort';
import { debugSurfaceFor } from './debugSurface';
import { gitSurfaceFor } from './gitSurface';
import { taskGitSectionFor } from './taskGitSection';
import { graphSurfaceFor } from './graphSurface';

/**
 * The ports a host must already own to mount this panel. Every member is
 * something the screen built for its OTHER panels too — nothing here exists
 * only for the aux column.
 */
export interface AuxPanelHost {
  data: GateData & { pull?: (id: string) => void };
  reasons: DetailReasons;
  ctx: ActionContext;
  controls: ControlHost;
  primaries: PanelPrimaries;
  membership: MembershipSurface;
  launchPort: LaunchPort;
  rowLifecycle: RowLifecycle;
  attachments: AttachmentsPort | undefined;
  serverBaseUrl?: string | undefined;
  viewerMemberId?: string | null | undefined;
}

export interface AuxEntityPanelProps {
  host: AuxPanelHost;
  /** The entity this column is showing. */
  entityId: EntityId;
  /** Drilling sideways: REPLACE this column's subject. */
  onOpenEntity(id: EntityId): void;
  /** Dismiss the column entirely. The host owns whatever state that clears. */
  onClose(): void;
  /**
   * WHICH HOST IS RENDERING IT — width and chrome, never anatomy (§2.3).
   *
   * The aux column is `'stack'` and stays the default, so every existing
   * caller is untouched. Z4 passes `'z4'`, which is the whole reason this
   * mount was lifted out of `EntityView`: the full view must be the SAME
   * panel, not a second assembly of it that drifts.
   */
  panelHost?: PanelHost;
}

export function AuxEntityPanel({
  host,
  entityId,
  onOpenEntity,
  onClose,
  panelHost = 'stack',
}: AuxEntityPanelProps) {
  const { data, attachments } = host;
  const detail = data.detailOf(entityId) ?? null;
  return (
    <EntityDetailPanel
      detail={detail}
      serverBaseUrl={host.serverBaseUrl}
      loading={!detail}
      host={panelHost}
      reasons={host.reasons}
      ctx={{ ...host.ctx, entityId }}
      controls={host.controls}
      onAction={host.primaries.forEntity(entityId)}
      wiredActions={host.primaries.wiredActions}
      membershipAuthoring={host.membership.authoringFor(detail)}
      launch={host.launchPort}
      mergePr={mergePrPortFor(data.seam)}
      onRestore={() => host.rowLifecycle.archive('restore', entityId)}
      pinned={false}
      pinRefusal="Pinning lives in the Workspace"
      liveness={data.livenessOf(entityId)}
      debugSurface={debugSurfaceFor(data.seam, entityId, data.livenessOf)}
      gitSurface={gitSurfaceFor(data.seam, entityId, data.livenessOf)}
      taskGitSection={taskGitSectionFor(data.seam, detail, (id) => onOpenEntity(id as EntityId))}
      graphSurface={graphSurfaceFor(data.seam, entityId, data.livenessOf, (id) =>
        onOpenEntity(id as EntityId),
      )}
      livenessOf={data.livenessOf}
      attachments={attachments}
      onAttachmentUploaded={() => data.refetchDetail(entityId)}
      viewerMemberId={host.viewerMemberId}
      messages={data.messagesOf(entityId)}
      connections={data.connectionsOf(entityId)}
      linkedPullRequests={data.linkedPullRequestsOf?.(entityId) ?? []}
      linkedPullRequestsOf={data.linkedPullRequestsOf}
      commands={data.seam.commands}
      onSaved={data.reconcileCommand}
      onOpenEntity={(id) => onOpenEntity(id as EntityId)}
      onClose={onClose}
    />
  );
}
