// @vitest-environment jsdom
/**
 * The settings redesign (2026-10-18): the Overview a bare `/settings` opens,
 * its search, the role gating it inherits from the nav model, and the scope
 * chip every section header now carries.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { IdentityView } from '../data/seam';
import { resolveMenu } from '../shell/menu-resolve';
import { FrameNav } from '../shell/FrameNav';
import { SettingsShell } from './SettingsShell';
import { SectionFrame, SectionScopeContext } from './SectionFrame';
import { settingsNavGroups } from './nav';
import type { SettingsPort } from './port';
import { specimenMembers } from './specimen';

afterEach(cleanup);

const NOW = Date.parse('2026-07-29T04:00:00.000Z');
const IDENTITY: IdentityView = {
  identityId: 'id-ada',
  accountId: 'acc-ada',
  username: 'ada',
  displayName: 'Ada Osei',
  avatar: null,
  email: null,
  globalId: null,
  isNodeAdmin: false,
  isOwner: true,
  status: 'active',
  actingAs: null,
  memberships: [{ spaceId: 'specimen-space', memberId: 'm-ada', role: 'owner' }],
};

/** Only the boot reads: the Overview must need nothing else. */
function bootPort(): SettingsPort {
  return {
    loadSpace: async () => ({
      id: 'specimen-space' as never,
      name: 'atelier',
      description: 'the workshop space',
      memberCount: 3,
      unreadTotal: 0,
      githubRepo: null,
      createdAt: '2026-01-04T09:00:00.000Z',
      sessionShareDefault: 'space',
      sessionDriveDefault: 'owner',
    }),
    loadMembers: async () => specimenMembers(NOW),
    loadIdentity: async () => IDENTITY,
    loadMenu: async () => resolveMenu(null),
    loadInvites: async () => [
      { id: 'i1', code: 'inv_a', role: 'member', maxUses: 1, uses: 0, expiresAt: null, revoked: false },
      { id: 'i2', code: 'inv_b', role: 'member', maxUses: 1, uses: 1, expiresAt: null, revoked: false },
    ],
    loadAxes: async () => [],
    loadWorkflows: async () => [],
  } as unknown as SettingsPort;
}

const settled = () => screen.findByText(/^Settings for /);

describe('Overview — what a bare /settings opens', () => {
  it('is the default section, with a card per scope', async () => {
    render(<SettingsShell port={bootPort()} />);
    await settled();
    expect(screen.getByText('Settings', { selector: '.set-section__title' })).toBeTruthy();
    const cards = screen.getAllByRole('region').filter((el) => el.classList.contains('set-ov__card'));
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual(['Account', 'Space', 'Server']);
    /* The Overview links; it changes nothing, so it carries no scope chip of its own. */
    expect(screen.queryByTestId('section-scope')).toBeNull();
  });

  it('states what the shell already read — and asks for nothing more', async () => {
    const port = bootPort();
    const spies = Object.fromEntries(Object.keys(port).map((k) => [k, vi.spyOn(port, k as keyof SettingsPort)]));
    render(<SettingsShell port={port} />);
    await settled();
    expect((await screen.findByTestId('overview-status-space')).textContent).toBe('3 members · 1 pending invite · 0 task axes · 0 workflows');
    expect(screen.getByTestId('overview-status-account').textContent).toBe('Signed in as Ada Osei (@ada)');
    for (const [name, spy] of Object.entries(spies)) expect(spy, name).toHaveBeenCalledTimes(1);
  });

  it('a plain member sees no admin rows and no server rows', async () => {
    render(<SettingsShell port={bootPort()} />);
    await settled();
    expect(screen.queryByRole('button', { name: 'Go to Invites settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Go to Member sign-ins settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Go to Accounts settings' })).toBeNull();
    const server = screen.getByRole('region', { name: 'Server' });
    expect(server.textContent).toMatch(/not a node admin/);
  });

  it('a node admin gets server rows that open their node page', async () => {
    const onOpenNodeSection = vi.fn();
    render(<SettingsShell port={bootPort()} onOpenSpaceAdmin={() => {}} onOpenNodeAdmin={() => {}} onOpenNodeSection={onOpenNodeSection} />);
    await settled();
    expect(screen.getByRole('button', { name: 'Go to Invites settings' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go to Filesystem access settings' }));
    expect(onOpenNodeSection).toHaveBeenCalledWith('filesystem');
  });

  it('a row opens its section, which then wears its scope chip', async () => {
    const onSectionChange = vi.fn();
    render(<SettingsShell port={bootPort()} onSectionChange={onSectionChange} />);
    await settled();
    fireEvent.click(screen.getByRole('button', { name: 'Go to Members & roles settings' }));
    expect(onSectionChange).toHaveBeenCalledWith('members');
    expect(screen.getByText('Members & roles', { selector: '.set-section__title' })).toBeTruthy();
    expect(screen.getByTestId('section-scope').textContent).toBe('Everyone in this space');
  });

  it('search narrows the cards by label and keyword, and says when nothing matches', async () => {
    render(<SettingsShell port={bootPort()} onOpenNodeAdmin={() => {}} />);
    await settled();
    const search = screen.getByRole('searchbox', { name: 'Find a setting' });
    fireEvent.change(search, { target: { value: 'api key' } });
    const rows = Array.from(document.querySelectorAll('.set-ov__row')).map((r) => r.getAttribute('data-section'));
    expect(rows).toEqual(['space:credentials', 'space:space-credentials', 'node:credentials']);
    expect(screen.getByText('3 settings match')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'zzzz' } });
    expect(document.querySelectorAll('.set-ov__row')).toHaveLength(0);
    expect(screen.getByText('Nothing matches “zzzz”.')).toBeTruthy();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect((search as HTMLInputElement).value).toBe('');
  });

  it('a shell scoped without the Overview (space admin) opens its first section instead', async () => {
    render(<SettingsShell port={bootPort()} sectionIds={['profile', 'members']} />);
    expect(await screen.findByText('Space profile', { selector: '.set-section__title' })).toBeTruthy();
  });
});

describe('scope chips on section headers', () => {
  it.each([
    ['account', 'Only you'],
    ['my-sessions', 'Only you'],
    ['models', 'This browser'],
    ['members', 'Everyone in this space'],
    ['configs', 'Everyone in this space'],
    ['danger', 'Everyone in this space'],
  ] as const)('%s says "%s"', async (section, chip) => {
    render(<SettingsShell port={bootPort()} initialSection={section} />);
    expect((await screen.findByTestId('section-scope')).textContent).toBe(chip);
  });

  it('an injected section from another module gets the chip without an edit there', async () => {
    render(
      <SettingsShell
        port={bootPort()}
        initialSection="node-credentials"
        sections={{ 'node-credentials': <SectionFrame title="Node credentials"><p>injected</p></SectionFrame> }}
      />,
    );
    expect((await screen.findByTestId('section-scope')).textContent).toBe('Server-wide');
  });

  it('a frame with no provider draws no chip, and `scope={null}` suppresses one', () => {
    const { unmount } = render(<SectionFrame title="Bare"><p>x</p></SectionFrame>);
    expect(screen.queryByTestId('section-scope')).toBeNull();
    unmount();
    render(
      <SectionScopeContext.Provider value="you">
        <SectionFrame title="Quiet" scope={null}><p>x</p></SectionFrame>
      </SectionScopeContext.Provider>,
    );
    expect(screen.queryByTestId('section-scope')).toBeNull();
  });
});

describe('the frame nav, as Settings draws it', () => {
  function renderNav(onSelect = vi.fn()) {
    render(<FrameNav label="Settings" groups={settingsNavGroups({ space: true, node: true })} current="space:overview" onSelect={onSelect} />);
    return onSelect;
  }

  it('draws scope headings, their descriptions and topical subheadings', () => {
    renderNav();
    const space = screen.getByRole('group', { name: 'Space' });
    expect(within(space).getByText('Everyone in this space sees these changes.')).toBeTruthy();
    expect(within(space).getByText('People & access')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Overview' }).getAttribute('aria-current')).toBe('page');
  });

  it('the filter matches keywords, and Enter opens the first match', () => {
    const onSelect = renderNav();
    const filter = screen.getByRole('searchbox', { name: 'Filter settings' });
    fireEvent.change(filter, { target: { value: 'mcp' } });
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Connectors']);
    fireEvent.keyDown(filter, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('space:connectors');
  });

  it('arrow keys move between rows', () => {
    renderNav();
    const filter = screen.getByRole('searchbox', { name: 'Filter settings' });
    fireEvent.keyDown(filter, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('Overview');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('Profile');
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement?.textContent).toBe('Configuration');
  });
});
