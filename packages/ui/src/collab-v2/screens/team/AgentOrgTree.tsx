/**
 * Agent org-tree — a member's agents, nested by the homogeneous `parentId`
 * hierarchy (a lead agent with its own workers indents underneath it).
 *
 * Every row is the Z2 `EntityCard` — which already carries the agent's model,
 * owner, idle/working pill and live-work task chip from the registry — plus
 * the live layer's `LiveBadges`. The tree contributes indentation and nothing
 * else; it renders no entity markup of its own.
 */
import { EntityCard } from '../../entity';
import { EmptyState } from '../../collections';
import { LiveBadges } from '../../subsystems/live';
import type { CollabFacade } from '../../facade/CollabFacade';
import type { EntityId } from '../../types/contract';
import type { OrgRow } from './model';

export interface AgentOrgTreeProps {
  rows: OrgRow[];
  facade: CollabFacade;
  /** Open an agent's profile (Z4). */
  onOpen: (id: EntityId) => void;
}

const INDENT_PX = 18;

export function AgentOrgTree({ rows, facade, onOpen }: AgentOrgTreeProps) {
  if (rows.length === 0) return <EmptyState kinds={['team_member']} />;

  return (
    <div className="cv2-team__org" role="tree" aria-label="Agent org tree">
      {rows.map(({ entity, depth }) => (
        <div
          key={entity.id}
          className="cv2-team__orgrow"
          role="treeitem"
          aria-level={depth + 1}
          style={{ paddingLeft: depth * INDENT_PX }}
          data-depth={depth}
        >
          {depth > 0 && <span className="cv2-team__orgtick" aria-hidden="true" />}
          <div
            role="button"
            tabIndex={0}
            className="cv2-team__orgcell"
            aria-label={`Open ${entity.title}'s profile`}
            onClick={() => onOpen(entity.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(entity.id); }
            }}
          >
            <EntityCard entity={entity} />
            <LiveBadges entity={entity} facade={facade} workingStyle="pulses" compact />
          </div>
        </div>
      ))}
    </div>
  );
}
