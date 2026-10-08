// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createFixtureSeam, FIXTURE_SPACE_ID } from '../data/fixtures/seam-fixture';
import { createMemoryTarget } from '../routes';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { GateApp } from './GateApp';

vi.mock('../shell/desktop-modes', () => ({ desktopModes: () => 'legacy' }));

beforeEach(() => {
  localStorage.clear();
  resetNav();
  screenStackStore.getState().clearAll();
});
afterEach(cleanup);

async function viewer(role: string, node: 'admin' | 'owner' | 'none' = 'none') {
  const seam = createFixtureSeam();
  const identity = await seam.identity();
  seam.identity = vi.fn(async () => ({ ...identity, isNodeAdmin: node === 'admin', isOwner: node === 'owner',
    memberships: identity.memberships.map(m => ({ ...m, role })),
  }));
  return seam;
}

describe('admin pages in the application router', () => {
  it('opens Space admin from Settings and retains its section in the address', async () => {
    const router = createMemoryTarget(`#/s/${FIXTURE_SPACE_ID}/settings`);
    render(<GateApp seam={await viewer('admin')} routerTarget={router} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Space admin' }));
    await screen.findByRole('heading', { name: 'Space admin' });
    fireEvent.click(screen.getByRole('button', { name: 'Members & roles' }));
    await waitFor(() => expect(router.getHash()).toContain('/space-admin/members'));
    expect(screen.queryByRole('button', { name: 'Filesystem access' })).toBeNull();
  });
  it.each(['admin', 'owner'] as const)('opens Node admin for node %s with ordinary space membership', async (node) => {
    const router = createMemoryTarget(`#/s/${FIXTURE_SPACE_ID}/settings`);
    render(<GateApp seam={await viewer('member', node)} routerTarget={router} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Node admin' }));
    await screen.findByRole('heading', { name: 'Node admin' });
    await screen.findByRole('navigation', { name: 'Node administration sections' });
    expect(screen.queryByRole('button', { name: 'Space admin' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Accounts' }));
    await waitFor(() => expect(router.getHash()).toContain('/node-admin/accounts'));
  });
  it('refuses a direct node URL without loading node credentials', async () => {
    const seam = await viewer('admin');
    const nodeStatus = vi.spyOn(seam.credentials.node, 'status');
    render(<GateApp seam={seam} routerTarget={createMemoryTarget(`#/s/${FIXTURE_SPACE_ID}/node-admin`)} />);
    await screen.findByText(/Only node admins and node owners/);
    expect(nodeStatus).not.toHaveBeenCalled();
  });
  it('refuses a direct space URL for a node owner without space-admin membership', async () => {
    render(<GateApp seam={await viewer('member', 'owner')} routerTarget={createMemoryTarget(`#/s/${FIXTURE_SPACE_ID}/space-admin`)} />);
    await screen.findByText(/Space admin access requires/);
    expect(screen.queryByRole('button', { name: 'Members & roles' })).toBeNull();
  });
});
