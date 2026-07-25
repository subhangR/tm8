/**
 * WorkingAggregate — the list-level rollup: "🤖 2 working" on a channel row or
 * a task family, hovering to the individual WorkingPulse detail. Counts agents
 * and humans separately so a channel where two agents grind reads differently
 * from one where two people do.
 */
import { Pill, usePopover } from '../../kit';
import type { EntitySummary, LiveWork } from '../../types/contract';
import { WorkingDetail } from './WorkingPulse';
import { useLiveEntity, useWorkingActors } from './useLive';

export interface WorkingAggregateProps {
  /** Live-tracked entity; its `badges.workingActors` drive the count. */
  entity?: EntitySummary;
  /** Explicit rows (collections that already computed them). */
  works?: LiveWork[];
  /** Force a count when only the number is known (channel state rollups). */
  count?: number;
  label?: string;
}

function summarize(works: LiveWork[]): string {
  const agents = works.filter((w) => w.actor.isAgent).length;
  const humans = works.length - agents;
  const parts: string[] = [];
  if (agents > 0) parts.push(`${agents} agent${agents === 1 ? '' : 's'}`);
  if (humans > 0) parts.push(`${humans} human${humans === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export function WorkingAggregate({ entity, works, count, label }: WorkingAggregateProps) {
  const popover = usePopover();
  const fromEntity = useWorkingActors(entity ?? EMPTY_ENTITY);
  const rows = works ?? (entity ? fromEntity : []);
  const total = count ?? rows.length;
  if (total === 0) return null;

  const anyAgent = rows.length === 0 || rows.some((w) => w.actor.isAgent);
  const text = label ?? `${anyAgent ? '🤖 ' : ''}${total} working`;
  const detail = rows.length > 0 ? summarize(rows) : `${total} working`;

  return (
    <span
      className="cv2-workagg"
      data-testid="working-aggregate"
      onMouseEnter={(e) => {
        if (rows.length === 0) return;
        popover.open(e.currentTarget, (
          <div className="cv2-workagg__pop">
            {rows.map((w) => <WorkingDetail key={`${w.actor.id}-${w.task.id}`} work={w} />)}
          </div>
        ));
      }}
      onMouseLeave={() => popover.cancel()}
    >
      <Pill tone="working" pulse title={detail}>{text}</Pill>
    </span>
  );
}

/** Sentinel so the hook order stays stable when no entity is supplied. */
const EMPTY_ENTITY: EntitySummary = {
  id: '', spaceId: '', kind: 'task', title: '', parentId: null, position: 0,
  visibility: 'space', version: 0, activityAt: '', createdAt: '', updatedAt: '',
  deletedAt: null,
  createdBy: { id: '', kind: 'member', displayName: '', isAgent: false },
  counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
  state: {
    kind: 'task', workStatus: 'open', priority: 'low', axes: {}, assignees: [],
    acceptance: { total: 0, completed: 0 },
  },
  badges: {},
};
