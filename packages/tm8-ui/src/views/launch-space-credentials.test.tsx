// @vitest-environment jsdom
/**
 * SC-5 launch picker (design 01a0cfa8 §6): per provider, Yours / Space ▸
 * credential / Node, with every option the policy turns off DRAWN, disabled,
 * and carrying its reason (D5); "no default" said where it is true (D6a);
 * the GitHub authorship line (D10); and the pinned credential id — never an
 * account (I1) — carried into the launch.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import type {
  CredentialsSpacePolicyView,
  CredentialsStatusView,
  EntityId,
  SpaceCredentialView,
} from '@tm8/contract';
import { LaunchSheet } from './LaunchSheet';
import { LAUNCH_CAPACITY, LAUNCH_PROFILES, LAUNCH_PROJECTS, LAUNCH_TEAMMATES } from './launch-fixtures';

const SPACE = 'space-1';

function cred(over: Partial<SpaceCredentialView> & Pick<SpaceCredentialView, 'id' | 'provider' | 'label'>): SpaceCredentialView {
  return {
    spaceId: SPACE,
    shape: over.provider === 'github' ? 'token' : 'api_key',
    isDefault: false,
    status: 'active',
    createdByAccountId: 'acct-1',
    displayLogin: null,
    keyHint: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    lastUsedAt: null,
    lastProbeAt: null,
    ...over,
  } as SpaceCredentialView;
}

const CREDS: SpaceCredentialView[] = [
  cred({ id: 'c-team', provider: 'anthropic', label: 'Team Claude', isDefault: true }),
  cred({ id: 'c-batch', provider: 'anthropic', label: 'Batch Claude' }),
  cred({ id: 'c-pending', provider: 'anthropic', label: 'Half-done login', status: 'pending' }),
  cred({ id: 'g-bot', provider: 'github', label: 'Release bot', isDefault: true, displayLogin: 'tm8-release-bot' }),
];

function policy(over: Partial<CredentialsSpacePolicyView> = {}): CredentialsSpacePolicyView {
  return { spaceId: SPACE, providers: [], node: [], ...over };
}

const status: CredentialsStatusView = {
  providers: [{
    provider: 'github', connected: true, login: 'octocat',
    authMethod: null, status: 'active', connectedAt: null, lastVerifiedAt: null,
  }],
  gitCredentialStore: 'present',
} as CredentialsStatusView;

function renderSheet(props: Partial<React.ComponentProps<typeof LaunchSheet>> = {}) {
  return render(
    <div className="cv2-root">
      <LaunchSheet
        subjectId={'task-1' as EntityId}
        fromChip="◔ Run ▸"
        fromCaption="task pre-associated"
        teammates={LAUNCH_TEAMMATES}
        projects={LAUNCH_PROJECTS}
        profiles={LAUNCH_PROFILES}
        capacity={LAUNCH_CAPACITY}
        spaceId={SPACE}
        loadSpaceCredentials={async (spaceId) => ({ spaceId, credentials: CREDS })}
        loadSpacePolicy={async () => policy()}
        onLaunch={() => {}}
        onCancel={() => {}}
        {...props}
      />
    </div>,
  );
}

function optionsOf(select: HTMLElement) {
  return Array.from((select as HTMLSelectElement).options).map((o) => ({
    value: o.value, text: o.textContent ?? '', disabled: o.disabled, title: o.title,
  }));
}

describe('SC-5 launch picker: sources per provider', () => {
  it('offers Yours, the space default, each usable space credential and Node, in that order', async () => {
    const view = renderSheet();
    const agent = view.getByTestId('launch-agent-credential-source');
    await waitFor(() => expect(agent.textContent).toContain('Team Claude'));
    expect(optionsOf(agent).map((o) => o.value)).toEqual(['', 'member', 'space', 'space:c-team', 'space:c-batch', 'node']);
    expect(agent.textContent).toContain('Space default · Team Claude');
    expect(agent.textContent).toContain('Space ▸ Batch Claude');
    // A pending login is not a credential anyone can launch on yet.
    expect(agent.textContent).not.toContain('Half-done login');
  });

  it('greys out what the space policy turns off, with the reason in the option AND its title (D5)', async () => {
    const view = renderSheet({
      loadSpacePolicy: async () => policy({ providers: [{ provider: 'anthropic', allowedSources: ['space'] }] }),
    });
    const agent = view.getByTestId('launch-agent-credential-source');
    await waitFor(() => expect(optionsOf(agent).find((o) => o.value === 'member')?.disabled).toBe(true));
    const member = optionsOf(agent).find((o) => o.value === 'member')!;
    const node = optionsOf(agent).find((o) => o.value === 'node')!;
    expect(member.text).toContain('off: this space allows only Space');
    expect(member.title).toBe('off: this space allows only Space');
    expect(node.disabled).toBe(true);
    expect(node.text).toContain('off: this space allows only Space');
    expect(optionsOf(agent).find((o) => o.value === 'space:c-batch')?.disabled).toBe(false);
    // A native option clips at the sheet's width: the reason is ALSO drawn in full.
    expect(view.getByTestId('launch-agent-sources-note').textContent)
      .toBe('Unavailable: Yours (this space allows only Space) · Node (this space allows only Space)');
  });

  it('draws no unavailable-note when nothing is off', async () => {
    const view = renderSheet();
    await waitFor(() => expect(view.getByTestId('launch-agent-credential-source').textContent).toContain('Team Claude'));
    expect(view.queryByTestId('launch-agent-sources-note')).toBeNull();
  });

  it('greys out Node when the node admin has turned node fallback off', async () => {
    const view = renderSheet({
      loadSpacePolicy: async () => policy({ node: [{ provider: 'github', allowNode: false }] }),
    });
    const gh = view.getByTestId('launch-github-credential-source');
    await waitFor(() => expect(optionsOf(gh).find((o) => o.value === 'node')?.disabled).toBe(true));
    expect(optionsOf(gh).find((o) => o.value === 'node')?.text).toContain('the node admin has turned node fallback off');
  });

  it('says there is NO space default when credentials exist without one (D6a)', async () => {
    const view = renderSheet({
      loadSpaceCredentials: async (spaceId) => ({
        spaceId, credentials: [cred({ id: 'c-batch', provider: 'anthropic', label: 'Batch Claude' })],
      }),
    });
    const agent = view.getByTestId('launch-agent-credential-source');
    await waitFor(() => expect(agent.textContent).toContain('Batch Claude'));
    const def = optionsOf(agent).find((o) => o.value === 'space')!;
    expect(def.disabled).toBe(true);
    expect(def.text).toContain('this space has no default: pick one below');
    expect(optionsOf(agent).find((o) => o.value === 'space:c-batch')?.disabled).toBe(false);
  });

  it('keeps the Space option drawn, disabled with a reason, when the list cannot be read', async () => {
    const view = renderSheet({ loadSpaceCredentials: async () => { throw new Error('boom'); } });
    const agent = view.getByTestId('launch-agent-credential-source');
    await waitFor(() => expect(agent.textContent).toContain('could not be read'));
    const space = optionsOf(agent).find((o) => o.value === 'space')!;
    expect(space.disabled).toBe(true);
    expect(optionsOf(agent).find((o) => o.value === 'member')?.disabled).toBe(false);
  });

  it('sends the source AND the pinned credential id — an id, never an account (I1)', async () => {
    const onLaunch = vi.fn();
    const view = renderSheet({ onLaunch });
    const agent = view.getByTestId('launch-agent-credential-source');
    await waitFor(() => expect(agent.textContent).toContain('Batch Claude'));
    fireEvent.change(agent, { target: { value: 'space:c-batch' } });
    fireEvent.change(view.getByTestId('launch-github-credential-source'), { target: { value: 'space' } });
    expect(view.getByTestId('launch-agent-identity').textContent).toContain('the space’s “Batch Claude”');
    fireEvent.click(view.getByText('Launch ▸'));
    const sent = onLaunch.mock.calls[0]![0];
    expect(sent.credentialSources).toEqual({ anthropic: 'space', github: 'space' });
    // The default is named by leaving the id out; only the pin travels.
    expect(sent.spaceCredentialIds).toEqual({ anthropic: 'c-batch' });
    expect(JSON.stringify(sent)).not.toContain('acct-1');
  });

  it('sends no spaceCredentialIds when no space credential is pinned', async () => {
    const onLaunch = vi.fn();
    const view = renderSheet({ onLaunch });
    fireEvent.change(view.getByTestId('launch-agent-credential-source'), { target: { value: 'node' } });
    fireEvent.click(view.getByText('Launch ▸'));
    expect(onLaunch.mock.calls[0]![0]).not.toHaveProperty('spaceCredentialIds');
  });
});

describe('SC-5 launch picker: GitHub authorship (D10)', () => {
  it('names the space token’s account when the space token is chosen', async () => {
    const view = renderSheet();
    const gh = view.getByTestId('launch-github-credential-source');
    await waitFor(() => expect(gh.textContent).toContain('Release bot'));
    fireEvent.change(gh, { target: { value: 'space:g-bot' } });
    expect(view.getByTestId('launch-github-authorship').textContent)
      .toBe('Commits and pull requests are authored as @tm8-release-bot (space token “Release bot”)');
  });

  it('follows D4 in Auto: yours when connected, else the space default', async () => {
    const connected = renderSheet({ loadCredentialStatus: async () => status });
    await waitFor(() => expect(connected.getByTestId('launch-github-authorship').textContent)
      .toContain('authored as @octocat (your GitHub) · Auto'));
    connected.unmount();

    const notConnected = renderSheet();
    await waitFor(() => expect(notConnected.getByTestId('launch-github-authorship').textContent)
      .toContain('authored as @tm8-release-bot (space token “Release bot”) · Auto'));
    // Auto is the UI's D4 PREDICTION; the server's resolution is the fact. The
    // line must say so rather than read as a recorded outcome.
    expect(notConnected.getByTestId('launch-github-authorship').textContent)
      .toContain('Auto, expected: the server resolves it at launch, and the session detail records what it used');
  });

  it('says the node account authors when Node is chosen', () => {
    const view = renderSheet();
    fireEvent.change(view.getByTestId('launch-github-credential-source'), { target: { value: 'node' } });
    expect(view.getByTestId('launch-github-authorship').textContent)
      .toBe('Commits and pull requests are authored by this server’s GitHub account');
  });
});
