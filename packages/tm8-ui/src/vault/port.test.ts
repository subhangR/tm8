// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VAULT_ERROR_REASONS, VAULT_OUTPUT_SCHEMAS, vaultStepUpBoundParams, type VaultOperationName } from '@tm8/contract';
import { createVaultFixture, VAULT_FIXTURE_IDS as ids } from './fixture';
import { VAULT_ERROR_COPY, VaultUiError, vaultError } from './errors';
import { createStepUpRequester, type VaultPort, type VaultCallOptions } from './port';
import { browserVaultAuthenticator } from './webauthn';
import { generatedCanary, installFakeCredentials } from './test-fixtures';
import { openVaultCapture } from './links';

beforeEach(() => { installFakeCredentials(); vi.spyOn(navigator.credentials, 'get'); vi.spyOn(navigator.credentials, 'create'); });
afterEach(() => { vi.restoreAllMocks(); });

const calls: [VaultOperationName, (port: VaultPort) => Promise<unknown>][] = [
  ['vault.status', (port) => port.status()],
  ['vault.items.list', (port) => port.itemsList()],
  ['vault.items.get', (port) => port.itemGet(ids.item)],
  ['vault.items.activity', (port) => port.itemActivity(ids.item)],
  ['vault.captureLinks.create', (port) => port.captureLinkCreate({ itemType: 'login', purpose: 'create' })],
  ['vault.approvals.list', (port) => port.approvalsList()],
  ['vault.approvals.get', (port) => port.approvalGet(ids.approval)],
  ['vault.approvals.decide', (port) => port.approvalDecide(ids.approval, 'a'.repeat(64), 'deny')],
  ['vault.webauthn.challenge', (port) => port.signIn()],
  ['vault.session.begin', (port) => port.signIn()],
  ['vault.session.refresh', (port) => port.sessionRefresh()],
  ['vault.session.end', (port) => port.sessionEnd()],
  ['vault.passkeys.list', (port) => port.passkeysList()],
  ['vault.passkeys.registerBegin', (port) => port.passkeyRegister('Fixture', { kind: 'enrollment', code: 'fixture-code' })],
  ['vault.passkeys.registerFinish', (port) => port.passkeyRegister('Fixture', { kind: 'enrollment', code: 'fixture-code' })],
  ['vault.passkeys.revoke', (port) => port.passkeyRevoke(ids.passkey)],
  ['vault.recovery.codes.create', (port) => port.recoveryCodesCreate()],
  ['vault.grants.list', (port) => port.grantsList(ids.item)],
  ['vault.grants.create', (port) => port.grantCreate(ids.item, {
    grantee: { kind: 'member', id: ids.owner }, constraints: { origins: ['https://github.com'], hosts: [], requireApprovalPerUse: true }, expiresAt: null,
  })],
  ['vault.grants.revoke', (port) => port.grantRevoke(ids.grant)],
  ['vault.sessions.list', (port) => port.sessionsList()],
  ['vault.sessions.revoke', (port) => port.sessionRevoke(ids.otherSession)],
  ['vault.audit.list', (port) => port.auditList()],
  ['vault.audit.verify', (port) => port.auditVerify()],
  ['vault.operations.get', (port) => port.operationGet(ids.operation)],
];

describe('VaultTransport output validation', () => {
  it.each(calls)('%s validates its successful fixture response', async (op, invoke) => {
    const fixture = createVaultFixture();
    await invoke(fixture.port);
    expect(fixture.calls.some((call) => call.op === op)).toBe(true);
  });
  it.each(calls)('%s rejects a malformed response without retaining any raw data', async (op, invoke) => {
    const canary = generatedCanary();
    const fixture = createVaultFixture({ responses: { [op]: { unexpected: canary } } });
    try { await invoke(fixture.port); throw new Error('Expected refusal'); }
    catch (error) {
      expect(error).toBeInstanceOf(VaultUiError);
      expect((error as VaultUiError).code).toBe('invalid_response');
      expect(JSON.stringify(error).includes(canary)).toBe(false);
      expect(String(error).includes(canary)).toBe(false);
    }
  });
  it('rejects unexpected secret fields on an otherwise valid metadata response', async () => {
    const source = createVaultFixture();
    const valid = await source.port.itemGet(ids.item);
    const fixture = createVaultFixture({ responses: { 'vault.items.get': { ...valid, password: generatedCanary() } } });
    await expect(fixture.port.itemGet(ids.item)).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('returns no partial list when one row is malformed', async () => {
    const source = createVaultFixture();
    const { items } = await source.port.itemsList();
    const fixture = createVaultFixture({ responses: { 'vault.items.list': { items: [items[0], { name: 'Invalid' }], nextCursor: null } } });
    await expect(fixture.port.itemsList()).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('fixed refusal copy', () => {
  it.each(VAULT_ERROR_REASONS)('maps reason %s to fixed copy', (reason) => {
    const canary = generatedCanary();
    const error = vaultError({ message: canary, details: { reason, other: canary } });
    expect(error.message).toBe(VAULT_ERROR_COPY[reason]);
    expect(JSON.stringify(error).includes(canary)).toBe(false);
  });
  it('gives identical not_found copy for missing and cross-tenant ids', () => {
    const missing = vaultError({ code: 'not_found' });
    const otherTenant = vaultError({ code: 'not_found', details: { reason: 'vault_session_required' }, message: 'private detail' });
    expect(otherTenant.message).toBe(missing.message);
    expect(otherTenant.message).toBe('The requested record is unavailable.');
  });
  it('sanitizes nested envelopes, 501s and arbitrary exceptions', () => {
    expect(vaultError({ error: { details: { reason: 'spend_disabled' } } }).code).toBe('spend_disabled');
    expect(vaultError({ status: 501 }).code).toBe('not_implemented');
    expect(vaultError(new Error(generatedCanary())).message).toBe('The vault request failed. Try again.');
    expect(vaultError({ details: { reason: 'secret_in_metadata' } }).message).toBe(VAULT_ERROR_COPY.secret_in_metadata);
  });
});

describe('bound, fresh WebAuthn ceremonies', () => {
  it('binds the challenge and approve body identically, including path, hash and standing choice', async () => {
    const fixture = createVaultFixture();
    await fixture.port.approvalDecide(ids.approval, 'a'.repeat(64), 'approve', true);
    const challenge = fixture.calls.find((call) => call.op === 'vault.webauthn.challenge')!;
    const decide = fixture.calls.find((call) => call.op === 'vault.approvals.decide')!;
    const request = challenge.opts!.body as { action: string; pathParams: Record<string, string>; body: Record<string, unknown> };
    const final = decide.opts!.body as Record<string, unknown>;
    expect(request.action).toBe('vault.approvals.decide');
    expect(request.pathParams).toEqual({ approvalId: ids.approval });
    expect(vaultStepUpBoundParams(request.pathParams, request.body)).toEqual(vaultStepUpBoundParams(decide.opts!.params!, final));
    const { stepUp, ...unsigned } = final;
    expect(request.body).toEqual(unsigned);
    expect(stepUp).toMatchObject({ challengeId: ids.challenge });
  });
  it('takes an immutable snapshot before waiting for the assertion', async () => {
    const fixture = createVaultFixture();
    const native = installFakeCredentials().get;
    const get = vi.spyOn(navigator.credentials, 'get');
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    get.mockImplementation(async () => { await ready; return native() as unknown as Credential; });
    const fields = { grantee: { kind: 'member' as const, id: ids.owner }, constraints: {
      origins: ['https://github.com'], hosts: [] as string[], requireApprovalPerUse: true,
    }, expiresAt: null };
    const pending = fixture.port.grantCreate(ids.item, fields);
    fields.constraints.origins.push('https://unapproved.example');
    release(); await pending;
    const challenge = fixture.calls.find((call) => call.op === 'vault.webauthn.challenge')!;
    const command = fixture.calls.find((call) => call.op === 'vault.grants.create')!;
    const body = challenge.opts!.body as { pathParams: Record<string, string>; body: Record<string, unknown> };
    expect(vaultStepUpBoundParams(body.pathParams, body.body)).toEqual(vaultStepUpBoundParams(command.opts!.params!, command.opts!.body as Record<string, unknown>));
    expect(JSON.stringify(command.opts!.body).includes('unapproved')).toBe(false);
  });
  it('deny and revocations never ask for a step-up', async () => {
    const fixture = createVaultFixture();
    await fixture.port.approvalDecide(ids.approval, 'a'.repeat(64), 'deny');
    await fixture.port.grantRevoke(ids.grant);
    await fixture.port.sessionRevoke(ids.otherSession);
    await fixture.port.passkeyRevoke(ids.otherPasskey);
    expect(fixture.calls.some((call) => call.op === 'vault.webauthn.challenge')).toBe(false);
  });
  it('recovery creation and adding a passkey both use fresh step-up challenges', async () => {
    const fixture = createVaultFixture();
    await fixture.port.recoveryCodesCreate();
    await fixture.port.passkeyRegister('Second device', { kind: 'passkey' });
    const actions = fixture.calls.filter((call) => call.op === 'vault.webauthn.challenge')
      .map((call) => (call.opts!.body as { action: string }).action);
    expect(actions).toEqual(['vault.recovery.codes.create', 'vault.passkeys.registerBegin']);
  });
  it.each(['enrollment', 'recovery'] as const)('registers with a %s code without an assertion fallback', async (kind) => {
    const fixture = createVaultFixture();
    const credential = await fixture.port.passkeyRegister('Device', { kind, code: 'fixture-code' });
    expect(credential.revokedAt).toBeNull();
    expect(fixture.calls.map((call) => call.op)).toEqual(['vault.passkeys.registerBegin', 'vault.passkeys.registerFinish']);
    expect(navigator.credentials.create).toHaveBeenCalledOnce();
  });
  it('signs in using required user verification and converts browser bytes to contract JSON', async () => {
    const fixture = createVaultFixture({ signedIn: false });
    await fixture.port.signIn();
    expect(fixture.calls.map((call) => call.op)).toEqual(['vault.webauthn.challenge', 'vault.session.begin']);
    const begin = fixture.calls[1].opts!.body as { assertion: { rawId: string } };
    expect(begin.assertion.rawId).toBe('AQID');
    expect(navigator.credentials.get).toHaveBeenCalledWith(expect.objectContaining({
      publicKey: expect.objectContaining({ userVerification: 'required', challenge: expect.any(ArrayBuffer) }),
    }));
    expect((await fixture.port.status()).viewer.vaultSession).not.toBeNull();
  });
  it('never sends the command after cancellation', async () => {
    vi.mocked(navigator.credentials.get).mockRejectedValueOnce(new DOMException(generatedCanary(), 'NotAllowedError'));
    const fixture = createVaultFixture();
    await expect(fixture.port.recoveryCodesCreate()).rejects.toMatchObject({ code: 'authenticator_cancelled' });
    expect(fixture.calls.map((call) => call.op)).toEqual(['vault.webauthn.challenge']);
  });
  it('sanitizes synchronous authenticator exceptions for both assertion and registration', async () => {
    const canary = generatedCanary();
    const fixture = createVaultFixture({ authenticator: {
      get() { throw new Error(canary); }, create() { throw new Error(canary); },
    } });
    for (const run of [() => fixture.port.recoveryCodesCreate(), () => fixture.port.signIn(),
      () => fixture.port.passkeyRegister('Fixture', { kind: 'enrollment', code: 'fixture-code' })]) {
      try { await run(); throw new Error('Expected refusal'); }
      catch (error) {
        expect(error).toBeInstanceOf(VaultUiError);
        expect((error as VaultUiError).code).toBe('request_failed');
        expect(String(error).includes(canary)).toBe(false);
      }
    }
    expect(fixture.calls.some((call) => call.op === 'vault.recovery.codes.create' || call.op === 'vault.session.begin'
      || call.op === 'vault.passkeys.registerFinish')).toBe(false);
  });
  it('checks challenge expiry again after the authenticator returns', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const native = installFakeCredentials().get;
    vi.spyOn(navigator.credentials, 'get').mockImplementation(async () => {
      clock.mockReturnValue(now + 180_000); return native() as unknown as Credential;
    });
    const fixture = createVaultFixture();
    await expect(fixture.port.recoveryCodesCreate()).rejects.toMatchObject({ code: 'expired' });
    expect(fixture.calls.some((call) => call.op === 'vault.recovery.codes.create')).toBe(false);
  });
  it('rejects attempts to shadow a path parameter before requesting a challenge', async () => {
    const call = vi.fn();
    const requestStepUp = createStepUpRequester(call, browserVaultAuthenticator);
    const body = { clientMutationId: 'fixture', 'path.itemId': ids.item };
    await expect(requestStepUp('vault.recovery.codes.create', {}, body)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(call).not.toHaveBeenCalled();
  });
  it('refuses an expired challenge before invoking the authenticator', async () => {
    const source = createVaultFixture(); await source.port.signIn();
    const raw = await source.transport.call('vault.webauthn.challenge', { body: { purpose: 'step_up', action: 'vault.recovery.codes.create' } });
    const challenge = VAULT_OUTPUT_SCHEMAS['vault.webauthn.challenge'].parse(raw);
    const fixture = createVaultFixture({ responses: { 'vault.webauthn.challenge': { ...challenge, expiresAt: new Date(0).toISOString() } } });
    vi.mocked(navigator.credentials.get).mockClear();
    await expect(fixture.port.recoveryCodesCreate()).rejects.toMatchObject({ code: 'expired' });
    expect(navigator.credentials.get).not.toHaveBeenCalled();
  });
  it('refuses mismatched challenge purposes and never begins a session', async () => {
    const fixture = createVaultFixture();
    const original = fixture.transport.call.bind(fixture.transport);
    fixture.transport.call = async <T>(op: VaultOperationName, opts?: VaultCallOptions) => {
      const result = await original<T>(op, opts);
      return op === 'vault.webauthn.challenge' ? { ...result, purpose: 'step_up', action: 'vault.recovery.codes.create', intentHash: 'a'.repeat(64) } as T : result;
    };
    await expect(fixture.port.signIn()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fixture.calls.some((call) => call.op === 'vault.session.begin')).toBe(false);
  });
});

describe('standalone capture navigation', () => {
  it('opens only a same-origin capture URL, in an isolated tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const fixture = createVaultFixture();
    const link = await fixture.port.captureLinkCreate({ itemType: 'login', purpose: 'create' });
    openVaultCapture(link);
    expect(open).toHaveBeenCalledWith(link.url, '_blank', 'noopener,noreferrer');
  });
  it.each([
    'https://outside.example/vault/capture/', 'javascript:alert(1)',
    `${location.origin}/vault/capture/`, `${location.origin}/unexpected/`,
  ])('refuses an unexpected capture page address', async (url) => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const fixture = createVaultFixture(); const link = await fixture.port.captureLinkCreate({ itemType: 'login', purpose: 'create' });
    expect(() => openVaultCapture({ ...link, url })).toThrow(VaultUiError);
    expect(open).not.toHaveBeenCalled();
  });
  it('refuses a query string even on an otherwise correct URL', async () => {
    const fixture = createVaultFixture(); const link = await fixture.port.captureLinkCreate({ itemType: 'login', purpose: 'create' });
    const url = new URL(link.url); url.search = '?unsafe=1';
    expect(() => openVaultCapture({ ...link, url: url.href })).toThrow(VaultUiError);
  });
});
