// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeAccountListView } from '@tm8/contract';
import { AccountsSection, isLoopbackOrigin, setupUrlFor, type AccountsPort } from './AccountsSection';

afterEach(cleanup);

const LIST: NodeAccountListView = {
  accounts: [
    { accountId: 'own', username: 'root', status: 'active', isNodeAdmin: true, isOwner: true, hasPassword: true },
    { accountId: 'me', username: 'admin', status: 'active', isNodeAdmin: true, hasPassword: true },
    { accountId: 'a1', username: 'alice', status: 'active', hasPassword: false, setupExpiresAt: '2026-10-16T00:00:00.000Z' },
    { accountId: 'b1', username: 'bob', status: 'disabled', hasPassword: true },
  ],
};
const LINK = { setupToken: 'tm8a_tok', setupUrl: 'ignored', expiresAt: '2026-10-16T00:00:00.000Z' };

function port(): AccountsPort & { admin: NonNullable<AccountsPort['admin']> } {
  return {
    load: vi.fn(async () => LIST),
    spaces: vi.fn(async () => [{ id: 's1', name: 'Docs', description: '', memberCount: 1 } as never]),
    createInvite: vi.fn(async () => ({ code: 'inv_x' })),
    viewerAccountId: 'me',
    origin: 'https://tm8.example',
    admin: {
      list: vi.fn(),
      create: vi.fn(async (input) => ({ account: { accountId: 'n', username: input.username, status: 'active' as const }, ...LINK })),
      reset: vi.fn(async () => ({ accountId: 'a1', username: 'alice', revokedSessionCount: 0, ...LINK })),
      disable: vi.fn(),
      enable: vi.fn(async () => ({ accountId: 'b1', status: 'active' as const })),
      setNodeAdmin: vi.fn(async (id, on) => ({ accountId: id, isNodeAdmin: on })),
      addToSpace: vi.fn(async () => ({ accountId: 'a1', spaceId: 's1', memberId: 'm', role: 'member', created: true })),
    },
  };
}

describe('AccountsSection', () => {
  it('creates an account and shows the one-time setup link on the node origin', async () => {
    const p = port();
    render(<AccountsSection port={p} />);
    await screen.findByText('alice');
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'carol' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and get setup link' }));
    await waitFor(() => expect(p.admin.create).toHaveBeenCalledWith({ username: 'carol' }));
    expect(((await screen.findByLabelText('Link to share')) as HTMLInputElement).value).toBe('https://tm8.example/#setup=tm8a_tok');
  });

  it('offers no action on the owner and no reset/disable on yourself', async () => {
    render(<AccountsSection port={port()} />);
    await screen.findByText('alice');
    expect(screen.queryByRole('group', { name: 'Actions for root' })).toBeNull();
    const self = screen.getByRole('group', { name: 'Actions for admin' });
    expect(self.textContent).not.toContain('Reset password');
    expect(self.textContent).not.toContain('Disable');
    expect(screen.getByRole('group', { name: 'Actions for alice' }).textContent).toContain('New setup link');
    expect(screen.getByRole('group', { name: 'Actions for bob' }).textContent).toContain('Enable');
  });

  it('resets after confirmation and re-enables a disabled account', async () => {
    const p = port();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AccountsSection port={p} />);
    await screen.findByText('alice');
    fireEvent.click(screen.getByRole('button', { name: 'New setup link' }));
    await waitFor(() => expect(p.admin.reset).toHaveBeenCalledWith('a1'));
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(p.admin.enable).toHaveBeenCalledWith('b1'));
  });

  it('shows a server refusal instead of swallowing it', async () => {
    const p = port();
    p.admin.setNodeAdmin = vi.fn(async () => { throw new Error('this is the last node admin; grant another account first'); });
    render(<AccountsSection port={p} />);
    await screen.findByText('alice');
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke node admin' })[0]!);
    await screen.findByText(/last node admin/);
  });

  it('warns when links would point at a loopback origin', async () => {
    render(<AccountsSection port={{ ...port(), origin: 'http://127.0.0.1:8787' }} />);
    await screen.findByText(/only works on this machine/);
    expect(isLoopbackOrigin('http://localhost:3000')).toBe(true);
    expect(isLoopbackOrigin('https://tm8.example')).toBe(false);
    expect(setupUrlFor('tm8a_x', 'https://a.example/')).toBe('https://a.example/#setup=tm8a_x');
  });
});
