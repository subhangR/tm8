// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AccountMenu } from './AccountMenu';

vi.mock('./gate-context', () => ({
  useAuthActions: () => ({ account: { handle: 'alex', isOwner: false }, signOut: vi.fn() }),
}));

afterEach(cleanup);
const actor = { id: 'm', kind: 'member' as const, displayName: 'Alex', avatar: null, isAgent: false };

describe('admin account menu destinations', () => {
  it('does not offer admin pages without authorized callbacks', () => {
    render(<AccountMenu actor={actor} />);
    fireEvent.click(screen.getByTestId('account-menu-trigger'));
    expect(screen.queryByRole('button', { name: 'Space admin' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Node admin' })).toBeNull();
  });
  it.each(['Space admin', 'Node admin'])('opens %s and closes the menu', (label) => {
    const onOpen = vi.fn();
    render(<AccountMenu actor={actor} {...(label === 'Space admin'
      ? { onOpenSpaceAdmin: onOpen } : { onOpenNodeAdmin: onOpen })} />);
    fireEvent.click(screen.getByTestId('account-menu-trigger'));
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('auth-account-menu')).toBeNull();
  });
});
