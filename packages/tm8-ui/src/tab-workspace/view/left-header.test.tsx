// @vitest-environment jsdom
/**
 * The left header's order (Craft redesign §2): space · mode · the mode's own
 * switcher. The slot is mode-aware — GateApp hands it the workspace switcher
 * in Home and the craft switcher in Craft — and is absent when empty.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShellFrameContext, type ShellFrameValue, type WorkspaceGateHandles } from './context';
import { LeftHeader } from './LeftHeader';

function mount(gate: Partial<WorkspaceGateHandles>) {
  const frame = {
    gate: {
      shellTabs: [],
      viewTabs: [{ id: 'workspace-tabs', label: 'Home' }],
      activeViewTabId: 'workspace-tabs',
      onSelectViewTab: vi.fn(),
      openPalette: vi.fn(),
      navigateTo: vi.fn(),
      ...gate,
    } as unknown as WorkspaceGateHandles,
    spaceId: 'space-1',
    currentKind: null,
    currentSource: null,
    selectKind: vi.fn(),
    selectSource: vi.fn(),
    panelWidth: 280,
  } as ShellFrameValue;
  return render(
    <ShellFrameContext.Provider value={frame}>
      <LeftHeader />
    </ShellFrameContext.Provider>,
  );
}

afterEach(cleanup);

describe('the left header', () => {
  it('reads space · mode · switcher, left to right', () => {
    mount({
      switcherSlot: <span data-testid="space-switch">Space</span>,
      modeSwitcherSlot: <span data-testid="mode-switch">Workspace</span>,
    });
    const space = screen.getByTestId('space-switch');
    const mode = screen.getByTestId('tws-view-select');
    const slot = screen.getByTestId('tws-mode-switcher-slot');
    expect(slot.contains(screen.getByTestId('mode-switch'))).toBe(true);
    expect(space.compareDocumentPosition(mode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mode.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws no slot when the mode has no switcher', () => {
    mount({ switcherSlot: <span data-testid="space-switch">Space</span> });
    expect(screen.queryByTestId('tws-mode-switcher-slot')).toBeNull();
  });
});
