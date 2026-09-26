// @vitest-environment jsdom
/**
 * W4 a4 — the Sessions screens render in account settings ("Your sessions")
 * and in space admin ("Sessions"), through the REAL shell, the REAL port and
 * the fixture seam; revoke re-reads, and a gate revoke takes its pinned
 * children with it. The server's refusal is drawn, not an empty table.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AuthSessionListing } from '@tm8/contract';
import { CollabError } from '@tm8/contract';
import { createFixtureSeam } from '../data';
import { settingsPortFromSeam } from './port';
import { SessionsSection, sessionLabel, sessionTime } from './SessionsSection';
import { SettingsShell } from './SettingsShell';
import { SETTINGS_SECTIONS } from './types';

afterEach(cleanup);

async function shellPort() {
  const seam = createFixtureSeam();
  const spaceId = (await seam.spaces())[0]!.id;
  return settingsPortFromSeam(seam, spaceId);
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
    fireEvent.click(within(body).getByTestId('session-revoke-ses-ada-gate'));
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
    expect((await screen.findByTestId('sessions-revoke-error')).textContent).toContain('session not found');
  });

  it('formats time locale-free and labels a stored link by its space', () => {
    expect(sessionTime('2026-09-01T10:05:59.000Z')).toBe('2026-09-01 10:05 UTC');
    expect(sessionTime(null)).toBe('never');
    const link = { origin: 'link', spaceName: 'Atelier', label: 'x' } as AuthSessionListing;
    expect(sessionLabel(link)).toBe('stored in Atelier');
  });
});
