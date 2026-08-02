/**
 * Custom xyflow node types:
 *  - cv2Entity: a Z2 EntityCard with kind-shaped accent, connect handles,
 *    blocked ring, dim state, and the collapse chip when it fronts a
 *    collapsed cluster;
 *  - cv2Cluster: the dashed containment box — hierarchy as containment,
 *    visually distinct from drawn edge lines.
 */
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { EntityCard } from '../../entity';
import type { EntitySummary } from '../../types/contract';

export interface EntityNodeData extends Record<string, unknown> {
  entity: EntitySummary;
  collapsed?: boolean;
  hiddenCount?: number;
  clusterParent?: boolean;
  onBlockedPath?: boolean;
  dimmed?: boolean;
  onToggleCollapse?: (id: string) => void;
}

export function EntityNode({ id, data }: NodeProps) {
  const d = data as EntityNodeData;
  const cls = [
    'cv2-gnode',
    `cv2-gnode--${d.entity.kind}`,
    d.onBlockedPath ? 'cv2-gnode--blocked' : '',
    d.dimmed ? 'cv2-gnode--dimmed' : '',
  ].filter(Boolean).join(' ');
  return (
    <div className={cls} data-kind={d.entity.kind} data-blocked={d.onBlockedPath ? 'true' : undefined}>
      <Handle type="target" position={Position.Left} className="cv2-gnode__handle" />
      <EntityCard entity={d.entity} />
      {d.collapsed && (
        <button
          type="button"
          className="cv2-gnode__collapse"
          onClick={(e) => { e.stopPropagation(); d.onToggleCollapse?.(id); }}
          aria-label={`expand ${d.entity.title}`}
        >
          ⊞ {d.hiddenCount ?? ''}
        </button>
      )}
      <Handle type="source" position={Position.Right} className="cv2-gnode__handle" />
    </div>
  );
}

export interface ClusterNodeData extends Record<string, unknown> {
  label: string;
  dimmed?: boolean;
  onToggleCollapse?: (parentEntityId: string) => void;
}

export function ClusterNode({ id, data }: NodeProps) {
  const d = data as ClusterNodeData;
  const parentEntityId = id.replace(/^cluster:/, '');
  return (
    <div className={`cv2-gcluster${d.dimmed ? ' cv2-gcluster--dimmed' : ''}`}>
      <div className="cv2-gcluster__bar">
        <span className="cv2-gcluster__label">{d.label}</span>
        <button
          type="button"
          className="cv2-gcluster__toggle"
          onClick={(e) => { e.stopPropagation(); d.onToggleCollapse?.(parentEntityId); }}
          aria-label={`collapse ${d.label}`}
        >
          ⊟
        </button>
      </div>
    </div>
  );
}

export const NODE_TYPES = { cv2Entity: EntityNode, cv2Cluster: ClusterNode };
