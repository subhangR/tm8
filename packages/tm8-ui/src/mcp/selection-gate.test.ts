import { describe, expect, it } from 'vitest';
import { accountProblem, OPEN_GATE, selectionGate } from './selection-gate';
import { connectorAccess, connectorRows, resolvedAccount } from './row-model';
import type { McpAccount, McpCatalog, McpServer } from './port';

const account = (over: Partial<McpAccount> & { id: string }): McpAccount => ({
  label: over.id, canUse: true, canManage: false, status: 'connected', sharing: 'private', ...over,
});
const server = (over: Partial<McpServer> = {}): McpServer => ({
  id: 'notion', version: 1, title: 'Notion', description: '', transport: 'http', url: 'https://mcp.notion.com/mcp',
  auth: 'oauth', approved: true, enabled: true, canManage: false, canAttach: true, accounts: [], ...over,
});
const catalog = (...servers: McpServer[]): McpCatalog => ({ servers, defaults: [], canRegister: false, canAttach: true });
const blocked = (problem: string) => ({ blocked: true, problem });

/** The three kinds of connection §3 tells apart, as the adapter builds them. */
const mine = account({ id: 'mine', ownerId: 'me', canManage: true, sharing: 'private' });
const spaceOwned = account({ id: 'space', sharing: 'space', scope: 'space' });
const theirsPublic = account({ id: 'theirs-public', ownerId: 'them', sharing: 'space' });
const sharedWithMe = account({ id: 'shared', ownerId: 'them', sharing: 'members' });

describe('resolvedAccount — §3 below the pin, as resolve_mcp_account orders it', () => {
  it('takes the viewer’s own connection before an older shared one', () => {
    expect(resolvedAccount(server({ accounts: [spaceOwned, mine] }))?.id).toBe('mine');
  });
  it('takes a Space-owned connection before a member’s public one', () => {
    expect(resolvedAccount(server({ accounts: [theirsPublic, spaceOwned] }))?.id).toBe('space');
    expect(resolvedAccount(server({ accounts: [theirsPublic] }))?.id).toBe('theirs-public');
  });
  it('never picks a connection that is only shared with the viewer', () => {
    expect(resolvedAccount(server({ accounts: [sharedWithMe] }))).toBeUndefined();
  });
  it('reads a shared connection the viewer manages as their own', () => {
    expect(resolvedAccount(server({ accounts: [account({ id: 'mine-shared', ownerId: 'me', canManage: true, sharing: 'members' })] }))?.id).toBe('mine-shared');
  });
  it('skips an account that is not connected or not usable', () => {
    expect(resolvedAccount(server({ accounts: [{ ...mine, status: 'needs_reconnect' }, { ...spaceOwned, canUse: false }] }))).toBeUndefined();
  });
});

describe('the row for a dead pin', () => {
  const revoked = { ...mine, status: 'revoked', canUse: false };
  it('says no access rather than the shared account the pick will NOT open', () => {
    expect(connectorAccess(server({ accounts: [revoked, spaceOwned] }), 'mine')).toBe('—');
    expect(connectorAccess(server({ accounts: [revoked, spaceOwned] }))).toBe('Shared');
  });
  it('marks the pin dead and names no account', () => {
    const [row] = connectorRows(catalog(server({ accounts: [revoked, spaceOwned] })), [{ serverId: 'notion', credentialId: 'mine' }], true);
    expect(row).toMatchObject({ deadPin: true, account: undefined, credentialId: 'mine' });
  });
});

describe('the launch gate', () => {
  it('never blocks the Space defaults, nor [] — that is a choice', () => {
    const data = catalog(server({ accounts: [] }));
    data.defaults = [{ serverId: 'notion' }];
    expect(selectionGate(data, undefined)).toEqual(OPEN_GATE);
    expect(selectionGate(data, [])).toEqual(OPEN_GATE);
  });
  it('lets through an unpinned pick the server can open by itself', () => {
    expect(selectionGate(catalog(server({ accounts: [mine] })), [{ serverId: 'notion' }])).toEqual(OPEN_GATE);
    expect(selectionGate(catalog(server({ accounts: [spaceOwned] })), [{ serverId: 'notion' }])).toEqual(OPEN_GATE);
    expect(selectionGate(catalog(server({ auth: 'none' })), [{ serverId: 'notion' }])).toEqual(OPEN_GATE);
  });
  it('blocks, by name, every explicit pick bind would refuse', () => {
    expect(selectionGate(catalog(), [{ serverId: 'gone' }]))
      .toEqual(blocked('A connector picked here no longer exists. Reset the connectors to drop it.'));
    expect(selectionGate(catalog(server({ approved: false, accounts: [mine] })), [{ serverId: 'notion' }]))
      .toEqual(blocked('Notion is awaiting approval and would be refused. Switch it off.'));
    expect(selectionGate(catalog(server({ enabled: false, accounts: [mine] })), [{ serverId: 'notion' }]))
      .toEqual(blocked('Notion is disabled by an admin and would be refused. Switch it off.'));
    expect(selectionGate(catalog(server({ transport: 'stdio', auth: 'none', source: { stdioTrusted: false } as McpServer['source'] })), [{ serverId: 'notion' }]))
      .toEqual(blocked('Notion runs a local command this node does not trust and would be refused. Switch it off.'));
  });
  it('does not block for the target’s attach permission alone — bind never refuses a pick for it', () => {
    expect(selectionGate(catalog(server({ canAttach: false, accounts: [mine] })), [{ serverId: 'notion' }])).toEqual(OPEN_GATE);
  });
  it('blocks an unpinned pick whose only account needs a pin, and opens once it is pinned', () => {
    const data = catalog(server({ accounts: [sharedWithMe] }));
    expect(selectionGate(data, [{ serverId: 'notion' }]))
      .toEqual(blocked('Choose an account for Notion: a connection shared with you is used only when you pick it.'));
    expect(selectionGate(data, [{ serverId: 'notion', credentialId: 'shared' }])).toEqual(OPEN_GATE);
  });
  it('words a dead pin by its remedy: another account, or a reconnect', () => {
    const revoked = { ...mine, status: 'credential_revoked', canUse: false };
    expect(accountProblem(server({ accounts: [revoked, spaceOwned] }), { serverId: 'notion', credentialId: 'mine' }))
      .toBe('Choose a connected account for Notion.');
    expect(accountProblem(server({ accounts: [revoked] }), { serverId: 'notion', credentialId: 'mine' }))
      .toBe('The account picked for Notion needs reconnecting. Reconnect it, or switch Notion off.');
  });
  it('words a pick with no account by its remedy: reconnect the broken one, or connect one', () => {
    expect(accountProblem(server({ accounts: [{ ...mine, status: 'needs_reconnect', canUse: false }] }), { serverId: 'notion' }))
      .toBe('Reconnect Notion, or switch it off.');
    expect(accountProblem(server(), { serverId: 'notion' })).toBe('Connect an account for Notion, or switch it off.');
  });
  it('names the FIRST pick that would be refused', () => {
    const data = catalog(server({ id: 'off', title: 'Off', enabled: false }), server({ accounts: [sharedWithMe] }));
    expect(selectionGate(data, [{ serverId: 'notion' }, { serverId: 'off' }]).problem).toMatch(/^Choose an account for Notion/);
    expect(selectionGate(data, [{ serverId: 'off' }, { serverId: 'notion' }]).problem).toMatch(/^Off is disabled/);
  });
});

describe('round 2: what bind refuses that the gate used to pass', () => {
  it('a pin on a connector that no longer takes an account is dead', () => {
    expect(selectionGate(catalog(server({ auth: 'none' })), [{ serverId: 'notion', credentialId: 'old' }]))
      .toEqual(blocked('Notion no longer uses an account. Switch it off and on again to drop the old one.'));
  });
  it('a local command with NO trust flag is untrusted, in the gate and on the row', () => {
    const stdio = server({ transport: 'stdio', auth: 'none', source: {} as McpServer['source'] });
    expect(selectionGate(catalog(stdio), [{ serverId: 'notion' }]).blocked).toBe(true);
    expect(connectorRows(catalog(stdio), [], false)[0]?.status).toBe('stdio_not_trusted');
  });
  it('labels a connection shared WITH the viewer as theirs-to-borrow, not "Just me"', () => {
    expect(connectorAccess(server({ accounts: [sharedWithMe] }), 'shared')).toBe('Shared with you');
    expect(connectorAccess(server({ accounts: [mine] }))).toBe('Just me');
    expect(connectorAccess(server({ accounts: [spaceOwned] }))).toBe('Shared');
  });
});
