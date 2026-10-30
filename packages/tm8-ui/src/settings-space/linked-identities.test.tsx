// @vitest-environment jsdom
/**
 * Bridges B3 — Account → Linked identities (§4.6) through the REAL shell, the
 * REAL port and the fixture seam: the list, a code shown once with its
 * countdown, the panel closing when the link arrives, and two-click unlink.
 * Also the People tab's Invite to space action (D60).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BridgeIdentityLink, BridgeLinksList, CreateInviteInput, SpaceInviteView } from '@tm8/contract';
import { createFixtureSeam } from '../data';
import { settingsPortFromSeam } from './port';
import { SettingsShell } from './SettingsShell';
import { LinkedIdentitiesSection, countdown, linkStatus } from './LinkedIdentitiesSection';
import { SETTINGS_SECTIONS } from './types';
import { InviteToSpace, maskedNumber } from '../bridges/invite';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const link = (over: Partial<BridgeIdentityLink> = {}): BridgeIdentityLink => ({
  id: 'l1', provider: 'whatsapp', externalId: '919800000001@s.whatsapp.net', masked: '…0001', method: 'code',
  trust: 'linked', spaceId: null, spaceName: null, verifiedAt: '2026-10-28T09:12:00.000Z', revokedAt: null, ...over,
});

describe('Linked identities (§4.6)', () => {
  it('sits in the account group right after Sign-ins & devices', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(ids.indexOf('linked-identities')).toBe(ids.indexOf('my-sessions') + 1);
  });

  it('through the fixture seam: lists linked and asserted rows; Link WhatsApp shows the /link code once', async () => {
    const seam = createFixtureSeam();
    const spaceId = (await seam.spaces())[0]!.id;
    render(<SettingsShell port={settingsPortFromSeam(seam, spaceId)} initialSection="linked-identities" />);
    const body = await screen.findByTestId('linked-identities-body');
    expect(within(body).getByTestId('link-row-link-fixture-1').textContent).toMatch(/WhatsApp.*···· 0001.*Linked ✓ · verified 28 Oct/);
    expect(within(body).getByTestId('link-row-link-fixture-2').textContent).toMatch(/Asserted by an admin of Fixture space/);
    fireEvent.click(screen.getByTestId('link-begin'));
    const code = await screen.findByTestId('link-code');
    expect(code.textContent).toMatch(/^\/link TM8-[A-HJ-NP-Z2-9]{6}$/);
    expect(screen.getByTestId('link-code-left').textContent).toMatch(/expires in (10:00|9:5\d)/);
    // The list never carries the code back (D58).
    const listed = await seam.bridgeLinks();
    expect(listed.pending).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(code.textContent!.slice(6));
  });

  it('closes the code panel once a new link arrives', async () => {
    let items: BridgeIdentityLink[] = [];
    const load = vi.fn(async (): Promise<BridgeLinksList> => ({ items, pending: [] }));
    const begin = vi.fn(async () => ({ code: 'TM8-4F7KQ2', provider: 'whatsapp' as const, expiresAt: new Date(Date.now() + 600_000).toISOString(), createdAt: new Date().toISOString() }));
    render(<LinkedIdentitiesSection heading="Linked identities" load={load} begin={begin} pollMs={20} />);
    fireEvent.click(await screen.findByTestId('link-begin'));
    expect((await screen.findByTestId('link-code')).textContent).toBe('/link TM8-4F7KQ2');
    items = [link()];
    await waitFor(() => expect(screen.queryByTestId('link-code-panel')).toBeNull());
    expect(screen.getByTestId('link-row-l1')).toBeTruthy();
  });

  it('unlink takes two clicks and re-reads', async () => {
    let items = [link()];
    const load = vi.fn(async (): Promise<BridgeLinksList> => ({ items, pending: [] }));
    const revoke = vi.fn(async (id: string) => { items = []; return link({ id, revokedAt: '2026-10-30T07:00:00.000Z' }); });
    render(<LinkedIdentitiesSection heading="Linked identities" load={load} revoke={revoke} />);
    fireEvent.click(await screen.findByTestId('link-revoke-l1'));
    expect(revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('link-revoke-confirm-l1'));
    await waitFor(() => expect(screen.getByTestId('links-empty')).toBeTruthy());
    expect(revoke).toHaveBeenCalledWith('l1');
  });

  it('a refused begin is drawn; an unwired host says so', async () => {
    const load = async (): Promise<BridgeLinksList> => ({ items: [], pending: [] });
    render(<LinkedIdentitiesSection heading="Linked identities" load={load} begin={async () => { throw new Error('a link code is for a human'); }} />);
    fireEvent.click(await screen.findByTestId('link-begin'));
    expect((await screen.findByTestId('link-error')).textContent).toMatch(/for a human/);
    cleanup();
    render(<LinkedIdentitiesSection heading="Linked identities" />);
    expect(screen.getByTestId('section-absent').textContent).toMatch(/not wired/);
  });

  it('countdown and status words', () => {
    expect(countdown('2026-10-30T07:10:00.000Z', Date.parse('2026-10-30T07:00:19.000Z'))).toBe('9:41');
    expect(countdown('2026-10-30T07:00:00.000Z', Date.parse('2026-10-30T07:00:01.000Z'))).toBeNull();
    expect(linkStatus(link({ method: 'invite' }))).toBe('Linked ✓ · verified 28 Oct by invite');
  });
});

describe('Invite to space (D60)', () => {
  it('mints one pinned, one-use invite and shows the join link to share; tm8 sends nothing', async () => {
    const createInvite = vi.fn(async (_space: string, _input: CreateInviteInput): Promise<SpaceInviteView> => ({
      id: 'inv1', code: 'inv_abc', role: 'member', maxUses: 1, uses: 0, expiresAt: null, revoked: false,
    }));
    render(<InviteToSpace spaceId="s1" bridgeId="b1" participant={{ externalId: '919000000002@s.whatsapp.net', displayName: 'Rahul' }}
      createInvite={createInvite} joinUrl={(c) => `https://tm8.example/join/${c}`} />);
    fireEvent.click(screen.getByTestId('bridge-invite-919000000002@s.whatsapp.net'));
    expect(screen.getByTestId('bridge-invite-panel').textContent).toMatch(/Invite Rahul to this space\?.*never messages them/);
    fireEvent.click(screen.getByTestId('bridge-invite-mint'));
    expect((await screen.findByTestId('bridge-invite-link')).textContent).toBe('https://tm8.example/join/inv_abc');
    expect(createInvite).toHaveBeenCalledWith('s1', expect.objectContaining({
      maxUses: 1, bridgeParticipant: { bridgeId: 'b1', externalId: '919000000002@s.whatsapp.net' },
    }));
  });

  it('draws a refusal; masks to the last four', async () => {
    render(<InviteToSpace spaceId="s1" bridgeId="b1" participant={{ externalId: '919000000002@s.whatsapp.net', displayName: null }}
      createInvite={async () => { throw new Error('this participant is already linked to a tm8 account'); }} />);
    fireEvent.click(screen.getByTestId('bridge-invite-919000000002@s.whatsapp.net'));
    expect(screen.getByTestId('bridge-invite-panel').textContent).toMatch(/Invite ···· 0002/);
    fireEvent.click(screen.getByTestId('bridge-invite-mint'));
    expect((await screen.findByTestId('bridge-invite-error')).textContent).toMatch(/already linked/);
    expect(maskedNumber('12')).toBe('····');
  });
});
