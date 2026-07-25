/**
 * L4 test helpers — latency-0 seeded facade, store reset, an RTL wrapper
 * with facade+popover providers, drag-event plumbing, and the jsdom shims
 * @xyflow/react needs (ResizeObserver / DOMMatrixReadOnly).
 */
import type { ReactNode } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { PopoverProvider } from '../../kit';
import { createSeededWorld, MockFacade } from '../../mock';
import { CollabFacadeProvider } from '../../entity';
import {
  useCollectionsStore, useGraphStore, useNavStore, usePresenceStore,
} from '../../stores';
import type { MockFacadeOptions } from '../../mock';

// --- jsdom shims for @xyflow/react -----------------------------------------
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
    <CollabFacadeProvider facade={facade}>
      <PopoverProvider>{ui}</PopoverProvider>
    </CollabFacadeProvider>,
  );
}

/** Minimal DataTransfer stand-in — jsdom has none. */
export interface DataTransferStub {
  setData: (type: string, value: string) => void;
  getData: (type: string) => string;
  types: string[];
  effectAllowed: string;
  dropEffect: string;
}

export function makeDataTransfer(): DataTransferStub {
  const store: Record<string, string> = {};
  return {
    setData: (type, value) => { store[type] = value; },
    getData: (type) => store[type] ?? '',
    get types() { return Object.keys(store); },
    effectAllowed: 'all',
    dropEffect: 'move',
  } as DataTransferStub;
}
