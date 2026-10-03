// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CredentialsStatusView, SpaceCredentialView } from '@tm8/contract';
import { CredentialsSection } from './CredentialsSection';
import { credentialsSharePortFromSeam, type CredentialsPort, type CredentialsSharePort } from './port';

vi.mock('../terminal', () => ({
  isLiveTerminalEnabled: () => true,
  LiveTerminal: ({ sessionId }: { sessionId: string }) => <div data-testid="share-terminal">{sessionId}</div>,
  TerminalHost: () => <div />,
}));
afterEach(cleanup);

const credential = { id: 'space-credential', status: 'active', visibility: 'private' } as SpaceCredentialView;
const started = { provider: 'anthropic' as const, spaceId: 'space-a', workSessionId: 'fresh-space-login', expiresAt: '2030-01-01', command: 'claude auth login', spaceCredential: credential };
function ports(provider: 'github' | 'anthropic' | 'openai' = 'github') {
  const status: CredentialsStatusView = {
    gitCredentialStore: 'present',
    providers: [
      { provider, connected: true, login: 'owner', authMethod: 'oauth', status: 'active', connectedAt: null, lastVerifiedAt: null },
      { provider: 'gemini', connected: false, login: null, authMethod: null, status: null, connectedAt: null, lastVerifiedAt: null },
    ],
  };
  const personal: CredentialsPort = {
    load: vi.fn(async () => status), disconnect: vi.fn(), startLogin: vi.fn(), finishLogin: vi.fn(),
  };
  const share: CredentialsSharePort = {
    currentSpaceId: 'space-a',
    spaces: vi.fn(async () => [{ id: 'space-a', name: 'Design' }, { id: 'space-b', name: 'Engineering' }]),
    members: vi.fn(async () => [{ id: 'member-one', name: 'Ada' }, { id: 'member-two', name: 'Noor' }]),
    addMine: vi.fn(async () => credential),
    startPrivateLogin: vi.fn(async () => ({ ...started, provider })),
    finishLogin: vi.fn(async () => ({ workSessionId: started.workSessionId, provider, connected: true, login: null, authMethod: 'oauth', status: 'active', stored: true, terminated: true, spaceCredential: credential })),
    share: vi.fn(async () => {}),
  };
  return { personal, share };
}
async function open(provider: 'github' | 'anthropic' | 'openai' = 'github') {
  const p = ports(provider);
  render(<CredentialsSection port={p.personal} sharePort={p.share} />);
  fireEvent.click(await screen.findByTestId(`credential-share-${provider}`));
  await screen.findByLabelText('Ada');
  return p;
}

describe('Share to from connected Agent Credentials', () => {
  it('offers only connected rows; defaults to the current space and preserves the source', async () => {
    const { personal, share } = await open();
    expect(screen.queryByTestId('credential-share-gemini')).toBeNull();
    expect((screen.getByLabelText('Share to space') as HTMLSelectElement).value).toBe('space-a');
    fireEvent.click(screen.getByLabelText('Ada'));
    fireEvent.click(screen.getByRole('button', { name: 'Share to space' }));
    await screen.findByRole('status');
    expect(share.addMine).toHaveBeenCalledExactlyOnceWith('space-a', 'My GitHub');
    expect(share.share).toHaveBeenCalledExactlyOnceWith('space-credential', 'member-one');
    expect(personal.disconnect).not.toHaveBeenCalled();
    expect(personal.startLogin).not.toHaveBeenCalled();
    expect(personal.finishLogin).not.toHaveBeenCalled();
    expect(screen.getByTestId('credential-verdict-github').textContent).toContain('Connected');
  });

  it('creates a private copy with no selected grantees', async () => {
    const { share } = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Share to space' }));
    await screen.findByRole('status');
    expect(share.share).not.toHaveBeenCalled();
  });

  it('clears grantees when the space changes and ignores an old member response', async () => {
    const { share } = await open();
    let resolveMembers!: (rows: Array<{ id: string; name: string }>) => void;
    vi.mocked(share.members).mockImplementationOnce(() => new Promise((resolve) => { resolveMembers = resolve; }));
    fireEvent.click(screen.getByLabelText('Ada'));
    fireEvent.change(screen.getByLabelText('Share to space'), { target: { value: 'space-b' } });
    expect((screen.getByRole('button', { name: 'Share to space' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Share to space'), { target: { value: 'space-a' } });
    await screen.findByLabelText('Ada');
    resolveMembers([{ id: 'foreign', name: 'Wrong space' }]);
    await waitFor(() => expect(screen.queryByLabelText('Wrong space')).toBeNull());
    expect((screen.getByLabelText('Ada') as HTMLInputElement).checked).toBe(false);
  });

  it('retries only failed members on the same saved credential', async () => {
    const { share } = await open();
    vi.mocked(share.share).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('member left'));
    fireEvent.click(screen.getByLabelText('Ada'));
    fireEvent.click(screen.getByLabelText('Noor'));
    fireEvent.click(screen.getByRole('button', { name: 'Share to space' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Successful shares are saved');
    fireEvent.click(screen.getByRole('button', { name: 'Retry sharing' }));
    await screen.findByRole('button', { name: 'Done' });
    expect(share.addMine).toHaveBeenCalledTimes(1);
    expect(vi.mocked(share.share).mock.calls).toEqual([
      ['space-credential', 'member-one'], ['space-credential', 'member-two'], ['space-credential', 'member-two'],
    ]);
  });

  for (const provider of ['anthropic', 'openai'] as const) {
    it(`${provider} starts a fresh space login and grants only after a successful finish`, async () => {
      const { share, personal } = await open(provider);
      fireEvent.click(screen.getByLabelText('Ada'));
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to share' }));
      await screen.findByTestId('share-terminal');
      expect(share.startPrivateLogin).toHaveBeenCalledWith('space-a', provider, expect.any(String));
      expect(personal.startLogin).not.toHaveBeenCalled();
      expect(share.addMine).not.toHaveBeenCalled();
      expect(share.share).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'I’ve finished signing in' }));
      await screen.findByRole('button', { name: 'Done' });
      expect(share.share).toHaveBeenCalledExactlyOnceWith('space-credential', 'member-one');
    });
  }

  it('does not share a failed login', async () => {
    const { share } = await open('anthropic');
    vi.mocked(share.finishLogin).mockResolvedValueOnce({ workSessionId: 'fresh-space-login', provider: 'anthropic', connected: false, stored: false, terminated: true, status: 'revoked', login: null, authMethod: null, spaceCredential: { ...credential, status: 'pending' } });
    fireEvent.click(screen.getByLabelText('Ada'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to share' }));
    fireEvent.click(await screen.findByRole('button', { name: 'I’ve finished signing in' }));
    await screen.findByRole('alert');
    expect(share.share).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Retry sharing' })).toBeNull();
  });
});

describe('Share-to adapter', () => {
  function adapter() {
    const seam = {
      spaces: vi.fn(async () => []),
      identity: vi.fn(async () => ({ memberships: [{ spaceId: 'space-a', memberId: 'self' }] })),
      query: vi.fn().mockResolvedValueOnce({ page: { items: [{ id: 'self', title: 'Me' }, { id: 'member-one', title: 'Ada' }, { id: 'former-member', title: 'Left', state: { memberStatus: 'left' } }], nextCursor: 'next' } }).mockResolvedValueOnce({ page: { items: [{ id: 'member-two', title: 'Noor' }] } }),
      credentials: {
        startLogin: vi.fn(async () => started), finishLogin: vi.fn(),
        space: { claim: vi.fn(), setVisibility: vi.fn(), remove: vi.fn(), share: vi.fn(), addMine: vi.fn() },
      },
    };
    return { seam, port: credentialsSharePortFromSeam(seam as never, 'space-a') };
  }
  it('pages space members, excludes self, and passes member IDs unchanged to the RPC', async () => {
    const { seam, port } = adapter();
    expect(await port.members('space-a')).toEqual([{ id: 'member-one', name: 'Ada' }, { id: 'member-two', name: 'Noor' }]);
    expect(seam.query).toHaveBeenLastCalledWith(expect.objectContaining({ spaceId: 'space-a', cursor: 'next', limit: 100 }));
    await port.share('credential', 'member-two');
    expect(seam.credentials.space.share).toHaveBeenCalledWith('credential', 'member-two');
  });
  it('claims and makes a new login private before exposing it', async () => {
    const { seam, port } = adapter();
    await port.startPrivateLogin('space-a', 'anthropic', 'Mine');
    expect(seam.credentials.startLogin).toHaveBeenCalledWith('space-a', 'anthropic', { label: 'Mine' });
    expect(seam.credentials.space.claim).toHaveBeenCalledExactlyOnceWith(credential.id);
    expect(seam.credentials.space.setVisibility).toHaveBeenCalledExactlyOnceWith(credential.id, 'private');
    expect(seam.credentials.space.remove).not.toHaveBeenCalled();
  });
  it('removes only the newly created pending credential if privacy setup fails', async () => {
    const { seam, port } = adapter();
    seam.credentials.space.setVisibility.mockRejectedValueOnce(new Error('cannot make private'));
    await expect(port.startPrivateLogin('space-a', 'openai', 'Mine')).rejects.toThrow('cannot make private');
    expect(seam.credentials.space.remove).toHaveBeenCalledExactlyOnceWith(credential.id);
    expect(seam.credentials.space.share).not.toHaveBeenCalled();
  });
});
