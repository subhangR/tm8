/**
 * EntityChip (Z1) — the inline token every kind renders as. Icon + name +
 * state tint. Hover → Z2 popover through the SHARED popover engine (delay /
 * cancel handled there); click → push a Z3 panel; drag → carries the entity
 * ref payload (drop targets wire up in W4). `variant="ref"` is the quieter
 * inline mention/reference style for running text.
 */
import { isTombstoned, registryFor } from '../registry';
import { usePopover } from '../kit';
import { useNavStore } from '../stores';
import type { EntityId, EntityKind, EntitySummary } from '../types/contract';
import { EntityCard } from './EntityCard';
import { Tombstone } from './Tombstone';

/** MIME type of the drag payload (drop grammar targets read this in W4). */
export const ENTITY_DRAG_MIME = 'application/x-cv2-entity';

export interface EntityDragPayload {
  entityId: EntityId;
  kind: EntityKind;
  title: string;
}

export interface EntityChipProps {
  entity: EntitySummary;
  /** 'chip' = pill token · 'ref' = quieter inline mention/reference. */
  variant?: 'chip' | 'ref';
  /** Hover popover + click-to-open (default true). */
  interactive?: boolean;
  draggable?: boolean;
  /** Override the click action (default: push a Z3 panel via the nav store). */
  onOpen?: (id: EntityId) => void;
}

export function EntityChip({
  entity, variant = 'chip', interactive = true, draggable = true, onOpen,
}: EntityChipProps) {
  const popover = usePopover();

  if (isTombstoned(entity)) return <Tombstone entity={entity} variant="chip" />;

  const entry = registryFor(entity.kind);
  const tint = entry.tint(entity);
  const label = entry.chipLabel(entity);
  const meta = entry.chipMeta(entity);
  const pulse = entry.chipPulse(entity);

  const open = (): void => {
    popover.close();
    if (onOpen) onOpen(entity.id);
    else useNavStore.getState().pushPanel({ entityId: entity.id });
  };

  return (
    <button
      type="button"
      className={`cv2-chip cv2-chip--${variant}`}
      data-kind={entity.kind}
      title={`${entry.label} · ${entity.title}`}
      draggable={draggable}
      onMouseEnter={(e) => {
        if (interactive) popover.open(e.currentTarget, <EntityCard entity={entity} inPopover />);
      }}
      onMouseLeave={() => { if (interactive) popover.cancel(); }}
      onClick={() => { if (interactive) open(); }}
      onDragStart={(e) => {
        popover.close();
        const payload: EntityDragPayload = { entityId: entity.id, kind: entity.kind, title: entity.title };
        e.dataTransfer.setData(ENTITY_DRAG_MIME, JSON.stringify(payload));
        e.dataTransfer.setData('text/plain', label);
        e.dataTransfer.effectAllowed = 'copyMove';
      }}
    >
      <span className="cv2-chip__glyph" style={{ color: tint }} aria-hidden="true">{entry.glyph}</span>
      <span className="cv2-chip__label">{label}</span>
      {meta && <span className="cv2-chip__meta">{meta}</span>}
      {pulse && <span className="cv2-chip__pulse" style={{ background: tint }} aria-hidden="true" />}
    </button>
  );
}
