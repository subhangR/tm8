/**
 * W3b screen test helpers — a latency-0 seeded facade, store reset, the
 * provider wrapper the screens expect, and a `ShellViewProps` factory so each
 * screen can be rendered exactly the way `CenterHost` renders it.
 */
import type { ReactNode } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import { PopoverProvider } from '../../kit';
import { createSeededWorld, MockFacade } from '../../mock';
import { CollabFacadeProvider } from '../../entity';
import {
  useCollectionsStore, useGraphStore, useNavStore, usePresenceStore,
} from '../../stores';
import type { ShellViewProps } from '../../shell';
import type { ViewName } from '../../stores/nav';
import type { EntityId } from '../../types/contract';

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

export interface ScreenHarness {
  props: ShellViewProps;
  opened: EntityId[];
  navigated: Array<{ view: ViewName; entityId: EntityId | null }>;
}

/** The props the shell hands a center view, with spies on both callbacks. */
export function screenProps(
  facade: MockFacade,
  overrides: Partial<ShellViewProps> = {},
): ScreenHarness {
  const opened: EntityId[] = [];
  const navigated: Array<{ view: ViewName; entityId: EntityId | null }> = [];
  const props: ShellViewProps = {
    facade,
    spaceId: facade.ids.space,
    view: 'home',
    entityId: null,
    onOpenEntity: vi.fn((id: EntityId) => { opened.push(id); }),
    onNavigate: vi.fn((view: ViewName, entityId: EntityId | null = null) => {
      navigated.push({ view, entityId });
    }),
    ...overrides,
  };
  return { props, opened, navigated };
}
