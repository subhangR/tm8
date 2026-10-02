// @vitest-environment jsdom
/**
 * W4 a4 — the Sessions screens render in account settings ("Your sessions")
 * and in space admin ("Sessions"), through the REAL shell, the REAL port and
 * the fixture seam; revoke re-reads, and a gate revoke takes its pinned
 * children with it. The server's refusal is drawn, not an empty table.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AuthSessionListing } from '@tm8/contract';
import { CollabError } from '@tm8/contract';
import { signOutOfServer } from '../auth/session';
import { readServerPass, writeServerPass } from '../auth/pass-store';
import { createFixtureSeam } from '../data';
import { settingsPortFromSeam } from './port';
import { SessionsSection, sessionLabel, sessionTime } from './SessionsSection';
import { SettingsShell } from './SettingsShell';
import { SETTINGS_SECTIONS } from './types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function shellPort(opts: { signOut?: () => void } = {}) {
  const seam = createFixtureSeam();
  const spaceId = (await seam.spaces())[0]!.id;
  return settingsPortFromSeam(seam, spaceId, opts);
}

/** Two clicks: the first arms the row, the second revokes. */
function revokeRow(scope: HTMLElement, sessionId: string): void {
  fireEvent.click(within(scope).getByTestId(`session-revoke-${sessionId}`));
  fireEvent.click(within(scope).getByTestId(`session-revoke-${sessionId}`));
}

function listing(sessionId: string, over: Partial<AuthSessionListing> = {}): AuthSessionListing {
  return {
    sessionId, kind: 'browser', createdAt: '2026-09-01T10:00:00.000Z', lastUsedAt: null,
    expiresAt: '2026-10-01T10:00:00.000Z', label: null, spaceId: null, spaceName: null,
    parentSessionId: null, origin: 'login', originEntityId: null,
    owner: { identityId: 'i1', displayName: null }, current: false,
    ...over,
  };
}

describe('Sessions screens (W4 a4)', () => {
  it('both sections are in the settings nav: Your sessions (account) and Sessions (space admin)', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(ids).toContain('my-sessions');
    expect(ids).toContain('sessions');
    expect(ids.indexOf('my-sessions')).toBe(ids.indexOf('account') + 1);
  });

  it('account settings: Your sessions lists the viewer\'s sessions with kind, created, last used, label, origin', async () => {
    render(<SettingsShell port={await shellPort()} initialSection="my-sessions" />);
    const body = await screen.findByTestId('sessions-own-body');
    for (const header of ['Kind', 'Created', 'Last used', 'Label', 'Origin', 'Space']) {
      expect(within(body).getByRole('columnheader', { name: header })).toBeTruthy();
    }
    expect(within(body).getByTestId('session-row-ses-ada-tab').textContent).toContain('this browser');
    expect(within(body).getByTestId('session-row-ses-ada-cli').textContent).toContain('laptop');
    expect(within(body).getByTestId('session-row-ses-ada-gate').textContent).toContain('sign-in');
  });

  it('revoking a gate login re-reads the list and its pinned child is gone too', async () => {
    render(<SettingsShell port={await shellPort()} initialSection="my-sessions" />);
    const body = await screen.findByTestId('sessions-own-body');
    revokeRow(body, 'ses-ada-gate');
    await waitFor(() => expect(screen.queryByTestId('session-row-ses-ada-gate')).toBeNull());
    expect(screen.queryByTestId('session-row-ses-ada-tab')).toBeNull();
    expect(screen.getByTestId('session-row-ses-ada-cli')).toBeTruthy();
  });

  it('space admin: Sessions lists only the sessions pinned to this space, with who holds them', async () => {
    render(<SettingsShell port={await shellPort()} initialSection="sessions" />);
    const body = await screen.findByTestId('sessions-space-body');
    expect(within(body).getByRole('columnheader', { name: 'Who' })).toBeTruthy();
    expect(within(body).getByTestId('session-row-ses-ada-tab').textContent).toContain('Ada');
    expect(within(body).queryByTestId('session-row-ses-ada-cli')).toBeNull();
    expect(within(body).queryByTestId('session-row-ses-ada-gate')).toBeNull();
  });

  it('a non-admin sees the server\'s refusal, not an empty table', async () => {
    render(
      <SessionsSection
        heading="Sessions"
        scope="space"
        load={async () => { throw new CollabError('forbidden', 'only a space admin can list its sessions'); }}
      />,
    );
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    expect(screen.getByText(/only a space admin can list its sessions/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('a refused revoke is drawn beside the list', async () => {
    const row: AuthSessionListing = {
      sessionId: 's1', kind: 'cli', createdAt: '2026-09-01T10:00:00.000Z', lastUsedAt: null,
      expiresAt: '2026-10-01T10:00:00.000Z', label: null, spaceId: null, spaceName: null,
      parentSessionId: null, origin: 'login', originEntityId: null,
      owner: { identityId: 'i1', displayName: null }, current: false,
    };
    render(
      <SessionsSection
        heading="Your sessions"
        scope="own"
        load={async () => ({ spaceId: null, sessions: [row] })}
        revoke={async () => { throw new CollabError('not_found', 'session not found'); }}
      />,
    );
    fireEvent.click(await screen.findByTestId('session-revoke-s1'));
    fireEvent.click(screen.getByTestId('session-revoke-s1'));
    expect((await screen.findByTestId('sessions-revoke-error')).textContent).toContain('session not found');
  });

  it('formats time locale-free and labels a stored link by its space', () => {
    expect(sessionTime('2026-09-01T10:05:59.000Z')).toBe('2026-09-01 10:05 UTC');
    expect(sessionTime(null)).toBe('never');
    const link = { origin: 'link', spaceName: 'Atelier', label: 'x' } as AuthSessionListing;
    expect(sessionLabel(link)).toBe('stored in Atelier');
  });
});

describe('revoke asks first (task 01a0dc09 a3)', () => {
  it('the first click only arms the row; the server is called on the second', async () => {
    const revoke = vi.fn(async (id: string) => ({ sessionId: id, revoked: true, revokedSessionIds: [id] }));
    render(
      <SessionsSection
        heading="Your sessions"
        scope="own"
        load={async () => ({ spaceId: null, sessions: [listing('s1')] })}
        revoke={revoke}
      />,
    );
    const button = await screen.findByTestId('session-revoke-s1');
    expect(button.textContent).toBe('revoke');

    fireEvent.click(button);
    expect(revoke).not.toHaveBeenCalled();
    expect(screen.getByTestId('session-revoke-s1').textContent).toBe('confirm revoke');

    fireEvent.click(screen.getByTestId('session-revoke-s1'));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('s1'));
  });

  it('cancel disarms the row without calling the server', async () => {
    const revoke = vi.fn(async (id: string) => ({ sessionId: id, revoked: true, revokedSessionIds: [id] }));
    render(
      <SessionsSection
        heading="Your sessions"
        scope="own"
        load={async () => ({ spaceId: null, sessions: [listing('s1'), listing('s2')] })}
        revoke={revoke}
      />,
    );
    fireEvent.click(await screen.findByTestId('session-revoke-s1'));
    fireEvent.click(screen.getByTestId('session-revoke-cancel-s1'));
    expect(screen.getByTestId('session-revoke-s1').textContent).toBe('revoke');
    expect(screen.queryByTestId('session-revoke-cancel-s1')).toBeNull();

    /* Arming another row disarms this one: one armed row at a time. */
    fireEvent.click(screen.getByTestId('session-revoke-s1'));
    fireEvent.click(screen.getByTestId('session-revoke-s2'));
    expect(screen.getByTestId('session-revoke-s1').textContent).toBe('revoke');
    expect(screen.getByTestId('session-revoke-s2').textContent).toBe('confirm revoke');
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe('revoking this browser\'s own session signs out (task 01a0dc09 a2)', () => {
  const current = listing('cur', { current: true, label: 'this tab' });
  const other = listing('other');

  it('"sign out here" runs the host sign-out and never re-reads with the dead pass', async () => {
    const load = vi.fn(async () => ({ spaceId: null, sessions: [current, other] }));
    const signOutHere = vi.fn();
    render(
      <SessionsSection
        heading="Your sessions"
        scope="own"
        load={load}
        revoke={async (id) => ({ sessionId: id, revoked: true, revokedSessionIds: [id] })}
        signOutHere={signOutHere}
      />,
    );
    const button = await screen.findByTestId('session-revoke-cur');
    expect(button.textContent).toBe('sign out here');
    fireEvent.click(button);
    expect(screen.getByTestId('session-revoke-cur').textContent).toBe('confirm sign out');
    fireEvent.click(screen.getByTestId('session-revoke-cur'));

    await waitFor(() => expect(signOutHere).toHaveBeenCalledTimes(1));
    /* The mount read only: a re-read would carry the revoked token and 401. */
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/could not be read/)).toBeNull();
  });

  it('a revoke that cascades onto this browser\'s session (its gate login) signs out too', async () => {
    const signOutHere = vi.fn();
    const load = vi.fn(async () => ({ spaceId: null, sessions: [listing('gate'), listing('tab', { current: true, parentSessionId: 'gate' })] }));
    render(
      <SessionsSection
        heading="Your sessions"
        scope="own"
        load={load}
        revoke={async (id) => ({ sessionId: id, revoked: true, revokedSessionIds: [id, 'tab'] })}
        signOutHere={signOutHere}
      />,
    );
    revokeRow(await screen.findByTestId('sessions-own-body'), 'gate');
    await waitFor(() => expect(signOutHere).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('revoking someone else\'s session re-reads and does not sign out (the twin that makes the above fail if sign-out were unconditional)', async () => {
    const signOutHere = vi.fn();
    const load = vi.fn(async () => ({ spaceId: null, sessions: [current, other] }));
    render(
      <SessionsSection
        heading="Your sessions"
        scope="own"
        load={load}
        revoke={async (id) => ({ sessionId: id, revoked: true, revokedSessionIds: [id] })}
        signOutHere={signOutHere}
      />,
    );
    revokeRow(await screen.findByTestId('sessions-own-body'), 'other');
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(signOutHere).not.toHaveBeenCalled();
  });

  it('through the real shell and port: the gate revoke that ends this tab calls the host\'s sign-out', async () => {
    const signOut = vi.fn();
    render(<SettingsShell port={await shellPort({ signOut })} initialSection="my-sessions" />);
    revokeRow(await screen.findByTestId('sessions-own-body'), 'ses-ada-gate');
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it('with the real sign-out as the host\'s: the stored pass is cleared, so nothing reconnects with it', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    });
    /* The logout revoke is fire-and-forget; it must not decide this test. */
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"data":{}}') })));
    writeServerPass('local', {
      token: 'tm8s_cur.secret',
      account: { handle: 'ada', displayName: 'Ada', accountId: 'acct_1', identityId: 'i1', isOwner: false, isNodeAdmin: false },
      sessionId: 'cur',
      expiresAt: '2027-01-01T00:00:00.000Z',
      signedInAt: '2026-09-01T10:00:00.000Z',
    });
    expect(readServerPass('local')).not.toBeNull();

    render(
      <SessionsSection
        heading="Your sessions"
        scope="own"
        load={async () => ({ spaceId: null, sessions: [current, other] })}
        revoke={async (id) => ({ sessionId: id, revoked: true, revokedSessionIds: [id] })}
        signOutHere={signOutOfServer}
      />,
    );
    revokeRow(await screen.findByTestId('sessions-own-body'), 'cur');
    await waitFor(() => expect(readServerPass('local')).toBeNull());
  });
});
