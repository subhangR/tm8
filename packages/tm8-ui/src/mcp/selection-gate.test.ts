import { describe, expect, it } from 'vitest';
import { accountProblem, selectionBlocked, selectionProblem } from './selection-gate';
import { resolvedAccount } from './row-model';
import type { McpAccount, McpCatalog, McpServer } from './port';

const account = (over: Partial<McpAccount> & { id: string }): McpAccount => ({
  label: over.id, canUse: true, canManage: false, status: 'connected', sharing: 'private', ...over,
});
const server = (over: Partial<McpServer> = {}): McpServer => ({
  id: 'notion', version: 1, title: 'Notion', description: '', transport: 'http', url: 'https://mcp.notion.com/mcp',
  auth: 'oauth', approved: true, enabled: true, canManage: false, canAttach: true, accounts: [], ...over,
});
const catalog = (...servers: McpServer[]): McpCatalog => ({ servers, defaults: [], canRegister: false, canAttach: true });

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

describe('the launch gate', () => {
  it('never blocks or complains about the Space defaults', () => {
    const data = catalog(server({ accounts: [] }));
    data.defaults = [{ serverId: 'notion' }];
    expect(selectionBlocked(data, undefined)).toBe(false);
    expect(selectionProblem(data, undefined)).toBeNull();
  });
  it('lets [] through: no connectors is a choice', () => {
    expect(selectionBlocked(catalog(server()), [])).toBe(false);
  });
  it('sends an unpinned pick the server can open by itself', () => {
    expect(selectionBlocked(catalog(server({ accounts: [mine] })), [{ serverId: 'notion' }])).toBe(false);
    expect(selectionBlocked(catalog(server({ accounts: [spaceOwned] })), [{ serverId: 'notion' }])).toBe(false);
  });
  it('blocks an unpinned pick whose only account needs a pin, and passes once it is pinned', () => {
    const data = catalog(server({ accounts: [sharedWithMe] }));
    expect(selectionBlocked(data, [{ serverId: 'notion' }])).toBe(true);
    expect(selectionProblem(data, [{ serverId: 'notion' }])).toBe('Choose an account for Notion: a connection shared with you is used only when you pick it.');
    expect(selectionBlocked(data, [{ serverId: 'notion', credentialId: 'shared' }])).toBe(false);
  });
  it('blocks a pin to an account that stopped working', () => {
    const data = catalog(server({ accounts: [{ ...mine, status: 'credential_revoked', canUse: false }, spaceOwned] }));
    expect(selectionBlocked(data, [{ serverId: 'notion', credentialId: 'mine' }])).toBe(true);
    expect(accountProblem(data.servers[0]!, { serverId: 'notion', credentialId: 'mine' })).toBe('Choose a connected account for Notion.');
  });
  it('blocks a pick with no connected account at all', () => {
    expect(selectionProblem(catalog(server()), [{ serverId: 'notion' }])).toBe('Connect an account for Notion, or switch it off.');
  });
  it('never blocks on a connector that needs no account', () => {
    expect(selectionBlocked(catalog(server({ auth: 'none' })), [{ serverId: 'notion' }])).toBe(false);
  });
  it('reports, without blocking, what only an admin can fix', () => {
    const disabled = catalog(server({ enabled: false, accounts: [mine] }));
    expect(selectionBlocked(disabled, [{ serverId: 'notion' }])).toBe(false);
    expect(selectionProblem(disabled, [{ serverId: 'notion' }])).toBe('Notion is awaiting approval or disabled, so the launch will refuse it. Switch it off.');
    const untrusted = catalog(server({ transport: 'stdio', auth: 'none', source: { stdioTrusted: false } as McpServer['source'] }));
    expect(selectionBlocked(untrusted, [{ serverId: 'notion' }])).toBe(false);
    expect(selectionProblem(untrusted, [{ serverId: 'notion' }])).toContain('does not trust');
    expect(selectionBlocked(catalog(), [{ serverId: 'gone' }])).toBe(false);
    expect(selectionProblem(catalog(), [{ serverId: 'gone' }])).toBe('A connector picked here is no longer available. Reset the connectors to drop it.');
  });
  it('explains the held button first when a pick blocks and another only warns', () => {
    const data = catalog(server({ id: 'off', title: 'Off', enabled: false }), server({ accounts: [sharedWithMe] }));
    expect(selectionBlocked(data, [{ serverId: 'off' }, { serverId: 'notion' }])).toBe(true);
    expect(selectionProblem(data, [{ serverId: 'off' }, { serverId: 'notion' }])).toMatch(/^Choose an account for Notion/);
  });
});
