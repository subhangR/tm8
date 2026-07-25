/**
 * L2.4 gate — the palette opens, navigates, steps and closes with the
 * KEYBOARD ALONE, wired through the real shell (⌘K → nav.paletteOpen →
 * ShellLayout.palette). Mouse paths exist too, but nothing here uses one.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { ShellLayout } from '../../shell/ShellLayout';
import { createMemoryTarget } from '../../shell/router';
import { useNavStore } from '../../stores/nav';
import { CommandPalette, openPaletteWith, startRecentsTracker, usePaletteStore } from '../../subsystems/palette';
import type { MockFacade } from '../../mock';
import {
  createFacade, paletteInput, press, renderWith, resetAll, rowLabels,
  seedKnown, selectAndActivate, selectedRow, typeInto,
} from './helpers';

const nav = () => useNavStore.getState();

let facade: MockFacade;

beforeEach(() => {
  resetAll();
  facade = createFacade();
});

function mountShell() {
  const target = createMemoryTarget(`#/s/${encodeURIComponent(facade.ids.space)}/home`);
  renderWith(facade, (
    <ShellLayout facade={facade} routerTarget={target} palette={<CommandPalette />} />
  ));
  return target;
}

describe('⌘K wiring through the shell', () => {
  it('opens on ⌘K, closes on Escape, reopens on Ctrl-K', async () => {
    mountShell();
    await waitFor(() => expect(nav().spaceId).toBe(facade.ids.space));

    press(window, 'k', { metaKey: true });
    const palette = await screen.findByTestId('command-palette');
    expect(palette.getAttribute('role')).toBe('dialog');

    press(paletteInput(), 'Escape');
    await waitFor(() => expect(screen.queryByTestId('command-palette')).toBeNull());

    press(window, 'k', { ctrlKey: true });
    await screen.findByTestId('command-palette');
  });

  it('opens even while typing in a text field (⌘K is global)', async () => {
    mountShell();
    await waitFor(() => expect(nav().spaceId).toBe(facade.ids.space));

    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    press(field, 'k', { metaKey: true });

    await screen.findByTestId('command-palette');
  });
});

describe('keyboard navigation of the list', () => {
  beforeEach(async () => {
    await act(async () => { nav().setSpace(facade.ids.space); });
    await seedKnown(facade);
    renderWith(facade, <CommandPalette facade={facade} />);
    await act(async () => { openPaletteWith(null); });
    await screen.findByTestId('command-palette');
  });

  it('arrow keys move the active option and expose it via aria-activedescendant', async () => {
    const input = paletteInput();
    await waitFor(() => expect(rowLabels().length).toBeGreaterThan(3));

    const first = input.getAttribute('aria-activedescendant');
    expect(first).toBe('cv2-palette-option-0');

    press(input, 'ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe('cv2-palette-option-1');
    expect(selectedRow()?.getAttribute('aria-selected')).toBe('true');

    press(input, 'End');
    const lastIndex = rowLabels().length - 1;
    expect(input.getAttribute('aria-activedescendant')).toBe(`cv2-palette-option-${lastIndex}`);

    press(input, 'Home');
    expect(input.getAttribute('aria-activedescendant')).toBe('cv2-palette-option-0');
  });

  it('typing filters rows locally and Enter opens the highlighted entity as a panel', async () => {
    const input = paletteInput();
    await waitFor(() => expect(rowLabels().length).toBeGreaterThan(3));

    typeInto(input, 'entity panel');
    await waitFor(() => expect(rowLabels().length).toBeGreaterThan(0));

    const label = selectAndActivate((l) => l.toLowerCase().includes('entity'));
    expect(label.length).toBeGreaterThan(0);

    await waitFor(() => expect(nav().stack.length).toBe(1));
    expect(nav().paletteOpen).toBe(false);
  });

  it('renders the deferred-search slot instead of a search implementation', async () => {
    await waitFor(() => expect(screen.getByTestId('palette-search-slot')).toBeTruthy());
    expect(screen.getByTestId('palette-search-slot').textContent).toMatch(/search/i);
  });

  it('kind filters are real focusable controls (tab-reachable parity)', async () => {
    const filters = screen.getAllByRole('checkbox');
    expect(filters.length).toBeGreaterThan(5);
    for (const f of filters) {
      expect(f.tagName).toBe('BUTTON');
      expect(f.getAttribute('tabindex')).not.toBe('-1');
    }
  });

  it('`kind:` tokens filter entity rows without any pointer input', async () => {
    const input = paletteInput();
    await waitFor(() => expect(rowLabels().length).toBeGreaterThan(3));

    typeInto(input, 'kind:doc ');
    await waitFor(() => {
      const chips = [...document.querySelectorAll('.cv2-palette__row .cv2-chip')];
      expect(chips.length).toBeGreaterThan(0);
      for (const chip of chips) expect(chip.getAttribute('data-kind')).toBe('doc');
    });
  });
});

describe('multi-step flows are enterable and exitable by keyboard', () => {
  beforeEach(async () => {
    await act(async () => { nav().setSpace(facade.ids.space); });
    await seedKnown(facade);
    renderWith(facade, <CommandPalette facade={facade} />);
    await act(async () => { openPaletteWith(null); });
    await screen.findByTestId('command-palette');
  });

  it('Enter descends into a step and Backspace/Escape climb back out', async () => {
    const input = paletteInput();
    await waitFor(() => expect(rowLabels().length).toBeGreaterThan(3));

    typeInto(input, 'go to…');
    selectAndActivate((l) => l.toLowerCase().startsWith('go to'));
    await screen.findByTestId('palette-step');

    press(input, 'Backspace'); // query was reset by the step, so this pops
    await waitFor(() => expect(screen.queryByTestId('palette-step')).toBeNull());

    typeInto(input, 'go to…');
    selectAndActivate((l) => l.toLowerCase().startsWith('go to'));
    await screen.findByTestId('palette-step');

    press(input, 'Escape'); // Escape inside a step goes back, not away
    await waitFor(() => expect(screen.queryByTestId('palette-step')).toBeNull());
    expect(nav().paletteOpen).toBe(true);
  });
});

describe('recents tracking', () => {
  it('records every panel the viewer opens, newest first', async () => {
    await act(async () => { nav().setSpace(facade.ids.space); });
    const stop = startRecentsTracker();
    act(() => {
      nav().pushPanel({ entityId: facade.ids.t103 });
      nav().pushPanel({ entityId: facade.ids.docSpec });
    });
    expect(usePaletteStore.getState().ids.slice(0, 2)).toEqual([facade.ids.docSpec, facade.ids.t103]);
    stop();
  });
});
