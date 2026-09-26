// @vitest-environment jsdom
/**
 * W6 — Settings → Space links.
 *
 * Held here, each with a control that goes red without it:
 * - the P8 warning is drawn (shared link visibility; agents act as you)
 * - a link lists with the viewer's own status
 * - Sign in calls `login` and says so — PAIRED WITH the human-only refusal,
 *   which reads as a refusal and shows no success notice
 * - Remove calls `remove`; Allow spawn calls `setSpawn`
 * - the port-from-seam maps every method to its seam call
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollabError } from '@tm8/contract';
import type { SpaceLinkView } from '@tm8/contract';
import { SpaceLinksSection } from './SpaceLinksSection';
import { spaceLinksPortFromSeam, type SpaceLinksPort } from './port';

// Every sentence describes only what W6 ships: the switch is stored, nothing reads it yet.
const SPAWN_OFF_TEXT =
  'Allow spawn is stored per link; it is enforced when cross-space spawn ships.';

afterEach(() => cleanup());

function link(over: Partial<SpaceLinkView> = {}): SpaceLinkView {
  return {
    id: 'link-1',
    homeSpaceId: 'space-1',
    targetSpaceId: 'space-2',
    targetServerId: null,
    targetSpaceName: 'Research',
    createdAt: '2026-09-20T10:00:00.000Z',
    statusSummary: { signedIn: 0, signedOut: 1, left: 0, unreachable: 0 },
    mine: {
      memberId: 'm-me',
      status: 'signed_out',
      allowSpawn: false,
      spawnBudget: 5,
      alias: null,
      sessionId: null,
      expiresAt: null,
      lastUsedAt: null,
    },
    ...over,
  };
}

function fakePort(rows: SpaceLinkView[]) {
  const signedIn = link({ mine: { ...link().mine!, status: 'signed_in' } });
  return {
    list: vi.fn(async () => rows),
    candidates: vi.fn(async () => []),
    add: vi.fn(async () => link()),
    login: vi.fn(async () => signedIn),
    relogin: vi.fn(async () => signedIn),
    logout: vi.fn(async () => link()),
    remove: vi.fn(async () => link({ mine: null })),
    setSpawn: vi.fn(async () => link()),
  } satisfies SpaceLinksPort;
}

describe('SpaceLinksSection', () => {
  it('draws the P8 warning: the link is visible to every member, and agents act as you', async () => {
    render(<SpaceLinksSection port={fakePort([])} />);
    const warning = await screen.findByTestId('space-links-warning');
    expect(warning.textContent).toMatch(/Every member of this space can see that a link to the target space exists/);
    expect(warning.textContent).toMatch(/Only you can use your own sign-in/);
    expect(warning.textContent).toMatch(/Once cross-space spawn ships, agents working for you in this space will be able to act in the target space as you while you are signed in/);
    expect(warning.textContent).toMatch(/Allow spawn/);
    // The stored-switch wording (enforcement arrives with cross-space spawn).
    expect(warning.textContent).toContain(SPAWN_OFF_TEXT);
    // Control: an empty list still draws it.
    expect(await screen.findByTestId('space-links-empty')).toBeTruthy();
  });

  it('lists a link with the target name and my status', async () => {
    render(<SpaceLinksSection port={fakePort([link()])} />);
    expect(await screen.findByText('Research')).toBeTruthy();
    expect(screen.getByTestId('space-link-status-link-1').textContent).toBe('Signed out');
    expect(screen.getByRole('button', { name: 'Sign in to Research' })).toBeTruthy();
  });

  it('a signed-in row offers Sign in again and Sign out instead of Sign in', async () => {
    render(<SpaceLinksSection port={fakePort([link({ mine: { ...link().mine!, status: 'signed_in' } })])} />);
    expect((await screen.findByTestId('space-link-status-link-1')).textContent).toBe('Signed in');
    expect(screen.queryByRole('button', { name: 'Sign in to Research' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in again to Research' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out of Research' })).toBeTruthy();
  });

  it('Sign in calls port.login and reports success (positive)', async () => {
    const port = fakePort([link()]);
    render(<SpaceLinksSection port={port} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to Research' }));
    await waitFor(() => expect(port.login).toHaveBeenCalledWith('link-1'));
    expect((await screen.findByTestId('space-links-notice')).textContent).toBe('Signed in to Research.');
    expect(screen.queryByTestId('space-link-failure-link-1')).toBeNull();
  });

  it('a human-only refusal on Sign in reads as a refusal and claims no success (paired refusal)', async () => {
    const port = fakePort([link()]);
    port.login.mockRejectedValueOnce(
      new CollabError('forbidden', 'space link management is available to human sessions only', {
        details: { reason: 'space_links_human_only' },
      }),
    );
    render(<SpaceLinksSection port={port} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to Research' }));
    const failure = await screen.findByTestId('space-link-failure-link-1');
    expect(failure.textContent).toMatch(/^Refused: /);
    expect(failure.textContent).toMatch(/not by an agent/);
    expect(port.login).toHaveBeenCalledWith('link-1');
    expect(screen.queryByTestId('space-links-notice')).toBeNull();
    // The list was not re-read as if the write had landed.
    expect(port.list).toHaveBeenCalledTimes(1);
  });

  it('any other forbidden is still a refusal with the server\'s words', async () => {
    const port = fakePort([link()]);
    port.remove.mockRejectedValueOnce(new CollabError('forbidden', 'you are not a member of the target space'));
    render(<SpaceLinksSection port={port} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Research' }));
    expect((await screen.findByTestId('space-link-failure-link-1')).textContent)
      .toBe('Refused: you are not a member of the target space');
    expect(screen.queryByTestId('space-links-notice')).toBeNull();
  });

  it('Remove calls port.remove (positive)', async () => {
    const port = fakePort([link()]);
    render(<SpaceLinksSection port={port} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Research' }));
    await waitFor(() => expect(port.remove).toHaveBeenCalledWith('link-1'));
    expect((await screen.findByTestId('space-links-notice')).textContent).toMatch(/Removed/);
  });

  it('Allow spawn calls port.setSpawn with the new value', async () => {
    const port = fakePort([link()]);
    render(<SpaceLinksSection port={port} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Allow spawn in Research' }));
    await waitFor(() => expect(port.setSpawn).toHaveBeenCalledWith('link-1', true));
  });

  it('the spawn switch carries the stored-switch help text and is described by it', async () => {
    render(<SpaceLinksSection port={fakePort([link()])} />);
    const help = await screen.findByTestId('space-links-spawn-help');
    expect(help.textContent?.replace(/\s+/g, ' ').trim()).toBe(SPAWN_OFF_TEXT);
    const box = screen.getByRole('checkbox', { name: 'Allow spawn in Research' });
    expect(box.getAttribute('aria-describedby')).toBe(help.id);
  });

  it('Add link sends the typed target space id', async () => {
    const port = fakePort([]);
    render(<SpaceLinksSection port={port} />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Target space id' }), {
      target: { value: ' 0f1e2d3c-0000-4000-8000-0000000000e1 ' },
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add link' })); });
    await waitFor(() => expect(port.add).toHaveBeenCalledWith('0f1e2d3c-0000-4000-8000-0000000000e1'));
  });

  it('a list that cannot be read says so instead of drawing an empty pane', async () => {
    const port = fakePort([]);
    port.list.mockRejectedValueOnce(new Error('network down'));
    render(<SpaceLinksSection port={port} />);
    expect((await screen.findByTestId('space-links-load-error')).textContent).toMatch(/network down/);
  });
});

describe('spaceLinksPortFromSeam', () => {
  it('maps each method to its seam call, bound to the space', async () => {
    const calls: unknown[][] = [];
    const rec = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); return link(); };
    const seam = {
      spaceLinks: {
        list: async (...args: unknown[]) => { calls.push(['list', ...args]); return [link()]; },
        add: rec('add'),
        login: rec('login'),
        relogin: rec('relogin'),
        logout: rec('logout'),
        remove: rec('remove'),
        setSpawn: rec('setSpawn'),
      },
      spaces: async () => [
        { id: 'space-1', name: 'Home' },
        { id: 'space-2', name: 'Research' },
      ],
    } as unknown as Parameters<typeof spaceLinksPortFromSeam>[0];
    const port = spaceLinksPortFromSeam(seam, 'space-1' as never);
    expect(await port.list()).toEqual([link()]);
    expect(await port.candidates()).toEqual([{ id: 'space-2', name: 'Research' }]);
    await port.add('space-2');
    await port.login('link-1');
    await port.relogin('link-1');
    await port.logout('link-1');
    await port.remove('link-1');
    await port.setSpawn('link-1', true, 7);
    expect(calls).toEqual([
      ['list', 'space-1'],
      ['add', 'space-1', 'space-2'],
      ['login', 'link-1'],
      ['relogin', 'link-1'],
      ['logout', 'link-1'],
      ['remove', 'link-1'],
      ['setSpawn', 'link-1', true, 7],
    ]);
  });
});
