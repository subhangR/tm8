// @vitest-environment jsdom
/**
 * The workspace switcher (API doc 01a115c4 §10): disabled with a tooltip, and
 * its `g w` a no-op with a notice, while the events socket is down (S13); open,
 * focus lands in the list and a digit switches to that position.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceSummary } from '@tm8/contract';

import type { WorkspaceManagePort } from '../../data/seam';
import { createWorkspaceListStore, openWorkspaceSwitcher, WORKSPACE_SWITCHER_OFFLINE } from '../bridge/workspaceList';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

const summary = (id: string, name: string, position: number, active = false): WorkspaceSummary => ({
  id, name, color: null, position, active, revision: 1, tabCount: position + 1, draftCount: 0, dirtyDraftCount: 0,
  createdAt: null, createdBy: null, agentChangedSinceActive: false, lastAgentChange: null,
});

function setup(online: boolean) {
  const store = createWorkspaceListStore({
    capable: true,
    online,
    shown: 'w1',
    activeWorkspaceId: 'w1',
    items: [summary('w1', 'Main', 0, true), summary('w2', 'Billing', 1)],
  });
  const manage = { switch: vi.fn(async () => ({ status: 'applied' })) } as unknown as WorkspaceManagePort;
  const notices: string[] = [];
  render(<WorkspaceSwitcher store={store} spaceId="s1" manage={manage} notify={(t) => void notices.push(t)} />);
  return { store, manage, notices };
}

describe('WorkspaceSwitcher', () => {
  it('is disabled, with a tooltip, and g w is a no-op with a notice while offline (S13)', () => {
    const { store } = setup(false);
    const trigger = screen.getByRole('button', { name: 'Workspace: Main' });
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(trigger.getAttribute('title')).toBe(WORKSPACE_SWITCHER_OFFLINE);
    fireEvent.click(trigger);
    expect(screen.queryByRole('dialog')).toBeNull();
    const toasts: string[] = [];
    act(() => void expect(openWorkspaceSwitcher(store, (t) => void toasts.push(t))).toBe(false));
    expect(toasts).toEqual([WORKSPACE_SWITCHER_OFFLINE]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens on g w with focus in the list; a digit switches to that position', () => {
    const { store, manage } = setup(true);
    act(() => void expect(openWorkspaceSwitcher(store, () => {})).toBe(true));
    expect(screen.getByRole('dialog', { name: 'Switch workspace' })).toBeTruthy();
    expect((document.activeElement as HTMLElement).textContent).toContain('Main');
    fireEvent.keyDown(document.activeElement!, { key: '2' });
    expect(manage.switch).toHaveBeenCalledWith('s1', 'w2', 'w1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
