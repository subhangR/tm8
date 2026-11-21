import { describe, expect, it, vi } from 'vitest';
import type { EntityId, McpCredentialView } from '@tm8/contract';
import type { Db, DbClaims } from '../src/db/types.js';
import { projectConnectorAccounts } from '../src/facade/launch-access.js';

const SESSION = '11111111-1111-4111-8111-111111111111' as EntityId;
const SERVER = '22222222-2222-4222-8222-222222222222';
const CREDENTIAL = '33333333-3333-4333-8333-333333333333';
const HIDDEN = '44444444-4444-4444-8444-444444444444';
const claims: DbClaims = { identityId: 'viewer', authKind: 'browser' };

function harness(input: { selections?: unknown; visible?: string[]; accounts?: unknown[]; failSelections?: boolean; failMetadata?: boolean } = {}) {
  const rpc = vi.fn(async (actualClaims: DbClaims, fn: string) => {
    expect(actualClaims).toBe(claims);
    if (fn === 'read_mcp_launch_selections') {
      if (input.failSelections) throw new Error('internal secret must not escape');
      return 'selections' in input ? input.selections : [{ serverId: SERVER, credentialId: CREDENTIAL }];
    }
    if (fn === 'list_mcp_credentials') {
      if (input.failMetadata) throw new Error('credential ciphertext must not escape');
      return input.accounts ?? [{ id: CREDENTIAL, serverId: SERVER, label: 'Work alice@example.com',
        accountLabel: 'alice@example.com', grantedScopes: ['drive.readonly'], usable: false,
        status: 'revoked', reason: 'credential_revoked', secret: 'NEVER_RENDER', keyHint: 'NO_HINT',
        refreshToken: 'NO_REFRESH', ownerId: HIDDEN }];
    }
    throw new Error(`Unexpected RPC ${fn}`);
  });
  const query = vi.fn(async (actualClaims: DbClaims) => {
    expect(actualClaims).toBe(claims);
    return (input.visible ?? [SERVER]).map((id) => ({ id, name: 'Drive' }));
  });
  const db = { rpc, query } as unknown as Db;
  return { rpc, query, run: () => projectConnectorAccounts(db, claims, SESSION) };
}

describe('work-session connector account projection', () => {
  it('uses recorded resolved pins and a metadata allowlist, with emails masked', async () => {
    const h = harness();
    const result = await h.run();
    expect(result).toEqual({ available: true, unavailableReason: null, hiddenCount: 0, entries: [{
      serverId: SERVER, serverName: 'Drive', credentialRequired: true, account: {
        id: CREDENTIAL, label: 'Work a***@example.com', accountLabel: 'a***@example.com',
        grantedScopes: ['drive.readonly'], usable: false, status: 'revoked', reason: 'credential_revoked',
      },
    }] });
    expect(h.rpc.mock.calls.map((call) => call[1])).toEqual(['read_mcp_launch_selections', 'list_mcp_credentials']);
    expect(h.rpc).toHaveBeenLastCalledWith(claims, 'list_mcp_credentials', [SERVER, CREDENTIAL]);
    const serialized = JSON.stringify(result);
    for (const forbidden of ['NEVER_RENDER', 'NO_HINT', 'NO_REFRESH', 'alice@example.com', HIDDEN]) expect(serialized).not.toContain(forbidden);
  });

  it('counts unreadable connectors without disclosing or looking up their accounts', async () => {
    const h = harness({ selections: [{ serverId: HIDDEN, credentialId: CREDENTIAL }], visible: [] });
    expect(await h.run()).toEqual({ available: true, unavailableReason: null, entries: [], hiddenCount: 1 });
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.query.mock.calls[0]?.[0]).toBe(claims);
  });

  it.each([{ accounts: [] }, { failMetadata: true }, { accounts: [{ id: CREDENTIAL, serverId: HIDDEN } as McpCredentialView] }])('does not disclose an unreadable or mismatched account: %o', async (input) => {
    const h = harness(input);
    const result = await h.run();
    expect(result.entries[0]).toEqual({ serverId: SERVER, serverName: 'Drive', credentialRequired: true, account: null });
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL);
  });

  it('distinguishes unrecorded bindings from a recorded empty selection', async () => {
    expect(await harness({ selections: null }).run()).toMatchObject({ available: false, unavailableReason: 'not_recorded' });
    expect(await harness({ selections: [] }).run()).toEqual({ available: true, unavailableReason: null, entries: [], hiddenCount: 0 });
    expect((await harness({ selections: [{ serverId: SERVER }] }).run()).entries[0]).toMatchObject({ credentialRequired: false, account: null });
  });

  it.each([{ failSelections: true }, { selections: [{ serverId: SERVER, token: 'FORBIDDEN' }] }])('keeps projection failures separate from recorded launch posture: %o', async (input) => {
    expect(await harness(input).run()).toEqual({ available: false, unavailableReason: 'read_failed', entries: [], hiddenCount: 0 });
  });
});
