/**
 * Interaction-test rig: deterministic seeded facade (latency 0, manual
 * clock), provider wrapper (facade + dnd), store reset, and a dataTransfer
 * stub for native HTML5 drag events in jsdom.
 */
import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { CollabFacadeProvider, ENTITY_DRAG_MIME } from '../../entity';
import { CollabDndProvider } from '../../interactions';
import { useCreationStore } from '../../interactions/create';
import { useInteractionMenuStore } from '../../interactions/keyboard';
import { useDndStore } from '../../interactions/dnd';
import { useUndoStore } from '../../interactions/undo';
import { createSeededWorld, MockFacade } from '../../mock';
import {
  useCollectionsStore, useGraphStore, useNavStore, usePresenceStore,
} from '../../stores';
import { useToastStore } from '../../subsystems/live';
import type { EntitySummary } from '../../types/contract';
import { ManualClock } from '../foundation/helpers';

export { ManualClock };

export interface InteractionRig {
  facade: MockFacade;
  clock: ManualClock;
  ids: MockFacade['ids'];
  now: () => number;
}

export function createRig(): InteractionRig {
  const clock = new ManualClock();
  const facade = new MockFacade(createSeededWorld(clock.now), { latency: 0 });
  return { facade, clock, ids: facade.ids, now: clock.now };
}

export function resetStores(): void {
  useGraphStore.getState().reset();
  useCollectionsStore.getState().reset();
  usePresenceStore.getState().reset();
  useNavStore.getState().reset();
  useToastStore.getState().clear();
  useUndoStore.getState().clear();
  useDndStore.getState().endDrag();
  useDndStore.getState().closeMenu();
  useCreationStore.getState().close();
  useInteractionMenuStore.getState().close();
}

export function renderWithProviders(rig: InteractionRig, ui: ReactNode): RenderResult {
  return render(
    <CollabFacadeProvider facade={rig.facade}>
      <CollabDndProvider now={rig.now}>{ui}</CollabDndProvider>
    </CollabFacadeProvider>,
  );
}

/** Summary via the facade (throws on unknown id) — details ARE summaries. */
export async function summaryOf(rig: InteractionRig, id: string): Promise<EntitySummary> {
  return rig.facade.getEntity(id);
}

/** Seed the graph store's known-entity cache (keyboard menus read it). */
export async function ingest(rig: InteractionRig, ...ids: string[]): Promise<EntitySummary[]> {
  const summaries = await Promise.all(ids.map((id) => rig.facade.getEntity(id)));
  useGraphStore.getState().ingestSummaries(summaries);
  return summaries;
}

/**
 * Minimal DataTransfer stand-in for jsdom drag events. Mirrors the pieces
 * the runtime reads: typed setData/getData, `types`, `dropEffect`.
 */
export function makeDataTransfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    setData: (type: string, value: string) => { data.set(type, value); },
    getData: (type: string) => data.get(type) ?? '',
    clearData: () => data.clear(),
    get types() { return Array.from(data.keys()); },
    dropEffect: 'none',
    effectAllowed: 'all',
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    setDragImage: () => {},
  } as unknown as DataTransfer;
}

/** A DataTransfer already carrying an entity payload. */
export function dragPayloadFor(entity: EntitySummary): DataTransfer {
  const dt = makeDataTransfer();
  dt.setData(ENTITY_DRAG_MIME, JSON.stringify({
    entityId: entity.id, kind: entity.kind, title: entity.title,
  }));
  return dt;
}

/** Toast messages currently on screen (assert helpers). */
export function toastMessages(): string[] {
  return useToastStore.getState().toasts.map((t) => t.message);
}
