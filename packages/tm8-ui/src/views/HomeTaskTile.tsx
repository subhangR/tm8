/**
 * HomeTaskTile — the WORKSPACE task tile, mounted on Home's Tasks tab.
 *
 * User ruling (2026-08-16, follow-up on task 01a006f8): the Home tab's task
 * rows must be the SAME component the workspace list draws — status glyph +
 * word, assignee/creator avatars, badge sub-row, hover-revealed actions, and
 * the expand whose `EntityControlStrip` lets the user CHANGE the status
 * (state / priority / assign / archive — the D67 strip). "Reuse that
 * component"; the Home coat is CSS only (chat-home.css scopes a compact
 * skin under `.tch-thread-list`), never a second copy of the anatomy.
 *
 * WHAT IS DELIBERATELY FLAT HERE: Home's column is not a tree, so depth is 0
 * and the child toggle never renders — subtasks live in the workspace list.
 * Run goes STRAIGHT to the launch sheet (`onOpenLaunch` outranks the inline
 * quick config, the same ruling the kind screens follow).
 */
import { useRef, useState, type ReactNode } from 'react';
import type { EntitySummary } from '@tm8/contract';
import type { KindConfig } from '../domain';
import { MaestroTaskTile } from '../panels/list/MaestroTaskTile';
import {
  EntityControlStrip,
  RowAction,
  type ControlHost,
} from '../panels/controls/EntityControls';
import { renderBadge } from '../panels/list/tile-badges';

export function HomeTaskTile({
  row,
  config,
  controls,
  selected,
  streaming,
  badges,
  onSelect,
  onOpenLaunch,
}: {
  row: EntitySummary;
  config: KindConfig;
  /** The screen's ONE control host — the same executor set B and C use. */
  controls: ControlHost;
  selected: boolean;
  streaming: boolean;
  /** The host-composed badge sub-row (PR chips + counts), passed through. */
  badges?: ReactNode;
  onSelect(): void;
  /** Run's target: the GateApp launch-sheet singleton. */
  onOpenLaunch?: ((id: string) => void) | undefined;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);

  /* The same registry projection the workspace tile reads — one status
     vocabulary, no re-derivation. */
  const statusSlot = renderBadge('workStatus', row);
  const status = statusSlot?.slot === 'status' ? statusSlot : null;

  const state = row.state as unknown as Record<string, unknown>;
  const rawAssignees = Array.isArray(state.assignees) ? state.assignees : [];
  const assignees = rawAssignees.filter(
    (value): value is EntitySummary['createdBy'] =>
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { id?: unknown }).id === 'string' &&
      typeof (value as { displayName?: unknown }).displayName === 'string',
  );

  return (
    <MaestroTaskTile
      rootRef={rootRef}
      id={row.id}
      title={row.title}
      depth={0}
      selected={selected}
      attention={row.badges.attention != null}
      {...(row.badges.attention?.latestReason
        ? { attentionReason: row.badges.attention.latestReason }
        : {})}
      completed={row.deletedAt != null || status?.word === 'done'}
      childCount={0}
      childrenExpanded={false}
      onSelect={onSelect}
      status={{
        label: status?.word ?? 'no status',
        tone: status?.tone ?? 'idle',
        hollow: status?.dot === 'hollow',
        streaming,
      }}
      assignees={assignees}
      creator={row.createdBy ?? null}
      badges={badges}
      actions={(config.list.rowActions ?? []).map((ref) => (
        <RowAction
          key={ref}
          ref_={ref}
          row={row}
          props={controls}
          onOpenLaunch={onOpenLaunch}
        />
      ))}
      detailsExpanded={expanded}
      flowOpen={false}
      onToggleDetails={() => setExpanded((open) => !open)}
    >
      {/* D67: the ONE state/priority/assign/archive strip — the controls the
          user changes a status with, identical to the workspace expand. */}
      <EntityControlStrip row={row} props={controls} config={config} variant="chips" />
    </MaestroTaskTile>
  );
}
