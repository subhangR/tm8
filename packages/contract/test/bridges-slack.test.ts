/**
 * Slack bridge contract (protocol v4, design 01a1ed5f-40af): the pasted-token
 * begin input, the policy's threadMode and the connection view's account and
 * detail.
 */
import { describe, expect, it } from 'vitest';
import {
  BridgeConnectionBeginInputSchema, BridgeConnectionViewSchema, BridgePolicySchema,
} from '../src/index.js';

const cm = '01a189da-0000-7000-8000-0000000000c1';
const connectionId = '01a189da-0000-7000-8000-0000000000c2';
const botToken = 'xoxb-1234567890-9876543210-AbCdEf012345';
const appToken = 'xapp-1-A0123BCDE-1234567890-0123456789abcdef';
const credential = { kind: 'slack_tokens', botToken, appToken } as const;

const begin = (body: Record<string, unknown>) => BridgeConnectionBeginInputSchema.safeParse({ clientMutationId: cm, ...body });

describe('bridges.connections.begin for Slack', () => {
  it('takes both tokens for a new Slack connection', () => {
    const parsed = begin({ provider: 'slack', credential });
    expect(parsed.success).toBe(true);
  });

  it('trims a pasted trailing newline or space', () => {
    const parsed = begin({ provider: 'slack', credential: { ...credential, botToken: `${botToken}\n`, appToken: ` ${appToken} ` } });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.credential?.botToken).toBe(botToken);
      expect(parsed.data.credential?.appToken).toBe(appToken);
    }
  });

  it('refuses a new Slack connection without tokens', () => {
    expect(begin({ provider: 'slack' }).success).toBe(false);
  });

  it('lets a relink (connectionId) omit the tokens or rotate them', () => {
    expect(begin({ provider: 'slack', connectionId }).success).toBe(true);
    expect(begin({ provider: 'slack', connectionId, credential }).success).toBe(true);
  });

  it('refuses swapped, degenerate or foreign tokens', () => {
    expect(begin({ provider: 'slack', credential: { ...credential, botToken: appToken, appToken: botToken } }).success).toBe(false);
    expect(begin({ provider: 'slack', credential: { ...credential, botToken: 'xoxb-----------' } }).success).toBe(false);
    expect(begin({ provider: 'slack', credential: { ...credential, botToken: 'xoxp-1234567890-9876543210-AbCdEf' } }).success).toBe(false);
  });

  it('keeps credential to Slack and authFlow to WhatsApp', () => {
    expect(begin({ provider: 'whatsapp', credential }).success).toBe(false);
    expect(begin({ provider: 'slack', credential, authFlow: { kind: 'qr' } }).success).toBe(false);
    expect(begin({ provider: 'whatsapp', authFlow: { kind: 'qr' } }).success).toBe(true);
    expect(begin({ provider: 'whatsapp' }).success).toBe(true);
  });

  it('never echoes a token in a refusal', () => {
    const parsed = begin({ provider: 'whatsapp', credential });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const text = JSON.stringify(parsed.error.issues);
      expect(text).not.toContain(botToken);
      expect(text).not.toContain(appToken);
    }
  });
});

describe('policy.threadMode', () => {
  const policy = { trigger: 'mention', direction: 'both', outbound: 'replies', whoMayTrigger: 'anyone', voice: 'named', style: null };
  it('is optional and one of off | mention | every', () => {
    expect(BridgePolicySchema.safeParse(policy).success).toBe(true);
    for (const threadMode of ['off', 'mention', 'every']) {
      expect(BridgePolicySchema.safeParse({ ...policy, threadMode }).success).toBe(true);
    }
    expect(BridgePolicySchema.safeParse({ ...policy, threadMode: 'always' }).success).toBe(false);
  });
});

describe('the connection view', () => {
  const view = {
    id: connectionId, provider: 'slack', ownerAccountId: cm, label: 'Acme', externalAccountId: 'T0123',
    status: 'linked', runtimeId: 'slack-1', createdAt: '2026-11-18T00:00:00Z', lastSeenAt: null, offers: [],
  };
  const account = {
    teamId: 'T0123', teamName: 'Acme', url: 'https://acme.slack.com/', enterpriseId: 'E0123', enterpriseName: 'Acme Corp',
    isEnterpriseInstall: false, botUserId: 'U0BOT', botId: 'B0BOT', botName: 'tm8', scopes: ['chat:write'],
  };
  it('carries the Slack account and the runtime detail, both optional', () => {
    expect(BridgeConnectionViewSchema.safeParse(view).success).toBe(true);
    expect(BridgeConnectionViewSchema.safeParse({ ...view, account, detail: null }).success).toBe(true);
    expect(BridgeConnectionViewSchema.safeParse({ ...view, status: 'logged_out', account: null, detail: 'invalid_auth' }).success).toBe(true);
  });
  it('refuses an account without isEnterpriseInstall', () => {
    const { isEnterpriseInstall: _, ...partial } = account;
    expect(BridgeConnectionViewSchema.safeParse({ ...view, account: partial }).success).toBe(false);
  });
});
