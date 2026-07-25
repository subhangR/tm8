/**
 * EdgeGroupSection — one edge type, one direction. Label + direction arrow +
 * count, an unresolved-hard rollup on the group, a per-item HARD/SOFT ✓/⚠
 * badge, hover preview (the chip's shared Z2 popover), click-hop (the chip
 * pushes a panel), remove-on-hover, an inline "+", and the 50-edge grouping
 * rule: only the first `GROUP_PREVIEW` items render until "show all".
 *
 * `x:*` types are rendered exactly like registered ones — the rail never
 * special-cases a type.
 */
import { useState } from 'react';
import { EntityChip } from '../../entity';
import { IconBtn } from '../../kit';
import type { EdgeGroup, EdgeView, EntityId, EntitySummary } from '../../types/contract';
import { EdgeComposer, type PickEntity } from './EdgeComposer';
import {
  GROUP_PREVIEW, otherEnd, resolutionBadge, unresolvedCount,
} from './model';

export interface EdgeGroupSectionProps {
  entityId: EntityId;
  group: EdgeGroup;
  canEdit: boolean;
  onOpenEntity?: (id: EntityId) => void;
  onRemove: (edge: EdgeView) => void;
  onAdd: (input: { type: string; otherId: EntityId; direction: EdgeGroup['direction'] }) => void;
  pickEntity?: PickEntity;
  candidates?: EntitySummary[];
  /** Test/story escape hatch: start expanded past the preview cut. */
  defaultExpanded?: boolean;
}

export function EdgeGroupSection({
  entityId, group, canEdit, onOpenEntity, onRemove, onAdd,
  pickEntity, candidates, defaultExpanded = false,
}: EdgeGroupSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [composing, setComposing] = useState(false);

  const total = group.edges.length;
  const unresolved = unresolvedCount(group);
  const visible = expanded ? group.edges : group.edges.slice(0, GROUP_PREVIEW);
  const hidden = total - visible.length;

  return (
    <section
      className="cv2-rail__group"
      data-type={group.type}
      data-direction={group.direction}
      aria-label={`${group.label} (${group.direction})`}
    >
      <header className="cv2-rail__grouphead">
        <span className="cv2-eyebrow">{group.label}</span>
        <span
          className="cv2-rail__dir"
          title={group.direction === 'outgoing' ? 'outgoing — from this entity' : 'incoming — to this entity'}
        >
          {group.direction === 'outgoing' ? '→' : '←'}
        </span>
        <span className="cv2-rail__count">{total}</span>
        {unresolved > 0 && (
          <span className="cv2-rail__warn">⚠ {unresolved} unresolved</span>
        )}
        {canEdit && (
          <IconBtn
            aria-label={`Add ${group.label} link`}
            active={composing}
            onClick={() => setComposing((v) => !v)}
          >
            +
          </IconBtn>
        )}
      </header>

      {composing && (
        <EdgeComposer
          sourceId={entityId}
          initialType={group.type}
          direction={group.direction}
          lockType
          pickEntity={pickEntity}
          candidates={candidates}
          onSubmit={(input) => { setComposing(false); onAdd(input); }}
          onCancel={() => setComposing(false)}
        />
      )}

      <ul className="cv2-rail__items">
        {visible.map((edge) => {
          const other = otherEnd(edge, group.direction);
          const badge = resolutionBadge(edge);
          const note = typeof edge.props.note === 'string' ? edge.props.note : null;
          return (
            <li key={edge.id} className="cv2-rail__item" data-blocking={badge?.blocking || undefined}>
              <EntityChip entity={other} onOpen={onOpenEntity} />
              {badge && (
                <span
                  className={`cv2-rail__res${badge.blocking ? ' cv2-rail__res--open' : ''}`}
                  data-resolved={badge.resolved || undefined}
                  title={badge.blocking
                    ? 'Hard dependency — still unresolved, this entity is blocked'
                    : `${badge.strength.toLowerCase()} dependency · ${badge.resolved ? 'resolved' : 'open'}`}
                >
                  {badge.label}
                </span>
              )}
              {note && <span className="cv2-rail__note" title={note}>{note}</span>}
              {canEdit && (
                <IconBtn
                  aria-label={`Remove ${group.label} link to ${other.title}`}
                  onClick={() => onRemove(edge)}
                >
                  ✕
                </IconBtn>
              )}
            </li>
          );
        })}
      </ul>

      {(hidden > 0 || (expanded && total > GROUP_PREVIEW)) && (
        <button
          type="button"
          className="cv2-rail__showall"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : `Show all ${total}`}
        </button>
      )}
    </section>
  );
}
