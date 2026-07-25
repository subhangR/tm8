/**
 * L1 test helpers: a latency-0 seeded facade, per-kind seed detail loading,
 * and an RTL wrapper that provides the facade + shared popover engine.
 */
import type { ReactNode } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { PopoverProvider } from '../../kit';
import { createSeededWorld, MockFacade } from '../../mock';
import { CollabFacadeProvider } from '../../entity';
import {
  useCollectionsStore, useGraphStore, useNavStore, usePresenceStore,
} from '../../stores';
import type { EntityDetail, EntityKind } from '../../types/contract';
import type { SeedIds } from '../../mock';

export function createFacade(): MockFacade {
  return new MockFacade(createSeededWorld(), { latency: 0 });
}

export function resetStores(): void {
  useGraphStore.getState().reset();
  useCollectionsStore.getState().reset();
  usePresenceStore.getState().reset();
  useNavStore.getState().reset();
}

/** One representative seeded entity per kind (mirrors the gallery). */
export function seedIdForKind(ids: SeedIds): Record<EntityKind, string> {
  return {
    channel: ids.chBuild,
    task: ids.t103,
    message: ids.forgeProgressMessage,
    member: ids.subhang,
    team_member: ids.forge,
    doc: ids.docSpec,
    file: ids.fileWireframes,
    spell: ids.spellReviewer,
    skill: ids.skillGraphify,
    pull_request: ids.pr241,
    commit: ids.commitA1,
  };
}

export const ALL_KINDS: EntityKind[] = [
  'channel', 'task', 'message', 'member', 'team_member',
  'doc', 'file', 'spell', 'skill', 'pull_request', 'commit',
];

export async function loadKindDetails(facade: MockFacade): Promise<Record<EntityKind, EntityDetail>> {
  const byKind = seedIdForKind(facade.ids);
  const out = {} as Record<EntityKind, EntityDetail>;
  for (const kind of ALL_KINDS) {
    out[kind] = await facade.getEntity(byKind[kind]);
  }
  return out;
}

export function renderWith(facade: MockFacade, ui: ReactNode): RenderResult {
  return render(
    <CollabFacadeProvider facade={facade}>
      <PopoverProvider>{ui}</PopoverProvider>
    </CollabFacadeProvider>,
  );
}
