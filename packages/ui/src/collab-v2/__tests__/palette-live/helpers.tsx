/**
 * L2.4/2.5 test helpers — latency-0 facade, clean stores, and keyboard-only
 * driving primitives. Every palette assertion in this folder goes through
 * `press()` / `typeInto()`: if a flow can't be finished with these, it is a
 * parity defect, not a test-harness problem.
 */
import type { ReactElement, ReactNode } from 'react';
import { act, fireEvent, render, screen, type RenderResult } from '@testing-library/react';
import { CollabFacadeProvider } from '../../entity/context';
import { PopoverProvider } from '../../kit';
import { createSeededFacade, type MockFacade } from '../../mock';
import {
  useCollectionsStore, useGraphStore, useNavStore, usePresenceStore,
} from '../../stores';
import { usePaletteStore } from '../../subsystems/palette';
import { useToastStore } from '../../subsystems/live';

export function createFacade(): MockFacade {
  return createSeededFacade({ latency: 0 });
}

export function resetAll(): void {
  useGraphStore.getState().reset();
  useCollectionsStore.getState().reset();
  usePresenceStore.getState().reset();
  useNavStore.getState().reset();
  usePaletteStore.getState().reset();
  useToastStore.getState().clear();
}

export function withProviders(facade: MockFacade, ui: ReactNode): ReactElement {
  return (
    <CollabFacadeProvider facade={facade}>
      <PopoverProvider>{ui}</PopoverProvider>
    </CollabFacadeProvider>
  );
}

export function renderWith(facade: MockFacade, ui: ReactNode): RenderResult {
  return render(withProviders(facade, ui));
}

/**
 * Populate the graph store the way a real screen would — the palette's entity
 * rows are "recent & known", never a search result.
 */
export async function seedKnown(facade: MockFacade, limit = 40): Promise<void> {
  const result = await facade.queryCollection({ spaceId: facade.ids.space, limit });
  await act(async () => {
    useGraphStore.getState().ingestSummaries(result.page.items);
  });
}

// --- keyboard-only driving -----------------------------------------------------

export function press(el: Element | Window, key: string, opts: Record<string, unknown> = {}): void {
  fireEvent.keyDown(el as Element, { key, ...opts });
}

/** Models typing: the input's value changes, nothing else. */
export function typeInto(input: HTMLElement, value: string): void {
  fireEvent.change(input, { target: { value } });
}

export function paletteInput(): HTMLInputElement {
  return screen.getByTestId('palette-input') as HTMLInputElement;
}

export function selectedRow(): HTMLElement | null {
  return document.querySelector('.cv2-palette__row[data-selected]');
}

export function rowLabels(): string[] {
  return [...document.querySelectorAll('.cv2-palette__row')]
    .map((r) => r.querySelector('.cv2-palette__label')?.textContent ?? '');
}

/** ArrowDown until the selected row's label matches, then Enter. Keyboard only. */
export function selectAndActivate(match: (label: string) => boolean, maxSteps = 60): string {
  const input = paletteInput();
  for (let i = 0; i < maxSteps; i += 1) {
    const label = selectedRow()?.querySelector('.cv2-palette__label')?.textContent ?? '';
    if (label && match(label)) {
      press(input, 'Enter');
      return label;
    }
    press(input, 'ArrowDown');
  }
  throw new Error(`no row matched after ${maxSteps} ArrowDown presses; saw: ${rowLabels().join(' | ')}`);
}
