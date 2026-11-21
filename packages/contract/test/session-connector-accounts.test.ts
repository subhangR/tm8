import { describe, expect, it } from 'vitest';
import { SessionLaunchRecordSchema } from '../src/schemas.js';

const record = {
  sessionId: '11111111-1111-4111-8111-111111111111', available: true, unavailableReason: null,
  manifest: {}, envVarNames: [], prompts: { system: null, task: null, unavailableReason: 'not_recorded' },
  recordedAt: '2026-11-21T00:00:00Z', launchContext: null,
};
const connectorAccounts = {
  available: true, unavailableReason: null, hiddenCount: 1, entries: [{
    serverId: '22222222-2222-4222-8222-222222222222', serverName: 'Drive', credentialRequired: true,
    account: { id: 'opaque-reference', label: 'Work', accountLabel: 'a***@example.com',
      grantedScopes: ['drive.readonly'], usable: false, status: 'revoked', reason: 'credential_revoked' },
  }],
};

describe('additive launch connector metadata contract', () => {
  it('accepts old launch records without account metadata', () => {
    expect(SessionLaunchRecordSchema.safeParse(record).success).toBe(true);
  });
  it('accepts allowlisted account metadata and explained unavailable states', () => {
    expect(SessionLaunchRecordSchema.safeParse({ ...record, connectorAccounts }).success).toBe(true);
    expect(SessionLaunchRecordSchema.safeParse({ ...record, connectorAccounts: { available: false,
      unavailableReason: 'not_recorded', entries: [], hiddenCount: 0 } }).success).toBe(true);
  });
  it.each(['token', 'secret', 'refreshToken', 'keyHint', 'fingerprint'])('refuses an unexpected %s field on account metadata', (key) => {
    const entry = connectorAccounts.entries[0]!;
    expect(SessionLaunchRecordSchema.safeParse({ ...record, connectorAccounts: {
      ...connectorAccounts, entries: [{ ...entry, account: { ...entry.account, [key]: 'DO_NOT_ADMIT' } }],
    } }).success).toBe(false);
  });
});
