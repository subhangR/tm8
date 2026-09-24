// @vitest-environment jsdom
/**
 * SC-5 — Settings → Space credentials and Settings → Node credentials.
 *
 * Held here, each with a control that goes red without it:
 * - grouped by provider, default badge, creator, last used (t5-1)
 * - D11: manage controls only for the creator and space admins (t5-1)
 * - D5 policy toggles: live for a space admin, greyed out WITH a reason for
 *   everyone else; node-forbidden shown (t5-1)
 * - D6a: no default is said wherever it is true, and plainly after deleting
 *   the default
 * - A7: a label held by a pending login is explained, and blocks the save
 * - #681 D: a 403 reads as a refusal, with no probe spinner left behind
 * - I5 / t5-2: the key is never rendered or logged, and the field is emptied
 *   on save — and on failure
 * - login_open with a past expires_at reads "expired: close it"
 * - Node: env-key presence and the fallback toggle for a node admin only
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollabError } from '@tm8/contract';
import type {
  CredentialPolicySource,
  CredentialsSpacePolicyView,
  NodeCredentialsStatusView,
  SpaceCredentialView,
} from '@tm8/contract';
import { SpaceCredentialsSection, SPACE_LOGIN_STUB_REASON } from './SpaceCredentialsSection';
import { NodeCredentialsSection, NODE_POLICY_ADMIN_ONLY } from './NodeCredentialsSection';
import type { SpaceCredentialsPort, SpaceCredentialsViewer } from './space-port';
import { isSpaceAdminRole, spaceCredentialsPortFromSeam } from './space-port';
import {
  afterDeleteNotice,
  canManage,
  failureOf,
  labelTakenReason,
  loginOpenNoticeOf,
  noDefaultNotice,
  toggleSource,
  validateSecret,
} from './space-credentials-model';

const KEY = 'sk-ant-api03-SECRETVALUE0123456789abcdWXYZ';
const ME = 'acct-me';
const OTHER = 'acct-other';

function row(over: Partial<SpaceCredentialView>): SpaceCredentialView {
  return {
    id: 'c-x',
    spaceId: 'space-1',
    provider: 'anthropic',
    shape: 'api_key',
    label: 'Row',
    isDefault: false,
    status: 'active',
    createdByAccountId: ME,
    displayLogin: null,
    keyHint: 'abcd',
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    lastUsedAt: null,
    lastProbeAt: null,
    ...over,
  };
}

const MINE_DEFAULT = row({ id: 'c-mine', label: 'Team Claude', isDefault: true, lastUsedAt: '2026-09-22T08:30:00.000Z' });
const THEIRS = row({ id: 'c-theirs', label: 'Research budget', createdByAccountId: OTHER, status: 'stale', keyHint: 'wxyz' });
const ORPHAN_OPENAI = row({ id: 'c-openai', provider: 'openai', label: 'Codex shared', createdByAccountId: null });
const GITHUB = row({ id: 'c-gh', provider: 'github', shape: 'token', label: 'tm8-bot', isDefault: true, displayLogin: 'tm8-bot' });
const PENDING = row({ id: 'c-pending', label: 'Held label', status: 'pending', shape: 'login', keyHint: null, createdByAccountId: OTHER });

const POLICY: CredentialsSpacePolicyView = {
  spaceId: 'space-1',
  providers: [
    { provider: 'anthropic', allowedSources: null },
    { provider: 'openai', allowedSources: ['space'] },
    { provider: 'github', allowedSources: null },
  ],
  node: [{ provider: 'github', allowNode: false }],
};

const NODE_STATUS: NodeCredentialsStatusView = {
  providers: [
    { provider: 'anthropic', allowNode: null, envKeyPresent: true },
    { provider: 'openai', allowNode: null, envKeyPresent: false },
    { provider: 'github', allowNode: false, envKeyPresent: true },
  ],
};

function fakePort(opts: {
  viewer?: SpaceCredentialsViewer;
  rows?: SpaceCredentialView[];
  policy?: CredentialsSpacePolicyView;
} = {}) {
  let rows = [...(opts.rows ?? [MINE_DEFAULT, THEIRS, ORPHAN_OPENAI, GITHUB])];
  let policy = structuredClone(opts.policy ?? POLICY);
  const viewer = opts.viewer ?? { accountId: ME, isSpaceAdmin: false, isNodeAdmin: false };
  const port = {
    viewer: vi.fn(async () => viewer),
    list: vi.fn(async () => rows.map((r) => ({ ...r }))),
    create: vi.fn(async (input: { provider: SpaceCredentialView['provider']; shape: 'api_key' | 'token'; label: string; secret: string }) => {
      const created = row({ id: `c-${rows.length + 1}`, provider: input.provider, shape: input.shape, label: input.label, keyHint: input.secret.slice(-4) });
      rows = [...rows, created];
      return created;
    }),
    rekey: vi.fn(async (id: string, secret: string) => {
      rows = rows.map((r) => (r.id === id ? { ...r, keyHint: secret.slice(-4), status: 'active' as const } : r));
      return rows.find((r) => r.id === id)!;
    }),
    rename: vi.fn(async (id: string, label: string) => {
      rows = rows.map((r) => (r.id === id ? { ...r, label } : r));
      return rows.find((r) => r.id === id)!;
    }),
    setDefault: vi.fn(async (id: string) => {
      const target = rows.find((r) => r.id === id)!;
      rows = rows.map((r) => (r.provider === target.provider ? { ...r, isDefault: r.id === id } : r));
      return rows.find((r) => r.id === id)!;
    }),
    remove: vi.fn(async (id: string) => {
      rows = rows.filter((r) => r.id !== id);
      return { credentialId: id, revoked: true, terminatedLoginSessionIds: [], terminatedAgentSessionIds: ['s-1', 's-2'], failures: [] };
    }),
    policy: vi.fn(async () => structuredClone(policy)),
    setPolicy: vi.fn(async (provider: SpaceCredentialView['provider'], allowedSources: CredentialPolicySource[] | null) => {
      policy = { ...policy, providers: policy.providers.map((p) => (p.provider === provider ? { provider, allowedSources } : p)) };
      return { spaceId: 'space-1', provider, allowedSources };
    }),
    nodeStatus: vi.fn(async () => structuredClone(NODE_STATUS)),
    setNodePolicy: vi.fn(async (provider: SpaceCredentialView['provider'], allowNode: boolean | null) => ({ provider, allowNode })),
  } satisfies SpaceCredentialsPort;
  return port;
}

async function mount(port: SpaceCredentialsPort) {
  render(<SpaceCredentialsSection port={port} />);
  await screen.findByTestId('space-cred-group-anthropic');
  // Let the viewer read settle too.
  await act(async () => {});
}

afterEach(() => vi.restoreAllMocks());

describe('Space credentials — the list (t5-1)', () => {
  it('groups by provider with default badge, creator and last used, and hides revoked rows', async () => {
    const revoked = row({ id: 'c-revoked', label: 'Gone', status: 'revoked' });
    await mount(fakePort({ rows: [MINE_DEFAULT, THEIRS, ORPHAN_OPENAI, GITHUB, revoked] }));

    const anthropic = screen.getByTestId('space-cred-group-anthropic');
    const mine = within(anthropic).getByTestId('space-cred-row-c-mine');
    expect(within(mine).getByText('default')).toBeTruthy();
    expect(mine.textContent).toContain('added by you');
    expect(mine.textContent).toContain('last used 2026-09-22 08:30 UTC');
    expect(mine.textContent).toContain('ends …abcd');
    const theirs = within(anthropic).getByTestId('space-cred-row-c-theirs');
    expect(theirs.textContent).toContain('added by another member');
    expect(theirs.textContent).toContain('last used never');
    expect(theirs.textContent).toContain('failed its last check');

    const openai = screen.getByTestId('space-cred-group-openai');
    expect(within(openai).getByTestId('space-cred-row-c-openai').textContent)
      .toContain('added by the space (its creator has left; admins manage it)');
    expect(within(screen.getByTestId('space-cred-group-github')).getByText('as tm8-bot')).toBeTruthy();

    expect(screen.queryByText('Gone')).toBeNull();
  });
});

describe('D11 — who sees edit and delete (t5-1)', () => {
  it('a plain member manages their own credential and only reads someone else’s', async () => {
    await mount(fakePort({ viewer: { accountId: ME, isSpaceAdmin: false, isNodeAdmin: false } }));
    expect(screen.getByRole('button', { name: 'Delete Team Claude' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rename Team Claude' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete Research budget' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename Research budget' })).toBeNull();
    expect(screen.getByTestId('space-cred-readonly-c-theirs').textContent)
      .toMatch(/Only its creator or a space admin can change it/);
    // Creator gone (D12): only admins manage it.
    expect(screen.queryByRole('button', { name: 'Delete Codex shared' })).toBeNull();
  });

  it('a space admin manages every credential, including one whose creator has left', async () => {
    await mount(fakePort({ viewer: { accountId: 'acct-admin', isSpaceAdmin: true, isNodeAdmin: false } }));
    for (const label of ['Team Claude', 'Research budget', 'Codex shared', 'tm8-bot']) {
      expect(screen.getByRole('button', { name: `Delete ${label}` })).toBeTruthy();
    }
  });

  it('an unknown viewer (identity read failed) manages nothing', () => {
    expect(canManage(MINE_DEFAULT, null)).toBe(false);
    expect(canManage(ORPHAN_OPENAI, { accountId: ME, isSpaceAdmin: false, isNodeAdmin: false })).toBe(false);
  });

  it('the space-admin word mirrors the server: owner and admin, nobody else', () => {
    expect(isSpaceAdminRole('owner', 'owner')).toBe(true);
    expect(isSpaceAdminRole('admin', 'owner')).toBe(true);
    expect(isSpaceAdminRole('member', 'owner')).toBe(false);
    expect(isSpaceAdminRole(null, 'owner')).toBe(false);
  });
});

describe('D5 policy toggles — greyed out with a reason (t5-1)', () => {
  it('for a plain member every toggle is aria-disabled with the reason, and a click writes nothing', async () => {
    const port = fakePort();
    await mount(port);
    const toggle = screen.getByRole('checkbox', { name: 'Claude (Anthropic) allows Node' });
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(toggle.getAttribute('title')).toBe('Only a space admin changes this policy.');
    fireEvent.click(toggle);
    expect(port.setPolicy).not.toHaveBeenCalled();
    expect(within(screen.getByTestId('space-cred-policy-anthropic')).getByText('Only a space admin changes this policy.')).toBeTruthy();
  });

  it('shows the current policy: openai requires the space source', async () => {
    await mount(fakePort());
    expect((screen.getByRole('checkbox', { name: 'Codex (OpenAI) allows Space' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Codex (OpenAI) allows Yours' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Codex (OpenAI) allows Node' }) as HTMLInputElement).checked).toBe(false);
  });

  it('a space admin switches a source off, and the last allowed source is greyed with its reason', async () => {
    const port = fakePort({ viewer: { accountId: ME, isSpaceAdmin: true, isNodeAdmin: false } });
    await mount(port);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Claude (Anthropic) allows Node' }));
    await waitFor(() => expect(port.setPolicy).toHaveBeenCalledWith('anthropic', ['member', 'space']));
    const last = screen.getByRole('checkbox', { name: 'Codex (OpenAI) allows Space' });
    expect(last.getAttribute('aria-disabled')).toBe('true');
    expect(last.getAttribute('title')).toBe('At least one source must stay allowed.');
  });

  it('says when the node admin has forbidden node fallback', async () => {
    await mount(fakePort());
    expect(screen.getByTestId('space-cred-node-forbidden-github').textContent).toMatch(/node admin has turned node fallback off/);
    expect(screen.queryByTestId('space-cred-node-forbidden-anthropic')).toBeNull();
  });

  it('all three on is stored as no policy', () => {
    expect(toggleSource(['member', 'space'], 'node')).toBeNull();
    expect(toggleSource(['member', 'space', 'node'], 'member')).toEqual(['space', 'node']);
  });
});

describe('D6a — no default', () => {
  it('says so wherever a provider has credentials and no default', async () => {
    await mount(fakePort());
    expect(screen.getByTestId('space-cred-no-default-openai').textContent).toMatch(/Codex \(OpenAI\) has no space default/);
    expect(screen.queryByTestId('space-cred-no-default-anthropic')).toBeNull();
    // No credentials at all is "none yet", not "no default".
    expect(noDefaultNotice('openai', [])).toBeNull();
  });

  it('after deleting the default, says plainly that nothing was promoted, and keeps saying it', async () => {
    const port = fakePort();
    await mount(port);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Team Claude' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Team Claude' }));
    const notice = await screen.findByTestId('space-cred-notice');
    expect(notice.textContent).toMatch(/It was the default, so Claude \(Anthropic\) now has NO default: nothing was promoted/);
    expect(notice.textContent).toMatch(/2 live sessions using it were ended/);
    expect(port.remove).toHaveBeenCalledWith('c-mine');
    // The stale row that remains is NOT made the default by the screen either.
    expect(await screen.findByTestId('space-cred-no-default-anthropic')).toBeTruthy();
    expect(port.setDefault).not.toHaveBeenCalled();
  });

  it('deleting a non-default says nothing about defaults', () => {
    expect(afterDeleteNotice(THEIRS, 0)).toBe('Deleted “Research budget”.');
  });
});

describe('A7 — why a label is taken', () => {
  it('a pending login holds its label until it finishes or expires, and the save is blocked', async () => {
    const port = fakePort({ rows: [MINE_DEFAULT, PENDING] });
    await mount(port);
    fireEvent.click(screen.getByRole('button', { name: 'Add Claude (Anthropic) API key' }));
    fireEvent.change(screen.getByLabelText('Label for the new Claude (Anthropic) API key'), { target: { value: 'Held label' } });
    fireEvent.change(screen.getByLabelText('Claude (Anthropic) API key'), { target: { value: KEY } });
    expect(screen.getByTestId('space-cred-label-taken').textContent)
      .toMatch(/a login that has not finished is holding it\. A pending login keeps its label until it completes or expires/);
    expect((screen.getByRole('button', { name: 'Save new Claude (Anthropic) API key' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a pending login row offers no key replacement: a login is renewed by logging in', async () => {
    // 206 forbids a pending row that is not a login, and the server refuses a
    // rekey on a login; the screen must not offer the paste either.
    await mount(fakePort({ viewer: { accountId: 'acct-admin', isSpaceAdmin: true, isNodeAdmin: false }, rows: [MINE_DEFAULT, PENDING] }));
    expect(screen.getByRole('button', { name: 'Delete Held label' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Replace API key Held label' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set default Held label' })).toBeNull();
    expect(screen.getByTestId('space-cred-row-c-pending').textContent).toContain('login not finished');
  });

  it('an active clash names the other credential; another provider’s label is free', () => {
    expect(labelTakenReason('anthropic', 'Team Claude', [MINE_DEFAULT])).toMatch(/another Claude \(Anthropic\) credential/);
    expect(labelTakenReason('openai', 'Team Claude', [MINE_DEFAULT])).toBeNull();
    expect(labelTakenReason('anthropic', 'Team Claude', [MINE_DEFAULT], 'c-mine')).toBeNull();
  });
});

describe('I5 / t5-2 — the key is never rendered and the field is cleared', () => {
  it('adds by key: the field is a password field, emptied on save, and the key appears nowhere', async () => {
    const logs: unknown[][] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args); });
    }
    const port = fakePort();
    await mount(port);
    fireEvent.click(screen.getByRole('button', { name: 'Add Claude (Anthropic) API key' }));
    fireEvent.change(screen.getByLabelText('Label for the new Claude (Anthropic) API key'), { target: { value: 'Night shift' } });
    const field = screen.getByLabelText('Claude (Anthropic) API key') as HTMLInputElement;
    expect(field.type).toBe('password');
    fireEvent.change(field, { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new Claude (Anthropic) API key' }));
    await screen.findByText('Added “Night shift”.');
    expect(port.create).toHaveBeenCalledWith({ provider: 'anthropic', shape: 'api_key', label: 'Night shift', secret: KEY });
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(document.body.innerHTML).not.toContain('SECRETVALUE');
    expect(JSON.stringify(logs)).not.toContain('SECRETVALUE');
    // Re-opened, the field starts empty.
    fireEvent.click(screen.getByRole('button', { name: 'Add Claude (Anthropic) API key' }));
    expect((screen.getByLabelText('Claude (Anthropic) API key') as HTMLInputElement).value).toBe('');
  });

  it('a vendor rejection empties the field too, and says nothing was stored', async () => {
    const port = fakePort();
    port.create.mockRejectedValueOnce(new CollabError('invalid_input', 'the vendor rejected the key', { details: { reason: 'credential_rejected' } }));
    await mount(port);
    fireEvent.click(screen.getByRole('button', { name: 'Add Claude (Anthropic) API key' }));
    fireEvent.change(screen.getByLabelText('Label for the new Claude (Anthropic) API key'), { target: { value: 'Bad' } });
    fireEvent.change(screen.getByLabelText('Claude (Anthropic) API key'), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new Claude (Anthropic) API key' }));
    expect((await screen.findByTestId('space-cred-failure-rejected')).textContent).toMatch(/rejected this key, so nothing was stored/);
    expect((screen.getByLabelText('Claude (Anthropic) API key') as HTMLInputElement).value).toBe('');
    expect(document.body.innerHTML).not.toContain('SECRETVALUE');
  });

  it('replacing a key is write-only and cleared on save', async () => {
    const port = fakePort();
    await mount(port);
    fireEvent.click(screen.getByRole('button', { name: 'Replace API key Team Claude' }));
    const field = screen.getByLabelText('New API key for Team Claude') as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.value).toBe('');
    fireEvent.change(field, { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: 'Save API key Team Claude' }));
    await screen.findByText(/Replaced the API key on “Team Claude”/);
    expect(port.rekey).toHaveBeenCalledWith('c-mine', KEY);
    expect(screen.queryByLabelText('New API key for Team Claude')).toBeNull();
    expect(document.body.innerHTML).not.toContain('SECRETVALUE');
  });

  it('a key replacement the vendor rejects empties the still-open field, and the key appears nowhere', async () => {
    const port = fakePort();
    port.rekey.mockRejectedValueOnce(new CollabError('invalid_input', 'the anthropic key was refused by the vendor; nothing was stored', { details: { reason: 'credential_rejected' } }));
    await mount(port);
    fireEvent.click(screen.getByRole('button', { name: 'Replace API key Team Claude' }));
    fireEvent.change(screen.getByLabelText('New API key for Team Claude'), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: 'Save API key Team Claude' }));
    expect((await screen.findByTestId('space-cred-failure-rejected')).textContent).toMatch(/rejected this key, so nothing was stored/);
    expect((screen.getByLabelText('New API key for Team Claude') as HTMLInputElement).value).toBe('');
    expect(document.body.innerHTML).not.toContain('SECRETVALUE');
  });

  it('secret validation never quotes the draft', () => {
    for (const bad of ['Qz9k', 'Qz9kPw has space', 'Qz9k'.repeat(1300)]) {
      const reason = validateSecret(bad);
      expect(reason).not.toBeNull();
      expect(reason).not.toContain(bad);
    }
    expect(validateSecret(KEY)).toBeNull();
  });
});

describe('#681 D — a 403 is a refusal, not a probe', () => {
  it('shows the refusal reason and leaves no probe spinner', async () => {
    const port = fakePort();
    let reject: (err: unknown) => void = () => {};
    port.rekey.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
    await mount(port);
    fireEvent.click(screen.getByRole('button', { name: 'Replace API key Team Claude' }));
    fireEvent.change(screen.getByLabelText('New API key for Team Claude'), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: 'Save API key Team Claude' }));
    await act(async () => { reject(new CollabError('forbidden', 'only the creator or a space admin can rekey this credential')); });
    const refusal = await screen.findByTestId('space-cred-failure-refused');
    expect(refusal.textContent).toBe('Refused: only the creator or a space admin can rekey this credential');
    expect(screen.queryByTestId('space-cred-probe')).toBeNull();
    expect(screen.queryByTestId('space-cred-failure-rejected')).toBeNull();
    // I5: a refused key does not sit in the still-open field waiting to be re-sent.
    expect((screen.getByLabelText('New API key for Team Claude') as HTMLInputElement).value).toBe('');
    expect(document.body.innerHTML).not.toContain('SECRETVALUE');
  });

  it('a policy write refused for a non-manager surfaces its reason', async () => {
    const port = fakePort({ viewer: { accountId: ME, isSpaceAdmin: true, isNodeAdmin: false } });
    port.setPolicy.mockRejectedValueOnce(new CollabError('forbidden', 'space admin required'));
    await mount(port);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Claude (Anthropic) allows Node' }));
    expect((await screen.findByTestId('space-cred-failure-refused')).textContent).toBe('Refused: space admin required');
  });

  it('classifies probe answers apart from refusals', () => {
    expect(failureOf(new CollabError('forbidden', 'no')).kind).toBe('refused');
    expect(failureOf(new CollabError('upstream_unavailable', 'x', { details: { reason: 'credential_probe_unreachable' } })).kind).toBe('unreachable');
  });
});

describe('login_open — an expired terminal reads "expired: close it"', () => {
  const now = new Date('2026-09-23T12:00:00.000Z');
  it('a past expires_at is expired, not "wait until"', () => {
    const err = new CollabError('conflict', 'a login onto this credential is open until 2026-09-23 11:00:00+00', {
      details: { reason: 'login_open', expiresAt: '2026-09-23T11:00:00.000Z' },
    });
    const notice = loginOpenNoticeOf(err, now)!;
    expect(notice.expired).toBe(true);
    expect(notice.text).toMatch(/expired at 2026-09-23 11:00 UTC but was never closed: close it/);
  });

  it('a future expires_at is still open', () => {
    const notice = loginOpenNoticeOf({ details: { reason: 'login_open', expiresAt: '2026-09-23T12:10:00.000Z' } }, now)!;
    expect(notice.expired).toBe(false);
    expect(notice.text).toMatch(/already open until 2026-09-23 12:10 UTC/);
  });

  it('anything else is not a login_open', () => {
    expect(loginOpenNoticeOf(new CollabError('forbidden', 'no'), now)).toBeNull();
  });
});

describe('Add by login — a marked stub until SC-4', () => {
  it('is drawn aria-disabled with its reason, for the model vendors only', async () => {
    await mount(fakePort());
    const stub = screen.getByTestId('space-cred-login-stub-anthropic');
    expect(stub.getAttribute('aria-disabled')).toBe('true');
    expect(stub.getAttribute('title')).toBe(SPACE_LOGIN_STUB_REASON);
    expect(screen.queryByTestId('space-cred-login-stub-github')).toBeNull();
  });
});

describe('Node credentials (D9)', () => {
  it('a node admin sees key presence and switches node fallback off', async () => {
    const port = fakePort({ viewer: { accountId: ME, isSpaceAdmin: false, isNodeAdmin: true } });
    render(<NodeCredentialsSection port={port} />);
    expect((await screen.findByTestId('node-cred-env-anthropic')).textContent).toMatch(/holds a key/);
    expect(screen.getByTestId('node-cred-env-openai').textContent).toMatch(/holds no key/);
    const toggle = screen.getByRole('checkbox', { name: 'Allow node fallback for Claude (Anthropic)' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(port.setNodePolicy).toHaveBeenCalledWith('anthropic', false));
    await waitFor(() => expect(within(screen.getByTestId('node-cred-row-anthropic')).getByText('node fallback off')).toBeTruthy());
    // Turning it back on removes the policy rather than writing `true`.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow node fallback for GitHub' }));
    await waitFor(() => expect(port.setNodePolicy).toHaveBeenCalledWith('github', null));
  });

  it('a non-admin sees the fallback state greyed out with the reason, and no key presence', async () => {
    const port = fakePort();
    render(<NodeCredentialsSection port={port} />);
    await screen.findByTestId('node-cred-not-admin');
    await act(async () => {});
    expect(port.nodeStatus).not.toHaveBeenCalled();
    expect(screen.queryByTestId('node-cred-env-anthropic')).toBeNull();
    const toggle = screen.getByRole('checkbox', { name: 'Allow node fallback for GitHub' }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(toggle.getAttribute('title')).toBe(NODE_POLICY_ADMIN_ONLY);
    fireEvent.click(toggle);
    expect(port.setNodePolicy).not.toHaveBeenCalled();
  });
});

describe('the seam adapter', () => {
  it('binds the space, reads the viewer role for THIS space, and passes no account id to any write', async () => {
    const calls: unknown[][] = [];
    const record = (name: string) => vi.fn(async (...args: unknown[]) => { calls.push([name, ...args]); return {} as never; });
    const seam = {
      identity: async () => ({
        accountId: ME,
        isNodeAdmin: true,
        memberships: [{ spaceId: 'other', memberId: 'm0', role: 'owner' }, { spaceId: 'space-1', memberId: 'm1', role: 'member' }],
      }),
      credentials: {
        space: {
          list: vi.fn(async () => ({ spaceId: 'space-1', credentials: [MINE_DEFAULT] })),
          create: record('create'), rekey: record('rekey'), rename: record('rename'), setDefault: record('setDefault'),
          remove: record('remove'), policy: record('policy'), setPolicy: record('setPolicy'),
        },
        node: { status: record('status'), setPolicy: record('nodeSetPolicy') },
      },
    } as unknown as Parameters<typeof spaceCredentialsPortFromSeam>[0];
    const port = spaceCredentialsPortFromSeam(seam, 'space-1' as never, 'owner');
    expect(await port.viewer()).toEqual({ accountId: ME, isSpaceAdmin: false, isNodeAdmin: true });
    expect(await port.list()).toEqual([MINE_DEFAULT]);
    await port.create({ provider: 'anthropic', shape: 'api_key', label: 'L', secret: KEY });
    await port.setPolicy('openai', ['space']);
    expect(calls[0]).toEqual(['create', 'space-1', { provider: 'anthropic', shape: 'api_key', label: 'L', secret: KEY }]);
    expect(calls[1]).toEqual(['setPolicy', 'space-1', 'openai', ['space']]);
  });
});
