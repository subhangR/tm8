/** In-memory UI fixture. Credential-shaped examples are assembled at runtime. */
import {
  type VaultActor, type VaultApprovalView, type VaultAuditEventView, type VaultGrantView,
  type VaultItemDetail, type VaultItemView, type VaultOperationName, type VaultPasskeyView,
  type VaultPolicyView, type VaultSessionView, type VaultStatus,
} from '@tm8/contract';
import { createVaultPort, type VaultCallOptions, type VaultTransport } from './port';
import type { VaultAuthenticator } from './webauthn';

export const VAULT_FIXTURE_IDS = {
  item: '11111111-1111-4111-8111-111111111111',
  blocked: '11111111-1111-4111-8111-222222222222',
  deleted: '11111111-1111-4111-8111-333333333333',
  apiItem: '11111111-1111-4111-8111-444444444444',
  owner: '22222222-2222-4222-8222-222222222222',
  approval: '33333333-3333-4333-8333-333333333333',
  spendApproval: '33333333-3333-4333-8333-444444444444',
  useApproval: '33333333-3333-4333-8333-555555555555',
  grant: '44444444-4444-4444-8444-444444444444',
  passkey: '55555555-5555-4555-8555-555555555555',
  otherPasskey: '55555555-5555-4555-8555-666666666666',
  session: '66666666-6666-4666-8666-666666666666',
  otherSession: '66666666-6666-4666-8666-777777777777',
  capture: '77777777-7777-4777-8777-777777777777',
  challenge: '88888888-8888-4888-8888-888888888888',
  operation: '99999999-9999-4999-8999-999999999999',
  space: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
} as const;

export interface VaultFixtureOptions {
  metadata?: string;
  signedIn?: boolean;
  status?: Partial<VaultStatus>;
  approvalState?: VaultApprovalView['state'];
  chain?: 'verified' | 'broken' | 'unverified';
  authenticator?: VaultAuthenticator;
  responses?: Partial<Record<VaultOperationName, unknown>>;
  errors?: Partial<Record<VaultOperationName, unknown>>;
  /** The transport's space; null is a single-membership caller. */
  spaceId?: string | null;
  /**
   * Adds an active API key with this policy and, with `approval`, a pending per-use API approval
   * for it that binds the mode the broker enforced and where the key is sent.
   */
  api?: {
    policy: VaultPolicyView | null;
    approval?: { policyMode: VaultPolicyView['mode']; keyInjection: VaultPolicyView['injection']['kind'] };
  };
}

export function createVaultFixture(options: VaultFixtureOptions = {}) {
  const ids = VAULT_FIXTURE_IDS;
  const now = Date.now();
  const at = new Date(now - 60_000).toISOString();
  const future = (ms = 900_000) => new Date(Date.now() + ms).toISOString();
  const label = options.metadata ?? 'Example';
  const hash = 'a'.repeat(64);
  const actor: VaultActor = { kind: 'agent', memberId: ids.owner, sessionId: ids.otherSession, name: `${label} agent` };
  const base: VaultItemView = {
    id: ids.item, version: 1, type: 'login', name: `${label} login`, ownerMemberId: ids.owner,
    access: 'owner', sharedBy: null, state: 'active', exposureTier: 'b', origins: ['https://github.com'],
    devMode: false, username: null, last4: null, expMonth: null, expYear: null, connector: null,
    hasTotp: false, hasNotes: false, fieldNames: [], secretVersion: 1, createdAt: at, updatedAt: at, rotatedAt: null,
  };
  const items: VaultItemView[] = [base,
    { ...base, id: ids.blocked, name: `${label} needs rotation`, type: 'api_key', state: 'blocked_until_rotated', exposureTier: 'a' },
    { ...base, id: ids.deleted, name: `${label} deleted note`, type: 'note', state: 'tombstoned', exposureTier: 'c' },
  ];
  const approvals: VaultApprovalView[] = [{
    id: ids.approval, kind: 'new_origin', state: options.approvalState ?? 'pending', oneUse: true,
    intentHash: hash, itemId: ids.item, itemName: base.name,
    boundParams: { origin: 'https://githhub.com', mode: 'one_use' }, requestedBy: actor,
    purpose: `${label} sign-in request`, lookalike: [{ kind: 'edit_distance', similarTo: 'https://github.com' }],
    spend: null, createdAt: at, expiresAt: options.approvalState === 'expired' ? at : future(),
    decidedAt: null, decidedBy: null, consumedAt: null,
  }, {
    id: ids.spendApproval, kind: 'spend', state: 'pending', oneUse: true, intentHash: 'b'.repeat(64),
    itemId: ids.item, itemName: `${label} payment instrument`, boundParams: { origin: 'https://shop.example' },
    requestedBy: actor, purpose: `${label} purchase`, lookalike: [],
    spend: { merchant: `${label} merchant`, amountMinor: 1234, currency: 'USD', itemSummary: 'Test order', instrumentTier: 'tier1' },
    createdAt: at, expiresAt: future(), decidedAt: null, decidedBy: null, consumedAt: null,
  }];
  if (options.api) {
    const apiItem: VaultItemView = { ...base, id: ids.apiItem, name: `${label} API key`, type: 'api_key', exposureTier: 'a', origins: [] };
    items.push(apiItem);
    const bound = options.api.approval;
    if (bound) {
      const expiresAt = future();
      approvals.push({
        id: ids.useApproval, kind: 'use', state: 'pending', oneUse: true, intentHash: 'c'.repeat(64),
        itemId: ids.apiItem, itemName: apiItem.name, boundParams: {
          itemId: ids.apiItem, action: 'call_api', actionIntentHash: 'd'.repeat(64), requesterMemberId: ids.owner,
          host: 'api.example.test', method: 'GET', path: '/v1/resource', policyMode: bound.policyMode,
          keyInjection: bound.keyInjection, kind: 'use', expiresAt,
        }, requestedBy: actor, purpose: `${label} API call`, lookalike: [], spend: null,
        createdAt: at, expiresAt, decidedAt: null, decidedBy: null, consumedAt: null,
      });
    }
  }
  const grants: VaultGrantView[] = [{
    id: ids.grant, itemId: ids.item, grantee: { kind: 'member', id: ids.owner, name: `${label} teammate` },
    constraints: { origins: ['https://github.com'], hosts: [], requireApprovalPerUse: true },
    expiresAt: future(86_400_000), createdAt: at, createdBy: actor, revokedAt: null,
  }];
  const passkeys: VaultPasskeyView[] = [ids.passkey, ids.otherPasskey].map((id, index) => ({
    id, name: `${label} passkey ${index + 1}`, createdAt: at, lastUsedAt: at,
    backedUp: index === 0, transports: ['internal'], revokedAt: null,
  }));
  const sessions: VaultSessionView[] = [ids.session, ids.otherSession].map((id, index) => ({
    id, passkeyId: ids.passkey, deviceLabel: `${label} device ${index + 1}`, createdAt: at, lastUsedAt: at,
    expiresAt: future(), refreshExpiresAt: future(43_200_000), current: index === 0, revokedAt: null,
  }));
  const events: VaultAuditEventView[] = [{
    seq: 1, at, action: 'item.imported', actor, itemId: ids.item,
    params: { exposureTier: 'b', source: `${label} import` }, prevHash: '0'.repeat(64), entryHash: hash,
  }];
  const status: VaultStatus = {
    mode: 'pre_review', reviewGate: 'open', testSecretsOnly: true, broker: 'ok', audit: 'ok',
    kms: { kind: 'local-dev', productionGrade: false },
    features: { capture: true, fill: true, callApi: true, spend: false, import: false, grants: true },
    viewer: { passkeys: 2, recoveryCodesRemaining: 10, vaultSession: options.signedIn === false ? null : {
      sessionId: ids.session, expiresAt: sessions[0].expiresAt,
    } },
    ...options.status,
  };
  const calls: { op: VaultOperationName; opts?: VaultCallOptions }[] = [];
  const responses = { ...options.responses };
  const errors = { ...options.errors };
  const missing = () => { throw { code: 'not_found' }; };
  const find = <T extends { id: string }>(rows: T[], id: string | undefined): T => rows.find((row) => row.id === id) ?? missing();

  const spaceId = options.spaceId === undefined ? ids.space : options.spaceId;
  const transport: VaultTransport = {
    spaceId,
    async call<T>(op: VaultOperationName, opts?: VaultCallOptions): Promise<T> {
      // No returned recovery-code payload is retained by the fixture.
      const body = (opts?.body ?? {}) as Record<string, unknown>;
      const recordedBody = { ...body };
      for (const key of ['enrollmentCode', 'recoveryCode']) {
        if (key in recordedBody) recordedBody[key] = '[redacted]';
      }
      calls.push({ op, opts: opts ? structuredClone({ ...opts, ...(opts.body ? { body: recordedBody } : {}) }) : undefined });
      if (Object.hasOwn(errors, op)) throw errors[op];
      if (Object.hasOwn(responses, op)) return structuredClone(responses[op]) as T;
      let output: unknown;
      switch (op) {
        case 'vault.status': output = status; break;
        case 'vault.items.list': output = { items, nextCursor: null }; break;
        case 'vault.items.get': output = { ...find(items, opts?.params?.itemId),
          policy: opts?.params?.itemId === ids.apiItem ? options.api?.policy ?? null : null,
          pendingApprovals: 1, activeGrants: grants.filter((grant) => !grant.revokedAt).length } satisfies VaultItemDetail; break;
        case 'vault.items.activity': output = { itemId: find(items, opts?.params?.itemId).id, windowDays: 7,
          uses: [{ actor, fills: 2, apiCalls: 1, origins: ['https://github.com'], hosts: [], lastAt: at }], recent: events }; break;
        case 'vault.captureLinks.create': output = { captureId: ids.capture,
          url: `${location.origin}/vault/capture/${ids.capture}#t=${'f'.repeat(43)}&s=${spaceId ?? ids.space}`,
          itemType: body.itemType, purpose: body.purpose, expiresAt: future(600_000) }; break;
        case 'vault.approvals.list': output = { approvals, nextCursor: null }; break;
        case 'vault.approvals.get': output = find(approvals, opts?.params?.approvalId); break;
        case 'vault.approvals.decide': {
          const approval = find(approvals, opts?.params?.approvalId);
          if (approval.state !== 'pending' || Date.parse(approval.expiresAt) <= Date.now()) {
            throw { details: { reason: 'approval_not_pending' } };
          }
          approval.state = body.decision === 'approve' ? 'approved' : 'denied';
          approval.oneUse = body.standing !== true;
          approval.decidedAt = new Date().toISOString();
          approval.decidedBy = { ...actor, kind: 'member' };
          output = approval; break;
        }
        case 'vault.webauthn.challenge': output = {
          challengeId: ids.challenge, purpose: body.purpose, action: body.action ?? null,
          intentHash: body.purpose === 'step_up' ? hash : null, expiresAt: future(120_000),
          publicKey: { challenge: 'A'.repeat(43), rpId: 'localhost', timeout: 120_000,
            userVerification: 'required', allowCredentials: [] },
        }; break;
        case 'vault.session.begin': case 'vault.session.refresh':
          sessions[0].expiresAt = future(); sessions[0].revokedAt = null;
          status.viewer.vaultSession = { sessionId: ids.session, expiresAt: sessions[0].expiresAt };
          output = sessions[0]; break;
        case 'vault.session.end': status.viewer.vaultSession = null; output = { ended: true }; break;
        case 'vault.passkeys.list': output = { passkeys }; break;
        case 'vault.passkeys.registerBegin': output = {
          registrationId: ids.challenge, expiresAt: future(120_000), publicKey: {
            challenge: 'A'.repeat(43), rp: { id: 'localhost', name: 'tm8 Vault' },
            user: { id: 'Zml4dHVyZQ', name: 'fixture', displayName: 'Fixture' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 120_000,
            attestation: 'none', excludeCredentials: [],
            authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
          },
        }; break;
        case 'vault.passkeys.registerFinish': {
          const passkey = { ...passkeys[0], id: crypto.randomUUID(), name: `${label} new passkey`, revokedAt: null };
          passkeys.push(passkey); status.viewer.passkeys += 1; output = passkey; break;
        }
        case 'vault.passkeys.revoke': {
          const passkey = find(passkeys, opts?.params?.passkeyId);
          if (passkeys.filter((entry) => !entry.revokedAt).length === 1 && body.confirmLast !== true) {
            throw { details: { reason: 'last_passkey' } };
          }
          passkey.revokedAt = new Date().toISOString(); output = passkey; break;
        }
        case 'vault.recovery.codes.create': output = {
          codes: Array.from({ length: 10 }, (_, index) => ['fixture', crypto.randomUUID().slice(0, 8), index].join('-')),
          createdAt: new Date().toISOString(),
        }; break;
        case 'vault.grants.list': output = { grants: grants.filter((grant) => grant.itemId === opts?.params?.itemId) }; break;
        case 'vault.grants.create': {
          const grant: VaultGrantView = { id: crypto.randomUUID(), itemId: opts!.params!.itemId,
            grantee: { ...body.grantee as VaultGrantView['grantee'], name: null },
            constraints: body.constraints as VaultGrantView['constraints'], expiresAt: body.expiresAt as string | null,
            createdAt: at, createdBy: actor, revokedAt: null };
          grants.push(grant); output = grant; break;
        }
        case 'vault.grants.revoke': { const grant = find(grants, opts?.params?.grantId);
          grant.revokedAt = new Date().toISOString(); output = grant; break; }
        case 'vault.sessions.list': output = { sessions }; break;
        case 'vault.sessions.revoke': { const session = find(sessions, opts?.params?.sessionId);
          session.revokedAt = new Date().toISOString();
          if (session.current) status.viewer.vaultSession = null;
          output = session; break; }
        case 'vault.audit.list': output = { events, nextCursor: null,
          chain: { status: options.chain ?? 'verified', headSeq: 1, headHash: hash } }; break;
        case 'vault.audit.verify': output = { status: options.chain ?? 'verified', checkedThroughSeq: 1,
          headHash: hash, firstBrokenSeq: options.chain === 'broken' ? 1 : null, checkpoint: null }; break;
        case 'vault.operations.get': output = { operationId: find([{ id: ids.operation }], opts?.params?.operationId).id,
          itemId: ids.item, kind: 'fill', state: 'done', createdAt: at, completedAt: at,
          result: { state: 'done', operationId: ids.operation, itemId: ids.item, finalOrigin: 'https://github.com',
            submitted: false, screenshot: null } }; break;
        default: throw { code: 'not_implemented' };
      }
      return structuredClone(output) as T;
    },
  };
  return { port: createVaultPort(transport, { authenticator: options.authenticator }), transport, calls, responses, errors };
}

export const createFixtureVaultPort = (options: VaultFixtureOptions = {}) => createVaultFixture(options).port;
