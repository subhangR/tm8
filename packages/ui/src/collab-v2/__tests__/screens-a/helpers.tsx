/**
 * W3a screen-test helpers — latency-0 seeded facade, store reset, an RTL
 * wrapper with the facade + popover providers, and the ShellViewProps a screen
 * receives from the shell.
 */
import type { ReactNode } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { CollabFacadeProvider } from '../../entity';
import { PopoverProvider } from '../../kit';
import { createSeededWorld, MockFacade, type MockFacadeOptions } from '../../mock';
import {
  useCollectionsStore, useGraphStore, useNavStore, usePresenceStore,
} from '../../stores';
import { useToastStore } from '../../subsystems/live';
import type { ShellViewProps } from '../../shell';
import type { ViewName } from '../../stores/nav';

export function createFacade(opts: MockFacadeOptions = {}): MockFacade {
  return new MockFacade(createSeededWorld(), { latency: 0, ...opts });
}

export function resetStores(): void {
  useGraphStore.getState().reset();
  useCollectionsStore.getState().reset();
  usePresenceStore.getState().reset();
  useNavStore.getState().reset();
  useToastStore.getState().clear();
}

export function renderWith(facade: MockFacade, ui: ReactNode): RenderResult {
  return render(
    <CollabFacadeProvider facade={facade}>
      <PopoverProvider>{ui}</PopoverProvider>
    </CollabFacadeProvider>,
  );
}

export interface ViewPropsOverrides {
  view?: ViewName;
  onOpenEntity?: ShellViewProps['onOpenEntity'];
  onNavigate?: ShellViewProps['onNavigate'];
}

/** The exact props the shell hands a center view. */
export function viewProps(
  facade: MockFacade,
  overrides: ViewPropsOverrides = {},
): ShellViewProps {
  return {
    facade,
    spaceId: facade.ids.space,
    view: overrides.view ?? 'home',
    entityId: null,
    onOpenEntity: overrides.onOpenEntity ?? (() => {}),
    onNavigate: overrides.onNavigate ?? (() => {}),
  };
}
