/**
 * WorkingPulse — the marquee of the live layer: an actor chip that breathes
 * while it holds an active `working_on` edge, hover → "working on {task chip}
 * since {t}". Agents are the common case, but a human pulling work pulses the
 * same way; the shape of the avatar carries the provenance, not the color.
 */
import { Avatar, Timestamp, usePopover } from '../../kit';
import { EntityChip } from '../../entity/EntityChip';
import { relTime } from '../../registry';
import type { LiveWork } from '../../types/contract';

export interface WorkingPulseProps {
  work: LiveWork;
  /** Hide the actor name (dense rows, avatar stacks). */
  compact?: boolean;
  size?: number;
}

export function WorkingDetail({ work }: { work: LiveWork }) {
  return (
    <div className="cv2-workdetail">
      <div className="cv2-workdetail__head">
        <Avatar actor={work.actor} size={22} />
        <span className="cv2-workdetail__name">{work.actor.displayName}</span>
        <Timestamp className="cv2-workdetail__since" at={work.startedAt} prefix="since" />
      </div>
      <div className="cv2-workdetail__body">
        <span className="cv2-workdetail__verb">working on</span>
        <EntityChip entity={work.task} interactive={false} draggable={false} />
      </div>
      {work.note && <div className="cv2-workdetail__note">{work.note}</div>}
    </div>
  );
}

export function WorkingPulse({ work, compact = false, size = 20 }: WorkingPulseProps) {
  const popover = usePopover();
  const label = `${work.actor.displayName} working on ${work.task.title} since ${relTime(work.startedAt)}`;

  return (
    <span
      className="cv2-workpulse"
      data-testid="working-pulse"
      data-actor={work.actor.id}
      title={label}
      aria-label={label}
      onMouseEnter={(e) => popover.open(e.currentTarget, <WorkingDetail work={work} />)}
      onMouseLeave={() => popover.cancel()}
    >
      <span className="cv2-workpulse__avatar">
        <Avatar actor={work.actor} size={size} />
        <span className="cv2-workpulse__dot" aria-hidden="true" />
      </span>
      {!compact && <span className="cv2-workpulse__name">{work.actor.displayName}</span>}
    </span>
  );
}
