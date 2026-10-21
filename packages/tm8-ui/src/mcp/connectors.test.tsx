// @vitest-environment jsdom
/**
 * The Connectors page's few high-signal tests (surface ruling S17): the one
 * security item this PR touches, and two behaviours whose mapping is the whole
 * point of the page.
 *
 *  - S14(c)/S2 — a logo slug maps to a BUNDLED mark and never becomes a URL.
 *    This is the security core: the catalog is server data, so a slug that
 *    reached an `<img src>` would turn a settings page into an egress channel
 *    the catalog author controls.
 *  - §10.0's status → row mapping, including `no_human_provenance` (S5).
 *  - S7's Discover button states, including B22/B25's ADOPT, where the wrong
 *    branch leaves a Space holding two connectors for one catalog entry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { McpCatalogEntry } from '@tm8/contract';
import { McpProvider } from './context';
import { ConnectorsTable } from './ConnectorsTable';
import { connectorGlyph, GENERIC_GLYPH } from './connector-logos';
import { accessLabel, limitedAccessCount, rowStatusOf, statusLabel, typeLabel, STATUS_ROWS } from './connector-rows';
import type { McpCatalog, McpPort, McpServer } from './port';

afterEach(cleanup);

const server = (over: Partial<McpServer> = {}): McpServer => ({
  id: '11111111-1111-4111-8111-111111111111', version: 1, title: 'Calendar', description: '',
  transport: 'http', url: 'https://calendar.example/mcp', auth: 'api_key',
  approved: true, enabled: true, canManage: true, canAttach: true, accounts: [],
  source: { name: 'Calendar', transport: 'http', url: 'https://calendar.example/mcp', envKeys: ['Authorization'], headerKeys: [], auth: { type: 'none' }, approved: true },
  ...over,
});

function port(over: Partial<McpPort> = {}): McpPort {
  return {
    catalog: vi.fn(async (): Promise<McpCatalog> => ({ servers: [], defaults: [], canRegister: true, canAttach: true })),
    catalogEntries: vi.fn(async () => []), addFromCatalog: vi.fn(async () => ({ serverId: 'x', adopted: false })),
    request: vi.fn(), patch: vi.fn(), register: vi.fn(), update: vi.fn(), remove: vi.fn(),
    importConfig: vi.fn(), importMany: vi.fn(), attach: vi.fn(), detach: vi.fn(),
    test: vi.fn(async () => ({ ok: true, message: 'ready', tools: [] })),
    createKey: vi.fn(), rotateKey: vi.fn(), startOAuth: vi.fn(async () => ({ authorizationUrl: 'https://id.example/a' })),
    share: vi.fn(), revoke: vi.fn(), members: vi.fn(async () => []),
    ...over,
  };
}

const entry = (over: Partial<McpCatalogEntry> = {}): McpCatalogEntry => ({
  id: 'notion', title: 'Notion', logo: 'notion', kind: 'remote', available: true,
  docsUrl: 'https://developers.notion.com/', summary: 'Pages and databases.',
  ...over,
} as McpCatalogEntry);

function renderDiscover(entries: McpCatalogEntry[], admin: boolean, p = port()) {
  const live = port({ ...p, catalogEntries: vi.fn(async () => entries) });
  render(<McpProvider port={live}>
    <ConnectorsTable catalog={{ servers: [], defaults: [], canRegister: admin, canAttach: true }} port={live}
      admin={admin} busy={false} run={async action => { await action(); }} refresh={() => {}} loading={false}
      tab="discover" setTab={() => {}} sheet={null} setSheet={() => {}} />
  </McpProvider>);
  return live;
}

describe('S14(c)/S2 — a logo slug is a bundled mark, never an address', () => {
  it('falls back for an unknown slug instead of building one', () => {
    expect(connectorGlyph('notion')).not.toBe(GENERIC_GLYPH);
    expect(connectorGlyph('a-slug-this-build-never-heard-of')).toBe(GENERIC_GLYPH);
    expect(connectorGlyph(undefined)).toBe(GENERIC_GLYPH);
  });

  it('renders the catalog with no image element and no fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderDiscover([entry({ logo: 'notion' }), entry({ id: 'odd', title: 'Odd', logo: 'an-unknown-provider-slug' })], true);
    await screen.findByText('Notion');
    await screen.findByText('Odd');
    // Any of these would mean a slug had been turned into an address: an image,
    // an SVG sprite reference, or a CSS background URL.
    expect(document.querySelectorAll('img, image, picture, source, use, [src], [srcset]')).toHaveLength(0);
    expect([...document.querySelectorAll<HTMLElement>('[style]')].some(el => el.style.cssText.includes('url('))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('§10.0 — one status, one row, everywhere', () => {
  it('maps every status to the plan’s icon, toggle and action', () => {
    expect(STATUS_ROWS.ready).toMatchObject({ icon: '✓', toggle: true, action: null, group: 'connected' });
    expect(STATUS_ROWS.credential_required).toMatchObject({ toggle: false, action: 'connect', group: 'unconnected' });
    expect(STATUS_ROWS.needs_reconnect).toMatchObject({ icon: '⚠', toggle: false, action: 'reconnect' });
    expect(STATUS_ROWS.credential_definition_changed).toMatchObject({ action: 'reconnect', label: 'Connector settings changed by an admin' });
    expect(STATUS_ROWS.not_approved).toMatchObject({ icon: '⏳', action: 'approve', adminOnly: true });
    expect(STATUS_ROWS.disabled).toMatchObject({ action: null, label: 'Disabled by an admin' });
    // The one row whose toggle stays ON: the probe failed, the call may not.
    expect(STATUS_ROWS.server_unavailable).toMatchObject({ toggle: true, action: 'test' });
    // S5: the launch has no human behind it. Nothing to connect, so no action
    // at all — offering [Connect] here would send someone to fix the wrong thing.
    expect(STATUS_ROWS.no_human_provenance).toMatchObject({ toggle: false, action: null, label: 'No person behind this launch' });
    for (const [status, row] of Object.entries(STATUS_ROWS)) {
      expect(row.icon, status).toBeTruthy();
      expect(row.label.length, status).toBeGreaterThan(2);
    }
  });

  it('substitutes the connector name and the reason the plan asks for', () => {
    expect(statusLabel('server_unavailable', { name: 'Figma' })).toBe("Can't reach Figma");
    expect(statusLabel('provider_blocked', { name: 'Figma' })).toBe("Figma hasn't approved tm8 yet");
    expect(statusLabel('needs_reconnect', { name: 'Gmail', statusReason: 'scope_reduced' }))
      .toBe('Needs reconnect · access was reduced in Google');
    expect(statusLabel('ready', { name: 'Gmail' })).toBe('Connected');
  });

  it('reports the most actionable thing about a connector, worst first', () => {
    expect(rowStatusOf(server({ approved: false })).status).toBe('not_approved');
    expect(rowStatusOf(server({ enabled: false })).status).toBe('disabled');
    expect(rowStatusOf(server({ transport: 'stdio', command: 'x' })).status).toBe('stdio_not_trusted');
    expect(rowStatusOf(server({ auth: 'none' })).status).toBe('ready');
    expect(rowStatusOf(server()).status).toBe('credential_required');
    const expired = server({ accounts: [
      { id: 'a', label: 'denied', canUse: false, canManage: false, status: 'access_denied', sharing: 'private' },
      { id: 'b', label: 'mine', canUse: false, canManage: true, status: 'credential_expired', sharing: 'private' },
    ] });
    // The expired row this viewer owns beats the one they were never granted:
    // only one of the two is something they can act on.
    expect(rowStatusOf(expired).status).toBe('credential_expired');
    const ready = server({ accounts: [{ id: 'c', label: 'work', canUse: true, canManage: true, status: 'connected', sharing: 'private', accountLabel: 'me@example.com' }] });
    expect(rowStatusOf(ready)).toMatchObject({ status: 'ready', account: { accountLabel: 'me@example.com' } });
  });

  it('draws the Limited-access badge only from the server\u2019s own count (S10)', () => {
    const connection = { id: 'c', label: 'work', canUse: true, canManage: true, status: 'connected', sharing: 'private' as const };
    // A partial grant stays `ready`: the connection works for what it covers.
    const partial = rowStatusOf(server({ accounts: [{ ...connection, unavailableToolCount: 2 }] }));
    expect(partial.status).toBe('ready');
    expect(limitedAccessCount(partial)).toBe(2);
    // null is "nobody can say" (a relayed connector), 0 is "fully covered".
    // Both draw nothing, and neither is computed here.
    expect(limitedAccessCount(rowStatusOf(server({ accounts: [{ ...connection, unavailableToolCount: null }] })))).toBe(0);
    expect(limitedAccessCount(rowStatusOf(server({ accounts: [{ ...connection, unavailableToolCount: 0 }] })))).toBe(0);
    expect(limitedAccessCount(rowStatusOf(server({ accounts: [connection] })))).toBe(0);
    // A connector that is not ready has no coverage to report.
    expect(limitedAccessCount(rowStatusOf(server({ approved: false, accounts: [{ ...connection, unavailableToolCount: 3 }] })))).toBe(0);
  });

  it('labels access by tier and type by definition, never by URL', () => {
    expect(accessLabel(server())).toBe('—');
    expect(accessLabel(server({ accounts: [{ id: 'a', label: 'x', canUse: true, canManage: true, status: 'connected', sharing: 'private', scope: 'member' }] }))).toBe('Just me');
    expect(accessLabel(server({ accounts: [{ id: 'a', label: 'x', canUse: true, canManage: false, status: 'connected', sharing: 'space', scope: 'space' }] }))).toBe('Shared');
    expect(accessLabel(server({ accounts: [
      { id: 'a', label: 'x', canUse: true, canManage: true, status: 'connected', sharing: 'private', scope: 'member' },
      { id: 'b', label: 'y', canUse: true, canManage: false, status: 'connected', sharing: 'space', scope: 'space' },
    ] }))).toBe('Just me + Shared');
    expect(accessLabel(server({ accounts: [{ id: 'a', label: 'Pat’s', ownerLabel: 'Pat', canUse: true, canManage: false, status: 'connected', sharing: 'space', scope: 'member' }] }))).toBe('Shared by Pat');
    expect(typeLabel(server())).toBe('Remote Custom');
    expect(typeLabel(server({ source: { ...server().source!, catalogId: 'notion' } }))).toBe('Remote');
    // S8: first-party plus a `google.` catalog id. A custom connector pointed at
    // a Google URL is NOT a tm8-hosted Google connection.
    expect(typeLabel(server({ source: { ...server().source!, firstParty: true, catalogId: 'google.gmail' } }))).toBe('Google · tm8');
    expect(typeLabel(server({ transport: 'stdio', command: 'x' }))).toBe('Local');
  });
});

describe('S7 — the Discover card has one button, and B22/B25 decides which', () => {
  it('offers Add to an admin and Request to a member', async () => {
    const live = renderDiscover([entry()], true);
    fireEvent.click(await screen.findByRole('button', { name: 'Add to Space' }));
    await waitFor(() => expect(live.addFromCatalog).toHaveBeenCalledWith('notion'));
    cleanup();
    const member = renderDiscover([entry()], false);
    fireEvent.click(await screen.findByRole('button', { name: 'Request' }));
    await waitFor(() => expect(member.request).toHaveBeenCalledWith({ catalogId: 'notion' }));
  });

  it('ADOPTS an open member request instead of adding a second connector', async () => {
    const open = [{ serverId: '22222222-2222-4222-8222-222222222222', approved: false }];
    const live = renderDiscover([entry({ added: open })], true);
    // The admin verb is Approve, and it goes through the same call, which
    // approves THAT row (B22/B25) rather than creating another.
    fireEvent.click(await screen.findByRole('button', { name: 'Approve request' }));
    await waitFor(() => expect(live.addFromCatalog).toHaveBeenCalledWith('notion'));
    expect(screen.queryByRole('button', { name: 'Add to Space' })).toBeNull();
  });

  it('tells a member their request is already in, and shows Added once approved', async () => {
    renderDiscover([entry({ added: [{ serverId: '22222222-2222-4222-8222-222222222222', approved: false }] })], false);
    const requested = await screen.findByRole('button', { name: 'Requested' });
    expect(requested.getAttribute('aria-disabled')).toBe('true');
    cleanup();
    renderDiscover([entry({ added: [{ serverId: '22222222-2222-4222-8222-222222222222', approved: true }] })], false);
    expect(await screen.findByRole('button', { name: 'Added' })).toBeTruthy();
  });

  it('refuses Connect and Add on an entry that is not available yet', async () => {
    renderDiscover([entry({ id: 'google.gmail', title: 'Gmail', logo: 'google-gmail', kind: 'first_party', available: false })], true);
    const soon = await screen.findByRole('button', { name: 'Coming soon' });
    expect(soon.getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Add to Space' })).toBeNull();
  });
});
