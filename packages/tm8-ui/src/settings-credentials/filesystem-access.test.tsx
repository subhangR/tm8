// @vitest-environment jsdom
/**
 * Settings → Filesystem access (282). The server decides everything; these
 * pin what each viewer is shown and that a refusal is shown as one.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollabError, type NodeAccountView, type PathGrantView } from '@tm8/contract';

import { BROWSE_IN_SPACE_TEXT, FilesystemAccessSection, NO_GRANT_TEXT } from './FilesystemAccessSection';
import { filesystemAccessPortFromSeam, type FilesystemAccessPort } from './filesystem-access-port';
import type { Seam } from '../data/seam';

afterEach(cleanup);

const ADA: NodeAccountView = { accountId: '00000000-0000-7000-8000-0000000000a1', username: 'ada', status: 'active' };
const ROOT: NodeAccountView = { accountId: '00000000-0000-7000-8000-0000000000a0', username: 'root', status: 'active', isNodeAdmin: true };

function grant(over: Partial<PathGrantView> = {}): PathGrantView {
  return {
    id: '00000000-0000-7000-8000-0000000000g1',
    accountId: ADA.accountId,
    rootPath: '/srv/repos',
    mode: 'select',
    grantedAt: '2026-10-02T08:00:00.000Z',
    grantee: ADA,
    ...over,
  };
}

function fakePort(isNodeAdmin: boolean, over: Partial<FilesystemAccessPort> = {}) {
  let grants: PathGrantView[] = [];
  const port = {
    viewer: vi.fn(async () => ({ isNodeAdmin })),
    list: vi.fn(async (includeRevoked: boolean) => ({
      grants: grants.filter((g) => includeRevoked || !g.revokedAt),
    })),
    accounts: vi.fn(async () => ({ accounts: [ROOT, ADA] })),
    create: vi.fn(async (accountId: string, rootPath: string, note?: string) => {
      const row = grant({ accountId, rootPath, ...(note ? { note } : {}) });
      grants = [...grants.filter((g) => g.id !== row.id), row];
      return row;
    }),
    revoke: vi.fn(async (grantId: string) => {
      grants = grants.map((g) => (g.id === grantId ? { ...g, revokedAt: '2026-10-02T09:00:00.000Z' } : g));
      return grants.find((g) => g.id === grantId)!;
    }),
    mine: vi.fn(async () => ({ grants: [] as PathGrantView[] })),
    browse: vi.fn(async (path?: string) => ({
      roots: ['/srv'],
      path: path ?? '/srv',
      parentPath: path && path !== '/srv' ? '/srv' : null,
      separator: '/' as const,
      directories: path ? [] : [{ name: 'repos', path: '/srv/repos' }],
      truncated: false,
    })),
    ...over,
  };
  return port;
}

describe('FilesystemAccessSection — a member', () => {
  it('without a grant is told how to get one', async () => {
    render(<FilesystemAccessSection port={fakePort(false)} />);
    expect((await screen.findByTestId('fs-access-none')).textContent).toBe(NO_GRANT_TEXT);
    expect(screen.queryByTestId('fs-access-form')).toBeNull();
  });

  it('with grants sees their folders and nothing to administer', async () => {
    const port = fakePort(false, { mine: vi.fn(async () => ({ grants: [grant({ note: 'team repos' })] })) });
    render(<FilesystemAccessSection port={port} />);
    const mine = await screen.findByTestId('fs-access-mine');
    expect(within(mine).getByText('/srv/repos')).toBeTruthy();
    expect(within(mine).getByText('team repos')).toBeTruthy();
    expect(port.list).not.toHaveBeenCalled();
    expect(port.accounts).not.toHaveBeenCalled();
  });
});

describe('FilesystemAccessSection — a node admin', () => {
  it('grants a folder picked in the browser, then revokes and re-grants it', async () => {
    const port = fakePort(true);
    render(<FilesystemAccessSection port={port} />);
    await screen.findByTestId('fs-access-empty');

    // Node admins are not offered as grantees: they hold every root already.
    const member = screen.getByRole('combobox', { name: 'Member' }) as HTMLSelectElement;
    expect([...member.options].map((o) => o.textContent)).toEqual(['Choose a member…', 'ada']);
    fireEvent.change(member, { target: { value: ADA.accountId } });

    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
    const browser = await screen.findByTestId('fs-access-browser');
    fireEvent.click(within(browser).getByRole('button', { name: /repos/ }));
    await waitFor(() => expect(port.browse).toHaveBeenLastCalledWith('/srv/repos'));
    fireEvent.click(await screen.findByRole('button', { name: 'Use this folder' }));
    expect((screen.getByRole('textbox', { name: 'Folder' }) as HTMLInputElement).value).toBe('/srv/repos');

    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'team repos' } });
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(port.create).toHaveBeenCalledWith(ADA.accountId, '/srv/repos', 'team repos'));
    const row = await screen.findByTestId('fs-access-grant-00000000-0000-7000-8000-0000000000g1');
    expect(within(row).getByText('granted 2026-10-02')).toBeTruthy();

    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(port.revoke).toHaveBeenCalledWith('00000000-0000-7000-8000-0000000000g1'));
    await screen.findByTestId('fs-access-empty');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show revoked grants' }));
    const revoked = await screen.findByTestId('fs-access-grant-00000000-0000-7000-8000-0000000000g1');
    expect(within(revoked).getByText('revoked 2026-10-02')).toBeTruthy();
    fireEvent.click(within(revoked).getByRole('button', { name: 'Grant again' }));
    await waitFor(() => expect(port.create).toHaveBeenLastCalledWith(ADA.accountId, '/srv/repos', 'team repos'));
  });

  it('shows the server refusal and keeps what was typed', async () => {
    const port = fakePort(true, {
      create: vi.fn(async () => {
        throw new CollabError('forbidden', 'project directory is outside TM8_PROJECT_ROOTS');
      }),
    });
    render(<FilesystemAccessSection port={port} />);
    await screen.findByTestId('fs-access-empty');
    fireEvent.change(screen.getByRole('combobox', { name: 'Member' }), { target: { value: ADA.accountId } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder' }), { target: { value: '/etc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }));
    expect((await screen.findByTestId('fs-access-failure-refused')).textContent)
      .toBe('Refused: project directory is outside TM8_PROJECT_ROOTS');
    expect((screen.getByRole('textbox', { name: 'Folder' }) as HTMLInputElement).value).toBe('/etc');
  });
});

describe('FilesystemAccessSection — browsing from inside a space', () => {
  it('explains why the admin browser is refused instead of saying no folder is granted', async () => {
    const port = fakePort(true, {
      browse: vi.fn(async () => {
        throw new CollabError('forbidden', 'no folder on this node is granted to you', {
          details: { reason: 'path_grant_required' },
        });
      }),
    });
    render(<FilesystemAccessSection port={port} />);
    await screen.findByTestId('fs-access-empty');
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
    expect((await screen.findByRole('alert')).textContent).toBe(BROWSE_IN_SPACE_TEXT);
  });
});

describe('filesystemAccessPortFromSeam', () => {
  it('is null on a seam with no node behind it, and says so', async () => {
    const seam = { identity: vi.fn() } as unknown as Seam;
    expect(filesystemAccessPortFromSeam(seam)).toBeNull();
    render(<FilesystemAccessSection port={null} />);
    expect(await screen.findByTestId('fs-access-absent')).toBeTruthy();
  });

  it('reads node admin from identity and browses through projectSetup', async () => {
    const directories = vi.fn(async () => ({
      roots: ['/'], path: '/', parentPath: null, separator: '/' as const, directories: [], truncated: false,
    }));
    const seam = {
      identity: vi.fn(async () => ({ isNodeAdmin: true })),
      pathGrants: { list: vi.fn(), create: vi.fn(), revoke: vi.fn(), accounts: vi.fn(), mine: vi.fn() },
      projectSetup: { directories },
    } as unknown as Seam;
    const port = filesystemAccessPortFromSeam(seam)!;
    expect(await port.viewer()).toEqual({ isNodeAdmin: true });
    await port.browse!('/srv');
    expect(directories).toHaveBeenCalledWith('/srv');
  });
});
