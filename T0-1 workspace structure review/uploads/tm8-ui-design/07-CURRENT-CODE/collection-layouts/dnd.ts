/**
 * Collection drag plumbing — the entity payload rides the same MIME the
 * EntityChip drag uses (`ENTITY_DRAG_MIME`), so chips dragged from anywhere
 * in the app drop onto boards/trees identically to cards dragged locally.
 */
import { ENTITY_DRAG_MIME, type EntityDragPayload } from '../entity';
import type { EntitySummary } from '../types/contract';

export { ENTITY_DRAG_MIME } from '../entity';
export type { EntityDragPayload } from '../entity';

export function setDragPayload(e: React.DragEvent, entity: EntitySummary): void {
  const payload: EntityDragPayload = { entityId: entity.id, kind: entity.kind, title: entity.title };
  e.dataTransfer.setData(ENTITY_DRAG_MIME, JSON.stringify(payload));
  e.dataTransfer.setData('text/plain', entity.title);
  e.dataTransfer.effectAllowed = 'move';
}

export function readDragPayload(e: React.DragEvent): EntityDragPayload | null {
  const raw = e.dataTransfer.getData(ENTITY_DRAG_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as EntityDragPayload;
    return parsed && typeof parsed.entityId === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function hasDragPayload(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(ENTITY_DRAG_MIME);
}
