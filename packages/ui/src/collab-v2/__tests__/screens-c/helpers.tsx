/**
 * W3c screen test helpers — latency-0 seeded facade, store reset, and an RTL
 * wrapper carrying the providers the screens' children need (facade + popover),
 * plus the jsdom shims @xyflow/react wants when a CollectionView offers the
 * graph layout.
 */
import type { ReactNode } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { PopoverProvider } from '../../kit';
import { CollabFacadeProvider } from '../../entity';
import { createSeededWorld, MockFacade, type MockFacadeOptions } from '../../mock';
import type { ShellViewProps } from '../../shell';
import {
  useCollectionsStore, useGraphStore, useNavStore, usePresenceStore,
} from '../../stores';

if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}
if (!('DOMMatrixReadOnly' in globalThis)) {
  class DOMMatrixReadOnlyStub {
    m22 = 1;
    constructor(_transform?: string) {}
  }
  (globalThis as Record<string, unknown>).DOMMatrixReadOnly = DOMMatrixReadOnlyStub;
}

export function createFacade(opts: MockFacadeOptions = {}): MockFacade {
  return new MockFacade(createSeededWorld(), { latency: 0, ...opts });
}

export function resetStores(): void {
  useGraphStore.getState().reset();
  useCollectionsStore.getState().reset();
  usePresenceStore.getState().reset();
  useNavStore.getState().reset();
}

export function renderWith(facade: MockFacade, ui: ReactNode): RenderResult {
  return render(
    <div className="cv2-root">
      <CollabFacadeProvider facade={facade}>
        <PopoverProvider>{ui}</PopoverProvider>
      </CollabFacadeProvider>
    </div>,
  );
}

/** The props every center view receives; overridable per test. */
export function viewProps(facade: MockFacade, over: Partial<ShellViewProps> = {}): ShellViewProps {
  return {
    facade,
    spaceId: facade.ids.space,
    view: 'channel',
    entityId: null,
    onOpenEntity: () => {},
    onNavigate: () => {},
    ...over,
  };
}
