/**
 * W2b test helpers — latency-0 seeded facade, provider wrapper (facade +
 * shared popover engine, exactly as the app mounts them) and a synthetic
 * edge-group builder for the 50-edge grouping rule.
 */
import type { ReactNode } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { CollabFacadeProvider } from '../../entity';
import { PopoverProvider } from '../../kit';
import { createSeededWorld, MockFacade } from '../../mock';
import {
  useCollectionsStore, useGraphStore, useNavStore, usePresenceStore,
} from '../../stores';
import type {
  Connections, EdgeGroup, EdgeView, EntityDetail, EntitySummary,
} from '../../types/contract';

export function createFacade(): MockFacade {
  return new MockFacade(createSeededWorld(), { latency: 0 });
}

export function resetStores(): void {
  useGraphStore.getState().reset();
  useCollectionsStore.getState().reset();
  usePresenceStore.getState().reset();
  useNavStore.getState().reset();
}

export function renderWith(facade: MockFacade, ui: ReactNode): RenderResult {
  return render(
    <CollabFacadeProvider facade={facade}>
      <PopoverProvider>{ui}</PopoverProvider>
    </CollabFacadeProvider>,
  );
}

/** Clone an entity summary under a new id/title (synthetic edge endpoints). */
export function cloneSummary(base: EntitySummary, n: number): EntitySummary {
  return { ...base, id: `${base.id}__clone${n}`, title: `${base.title} #${n}` };
}

/** Blow a group up to `count` edges, cloning a real edge (and its far end). */
export function inflateGroup(group: EdgeGroup, count: number): EdgeGroup {
  const seed = group.edges[0];
  if (!seed) throw new Error('inflateGroup needs at least one real edge to clone');
  const edges: EdgeView[] = [];
  for (let i = 0; i < count; i += 1) {
    const other = cloneSummary(group.direction === 'outgoing' ? seed.target : seed.source, i);
    edges.push({
      ...seed,
      id: `${seed.id}__e${i}`,
      ...(group.direction === 'outgoing' ? { target: other } : { source: other }),
    });
  }
  return { ...group, edges };
}

/** Replace one group in a detail's connections (immutably). */
export function withGroup(detail: EntityDetail, group: EdgeGroup): EntityDetail {
  const swap = (groups: EdgeGroup[]): EdgeGroup[] =>
    groups.map((g) => (g.type === group.type && g.direction === group.direction ? group : g));
  const connections: Connections = {
    ...detail.connections,
    outgoing: swap(detail.connections.outgoing),
    incoming: swap(detail.connections.incoming),
  };
  return { ...detail, connections };
}

export const firstGroup = (detail: EntityDetail): EdgeGroup => {
  const group = detail.connections.outgoing[0] ?? detail.connections.incoming[0];
  if (!group) throw new Error('seed entity has no edges');
  return group;
};
