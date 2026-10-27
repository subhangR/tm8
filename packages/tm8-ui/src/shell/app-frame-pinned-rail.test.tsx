// @vitest-environment jsdom
/**
 * OBSERVE IN THE PINNED-RAIL SHELL (`tm8.ui.navigator = 'rail'`, task
 * 01a14a17-35ca): no left header, the panel headed by Work's PanelTop, the
 * panel collapsing on the rail store, and the flag off drawing the frame as
 * before. jsdom has no layout: the full-height grid is asserted as the data
 * attributes the CSS keys on, the pixels in the browser screenshots.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceGateHandles } from '../tab-workspace/view/context';
import { NAVIGATOR_STORAGE_KEY } from '../tab-workspace/view/navigatorFlag';
import { getRailStore, resetRailStores } from '../tab-workspace/runtime/railStore';
import { AppFrame } from './AppFrame';

const SPACE = 'space-app-frame-rail-test';

function mount(mode: string | undefined) {
  const gate = {
    shellTabs: [],
    viewTabs: [],
    openPalette: vi.fn(),
    onSelectViewTab: vi.fn(),
    navigateTo: vi.fn(),
    navigateView: vi.fn(),
    accountSlot: undefined,
    switcherSlot: <span data-testid="switcher">space</span>,
    activeViewTabId: null,
  } as unknown as WorkspaceGateHandles;
  render(
    <AppFrame gate={gate} spaceId={SPACE} viewerId="viewer-1" title="Observe" panel="host" strip {...(mode ? { pinnedMode: mode } : {})} goToWork={vi.fn()}>
      <div>graph</div>
    </AppFrame>,
  );
  return { gate };
}

beforeEach(() => {
  vi.stubEnv('VITE_TM8_UI_NAVIGATOR', '');
  window.localStorage.clear();
  resetRailStores();
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('Observe with the pinned-only rail on', () => {
  beforeEach(() => window.localStorage.setItem(NAVIGATOR_STORAGE_KEY, 'rail'));

  it('drops the left header and heads the panel with PanelTop', () => {
    const { gate } = mount('graph');
    const frame = screen.getByTestId('app-frame');
    expect(frame.dataset.pinnedRail).toBe('graph');
    expect(frame.querySelector('.tws-left-header')).toBeNull();
    const panel = screen.getByTestId('app-frame-panel');
    expect(panel.querySelector('[data-testid="tws-paneltop"]')).not.toBeNull();
    /* The screen's own controls portal in BELOW the top row. */
    expect(panel.querySelector('.app-frame-panel-host')).not.toBeNull();
    fireEvent.click(screen.getByTestId('tws-paneltop-search'));
    expect(gate.openPalette).toHaveBeenCalled();
  });

  it('collapses the panel on the rail store and Show panel brings it back', () => {
    mount('graph');
    fireEvent.click(screen.getByTestId('tws-paneltop-collapse'));
    expect(getRailStore(SPACE).getState().collapsed).toBe(true);
    expect(screen.getByTestId('app-frame').dataset.panelCollapsed).toBe('true');
    expect(screen.queryByTestId('app-frame-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('tws-show-panel'));
    expect(screen.getByTestId('app-frame').dataset.panelCollapsed).toBeUndefined();
    expect(screen.getByTestId('tws-paneltop')).toBeTruthy();
  });

  it('leaves a mode not yet in the pinned shell as it was', () => {
    mount(undefined);
    expect(screen.getByTestId('app-frame').dataset.pinnedRail).toBeUndefined();
    expect(screen.queryByTestId('tws-paneltop')).toBeNull();
    expect(document.querySelector('.tws-left-header')).not.toBeNull();
  });
});

describe('Observe with the flag off', () => {
  it('keeps the left header and the bare panel host', () => {
    mount('graph');
    const frame = screen.getByTestId('app-frame');
    expect(frame.dataset.pinnedRail).toBeUndefined();
    expect(frame.querySelector('.tws-left-header')).not.toBeNull();
    expect(screen.queryByTestId('tws-paneltop')).toBeNull();
    expect(screen.getByTestId('app-frame-panel').dataset.host).toBe('true');
  });
});
