// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IdentityView, Seam } from '../data/seam';
import { NodeAdminPage, type NodeAdminSection } from './NodeAdminPage';
import { filesystemAccessPortFromSeam } from '../settings-credentials/filesystem-access-port';
import { spaceCredentialsPortFromSeam } from '../settings-credentials/space-port';
import type { SpaceId } from '@tm8/contract';

afterEach(cleanup);
function fixture(admin = false, owner = false) {
  const identity = {
    isNodeAdmin: admin,
    isOwner: owner,
    accountId: 'me',
    memberships: [{ spaceId: 'space', memberId: 'me', role: 'member' }],
  } as IdentityView;
  const node = {
    status: vi.fn(async () => ({
      providers: [{ provider: 'openai', allowNode: true, envKeyPresent: true }],
    })),
    setPolicy: vi.fn(async (provider, allowNode) => ({ provider, allowNode })),
  };
  const seam = {
    identity: vi.fn(async () => identity),
    onResync: vi.fn(() => () => {}),
    credentials: { node, space: { policy: vi.fn() } },
    pathGrants: {
      accounts: vi.fn(async () => ({
        accounts: [{ accountId: 'me', username: 'ada', status: 'active' }],
      })),
      list: vi.fn(async () => ({ grants: [] })),
      mine: vi.fn(),
      create: vi.fn(),
      revoke: vi.fn(),
    },
    spaceConfigs: vi.fn(async () => ({
      node: {
        visible: true,
        knobs: [
          {
            name: 'TM8_PORT',
            summary: 'Listening port',
            value: { kind: 'value', text: '17777' },
            source: 'env',
            default: '3000',
            change: 'env',
          },
        ],
      },
      code: [],
      teammates: [],
      profiles: [],
      cli: [],
    })),
  };
  return { seam: seam as unknown as Seam, mocks: seam, identity, node };
}
describe('NodeAdminPage', () => {
  it.each([
    [true, false],
    [false, true],
  ])(
    'allows admin=%s owner=%s with only member standing',
    async (admin, owner) => {
      const { seam, mocks, node } = fixture(admin, owner);
      render(<NodeAdminPage seam={seam} spaceId="space" />);
      await screen.findByText('The server holds a key for this provider.');
      fireEvent.click(
        screen.getByRole('checkbox', {
          name: 'Allow node fallback for Codex (OpenAI)',
        }),
      );
      await waitFor(() =>
        expect(node.setPolicy).toHaveBeenCalledWith('openai', false),
      );
      expect(mocks.credentials.space.policy).not.toHaveBeenCalled();
    },
  );
  it.each([
    'credentials',
    'filesystem',
    'accounts',
    'configuration',
  ] as NodeAdminSection[])(
    'denies ordinary accounts without loading %s',
    async (section) => {
      const { seam, mocks, node } = fixture();
      render(
        <NodeAdminPage seam={seam} spaceId="space" initialSection={section} />,
      );
      await screen.findByText(/Only node admins and node owners/);
      expect(node.status).not.toHaveBeenCalled();
      expect(mocks.spaceConfigs).not.toHaveBeenCalled();
      expect(mocks.pathGrants.accounts).not.toHaveBeenCalled();
      expect(mocks.pathGrants.list).not.toHaveBeenCalled();
    },
  );
  it('waits for identity before any privileged read', async () => {
    const { seam, mocks, identity } = fixture(true);
    let resolve!: (identity: IdentityView) => void;
    mocks.identity.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    render(
      <NodeAdminPage seam={seam} spaceId="space" initialSection="accounts" />,
    );
    expect(screen.getByRole('status').textContent).toContain('Checking');
    expect(mocks.pathGrants.accounts).not.toHaveBeenCalled();
    await act(async () => resolve(identity));
    await screen.findByText('ada');
  });
  it('shows read-only environment values and server denial, with refresh retry', async () => {
    const { seam, mocks } = fixture(false, true);
    mocks.spaceConfigs.mockRejectedValueOnce(new Error('Server unavailable'));
    render(
      <NodeAdminPage
        seam={seam}
        spaceId="space"
        initialSection="configuration"
      />,
    );
    await screen.findByText(/Server unavailable/);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh section' }));
    await screen.findByText('17777');
    expect(
      screen.getByText('Set TM8_PORT in the server environment and restart.'),
    ).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('shows account errors and retries the roster', async () => {
    const { seam, mocks } = fixture(true);
    mocks.pathGrants.accounts.mockRejectedValueOnce(new Error('forbidden'));
    render(
      <NodeAdminPage seam={seam} spaceId="space" initialSection="accounts" />,
    );
    await screen.findByText(/Accounts could not be read: forbidden/);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh section' }));
    await screen.findByText('ada');
  });
  it('retries identity errors without privileged loads', async () => {
    const { seam, mocks } = fixture(true);
    mocks.identity.mockRejectedValueOnce(new Error('offline'));
    render(
      <NodeAdminPage seam={seam} spaceId="space" initialSection="accounts" />,
    );
    await screen.findByText(/offline/);
    expect(mocks.pathGrants.accounts).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('ada');
  });
  it('removes prior data immediately when the seam changes', async () => {
    const first = fixture(true);
    const second = fixture();
    const view = render(
      <NodeAdminPage
        seam={first.seam}
        spaceId="space"
        initialSection="accounts"
      />,
    );
    await screen.findByText('ada');
    view.rerender(
      <NodeAdminPage
        seam={second.seam}
        spaceId="space"
        initialSection="accounts"
      />,
    );
    expect(screen.queryByText('ada')).toBeNull();
    await screen.findByText(/Only node admins/);
    expect(second.mocks.pathGrants.accounts).not.toHaveBeenCalled();
  });
  it('removes content on identity changes and refuses stale credential writes', async () => {
    const { seam, mocks, node, identity } = fixture(true);
    const view = render(
      <NodeAdminPage seam={seam} spaceId="space" identity={identity} />,
    );
    await screen.findByText('The server holds a key for this provider.');
    const denied = { ...identity, isNodeAdmin: false };
    mocks.identity.mockResolvedValue(denied);
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Allow node fallback for Codex (OpenAI)',
      }),
    );
    await screen.findByText(/Only node admins/);
    expect(node.setPolicy).not.toHaveBeenCalled();
    view.rerender(
      <NodeAdminPage seam={seam} spaceId="space" identity={denied} />,
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
  it('invalidates mounted data immediately on host identity changes', async () => {
    const { seam, identity, mocks } = fixture(false, true);
    const view = render(
      <NodeAdminPage
        seam={seam}
        identity={identity}
        spaceId="space"
        initialSection="accounts"
      />,
    );
    await screen.findByText('ada');
    view.rerender(
      <NodeAdminPage
        seam={seam}
        identity={null}
        spaceId="space"
        initialSection="accounts"
      />,
    );
    expect(screen.queryByText('ada')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Checking');
    const denied = { ...identity, isOwner: false };
    mocks.identity.mockResolvedValue(denied);
    view.rerender(
      <NodeAdminPage
        seam={seam}
        identity={denied}
        spaceId="space"
        initialSection="accounts"
      />,
    );
    await screen.findByText(/Only node admins/);
    expect(mocks.pathGrants.accounts).toHaveBeenCalledTimes(1);
  });

  it('loads filesystem administration for owner-only accounts', async () => {
    const { seam, mocks } = fixture(false, true);
    render(
      <NodeAdminPage seam={seam} spaceId="space" initialSection="filesystem" />,
    );
    await screen.findByTestId('fs-access-form');
    expect(mocks.pathGrants.list).toHaveBeenCalled();
    expect(mocks.pathGrants.mine).not.toHaveBeenCalled();
    expect(await filesystemAccessPortFromSeam(seam)!.viewer()).toEqual({
      isNodeAdmin: true,
    });
    expect(
      await spaceCredentialsPortFromSeam(
        seam,
        'space' as SpaceId,
        null,
      ).viewer(),
    ).toMatchObject({ isNodeAdmin: true, isSpaceAdmin: false });
  });
});
