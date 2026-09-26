// @vitest-environment jsdom
/**
 * G6 W1-client — Remove on the members screen, Leave in Danger zone.
 *
 * Driven the way `port-seam.test.tsx` drives the port: through a REAL
 * `createFixtureSeam()` and the real `settingsPortFromSeam`, asserting on
 * what the table shows after the write — no reload, no remount. The wire half
 * (that the real seam reaches `spaces.members.remove` / `spaces.leave`) is in
 * `data/real/membership-ops.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createFixtureSeam } from '../data';
import { SettingsShell } from './SettingsShell';
import { settingsPortFromSeam, type SettingsPort } from './port';

afterEach(cleanup);

async function setup(over: Partial<SettingsPort> = {}) {
  const seam = createFixtureSeam();
  const [space] = await seam.spaces();
  const port = { ...settingsPortFromSeam(seam, space!.id), ...over };
  return { seam, spaceId: space!.id, port };
}

function rowFor(name: string): HTMLElement | undefined {
  return screen.queryAllByTestId('member-row').find((row) => row.textContent?.includes(name));
}

describe('Remove — members screen', () => {
  it('confirms, calls the op, and the row leaves the table without a reload', async () => {
    const { seam, spaceId, port } = await setup();
    const removeMember = vi.spyOn(port, 'removeMember');
    render(<SettingsShell port={port} initialSection="members" />);

    await waitFor(() => expect(rowFor('Noor')).toBeTruthy());
    const before = screen.getAllByTestId('member-row').length;

    fireEvent.click(within(rowFor('Noor')!).getByTestId('member-remove'));
    // Nothing is written by the ✕ itself — only by the confirmation.
    expect(removeMember).not.toHaveBeenCalled();
    const dialog = screen.getByTestId('member-remove-confirm');
    expect(dialog.textContent).toContain('Remove Noor?');
    expect(dialog.textContent).toContain('(left)');

    fireEvent.click(screen.getByTestId('member-remove-confirm-go'));

    await waitFor(() => expect(rowFor('Noor')).toBeUndefined());
    expect(screen.getAllByTestId('member-row')).toHaveLength(before - 1);
    expect(screen.queryByTestId('member-remove-confirm')).toBeNull();
    expect(removeMember).toHaveBeenCalledWith('ent-member-noor');

    // The write LANDED: the seam no longer counts Noor, and a second remove is refused.
    await expect(seam.commands.removeMember(spaceId, 'ent-member-noor')).rejects.toThrow(/not found/);
  });

  it('Cancel writes nothing and keeps the row', async () => {
    const { port } = await setup();
    const removeMember = vi.spyOn(port, 'removeMember');
    render(<SettingsShell port={port} initialSection="members" />);
    await waitFor(() => expect(rowFor('Noor')).toBeTruthy());

    fireEvent.click(within(rowFor('Noor')!).getByTestId('member-remove'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByTestId('member-remove-confirm')).toBeNull();
    expect(removeMember).not.toHaveBeenCalled();
    expect(rowFor('Noor')).toBeTruthy();
  });

  it('a refusal is printed in the dialog in the server’s words, and the row stays', async () => {
    const { port } = await setup({
      removeMember: () => Promise.reject(new Error('only an owner may remove an owner')),
    });
    render(<SettingsShell port={port} initialSection="members" />);
    await waitFor(() => expect(rowFor('Noor')).toBeTruthy());

    fireEvent.click(within(rowFor('Noor')!).getByTestId('member-remove'));
    fireEvent.click(screen.getByTestId('member-remove-confirm-go'));

    const error = await screen.findByTestId('member-remove-confirm-error');
    expect(error.textContent).toBe('only an owner may remove an owner');
    expect(rowFor('Noor')).toBeTruthy();
  });

  it('a port without the verb leaves every ✕ locked with a reason', async () => {
    const { port } = await setup();
    const { removeMember: _drop, ...withoutRemove } = port;
    render(<SettingsShell port={withoutRemove} initialSection="members" />);
    await waitFor(() => expect(rowFor('Noor')).toBeTruthy());
    expect(screen.queryAllByTestId('member-remove')).toHaveLength(0);
    expect(within(rowFor('Noor')!).getByRole('button', { name: 'remove Noor' }).getAttribute('aria-disabled')).toBe('true');
  });
});

describe('Leave — Danger zone', () => {
  it('the last owner is refused, and the refusal is shown, not swallowed', async () => {
    const { port } = await setup();
    const onLeftSpace = vi.fn();
    render(<SettingsShell port={port} initialSection="danger" onLeftSpace={onLeftSpace} />);

    fireEvent.click(await screen.findByTestId('danger-leave'));
    fireEvent.click(screen.getByTestId('leave-confirm-go'));

    const error = await screen.findByTestId('leave-confirm-error');
    expect(error.textContent).toMatch(/last owner cannot leave/);
    expect(onLeftSpace).not.toHaveBeenCalled();
  });

  it('with a second owner, leaving lands and the host is told which space to drop', async () => {
    const { seam, spaceId, port } = await setup();
    await port.setMemberRole('ent-member-noor', 'owner');
    const onLeftSpace = vi.fn();
    render(<SettingsShell port={port} initialSection="danger" onLeftSpace={onLeftSpace} />);

    fireEvent.click(await screen.findByTestId('danger-leave'));
    expect(screen.getByTestId('leave-confirm').textContent).toContain('(left)');
    fireEvent.click(screen.getByTestId('leave-confirm-go'));

    await waitFor(() => expect(onLeftSpace).toHaveBeenCalledWith(spaceId));
    expect(screen.queryByTestId('leave-confirm')).toBeNull();
    // The viewer is no longer a member, so the node no longer lists the space.
    expect(await seam.spaces()).toEqual([]);
  });
});
