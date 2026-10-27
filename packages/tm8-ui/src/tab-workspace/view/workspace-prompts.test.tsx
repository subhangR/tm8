// @vitest-environment jsdom
/**
 * An agent's asks (API doc 01a115c4 §5.11–§5.12, D8): Switch/Stay and
 * Delete/Keep answered through `workspace.prompts.resolve`, the F1 discard
 * confirm, and a prompt the node no longer lists goes away.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspacePrompt } from '@tm8/contract';

import type { WorkspaceManagePort } from '../../data/seam';
import { createWorkspaceListStore } from '../bridge/workspaceList';
import { WorkspacePrompts } from './WorkspacePrompts';

const prompt = (promptId: string, kind: 'switch' | 'delete', workspaceName: string): WorkspacePrompt => ({
  promptId, kind, workspaceId: `ws-${promptId}`, workspaceName, actorName: 'Codex', state: 'open', createdAt: '2026-10-07T00:00:00Z',
});

function setup(prompts: WorkspacePrompt[], resolvePrompt: WorkspaceManagePort['resolvePrompt']) {
  const store = createWorkspaceListStore({ capable: true, online: true, prompts });
  const manage = { resolvePrompt: vi.fn(resolvePrompt) } as unknown as WorkspaceManagePort;
  const notices: string[] = [];
  render(<WorkspacePrompts store={store} spaceId="s1" manage={manage} notify={(t) => void notices.push(t)} />);
  return { store, manage, notices };
}

describe('WorkspacePrompts', () => {
  it('Switch answers the switch prompt with accept, and the card goes', async () => {
    const { manage } = setup([prompt('p1', 'switch', 'Billing')], async () => ({ status: 'applied' }) as never);
    expect(screen.getByText('Codex wants to switch to Billing')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Switch' }));
    expect(manage.resolvePrompt).toHaveBeenCalledWith('s1', 'p1', 'accept', false);
    await waitFor(() => expect(screen.queryByText('Codex wants to switch to Billing')).toBeNull());
  });

  it('F1: Delete on unsaved drafts asks to discard, then re-sends with discard', async () => {
    const answers = [
      { status: 'rejected', reason: 'unsaved_changes', dirtyDraftIds: ['d1'] },
      { status: 'applied' },
    ];
    const { manage } = setup([prompt('p2', 'delete', 'Scratch')], async () => answers.shift() as never);
    expect(screen.getByText('Codex wants to delete Scratch')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByText('Discard unsaved changes and delete?');
    fireEvent.click(screen.getByRole('button', { name: 'Discard and delete' }));
    expect(manage.resolvePrompt).toHaveBeenLastCalledWith('s1', 'p2', 'accept', true);
    await waitFor(() => expect(screen.queryByText('Discard unsaved changes and delete?')).toBeNull());
  });

  it('a prompt a later frame no longer lists is removed', () => {
    const { store } = setup([prompt('p3', 'switch', 'Billing'), prompt('p4', 'delete', 'Scratch')], async () => ({ status: 'applied' }) as never);
    expect(screen.getByText('Codex wants to switch to Billing')).toBeTruthy();
    act(() => store.setState({ prompts: [prompt('p4', 'delete', 'Scratch')] }));
    expect(screen.queryByText('Codex wants to switch to Billing')).toBeNull();
    expect(screen.getByText('Codex wants to delete Scratch')).toBeTruthy();
  });
});
