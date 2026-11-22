// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VAULT_IMPORT_PAGE_PATH, type VaultPolicyView } from '@tm8/contract';
import { VaultSection } from './VaultSection';
import { MaskedScreenshot } from './ActivityPanels';
import { createVaultFixture, VAULT_FIXTURE_IDS as ids, type VaultFixtureOptions } from './fixture';
import { generatedCanary, installFakeCredentials, tinyPng } from './test-fixtures';

beforeEach(() => {
  installFakeCredentials();
  vi.spyOn(navigator.credentials, 'get'); vi.spyOn(navigator.credentials, 'create');
  vi.spyOn(window, 'open').mockReturnValue(null);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function mount(options: VaultFixtureOptions = {}) {
  const fixture = createVaultFixture(options);
  render(<VaultSection port={fixture.port} />);
  await screen.findByRole('button', { name: 'New item' });
  return fixture;
}

async function openScreen(name: 'Items' | 'Approvals' | 'Passkeys' | 'Sessions' | 'Audit' | 'Operations') {
  fireEvent.click(screen.getByRole('button', { name, exact: true }));
  await screen.findByRole('heading', { level: 3, name: {
    Items: 'Items', Approvals: 'Approvals inbox', Passkeys: 'Passkeys and recovery',
    Sessions: 'Vault sessions', Audit: 'Audit', Operations: 'Operation outcome',
  }[name] });
}

async function openItem() {
  fireEvent.click(await screen.findByRole('button', { name: 'Example login' }));
  await screen.findByRole('heading', { name: 'Example login' });
  await screen.findByRole('button', { name: 'Revoke grant to Example teammate' });
}

async function openApproval(name = 'Example login') {
  await openScreen('Approvals');
  fireEvent.click(await screen.findByRole('button', { name: `Review ${name}` }));
  await screen.findByRole('heading', { name: 'Approval details' });
  await screen.findByText('Requesting actor');
}

describe('status, session and passkeys', () => {
  it('shows mode, broker and audit health, test-only gates and payments off', async () => {
    const fixture = await mount();
    const banner = screen.getByLabelText('Vault status');
    expect(banner.textContent).toContain('Mode: pre_review');
    expect(banner.textContent).toContain('Broker: ok'); expect(banner.textContent).toContain('Audit: ok');
    expect(banner.textContent).toContain('Test secrets only.');
    expect(banner.textContent).toContain('Payments are off.');
    expect(screen.getAllByText('Test secrets only.').length).toBe(2);
    expect(screen.getByRole('button', { name: 'Import' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: /spend|pay|charge|execute/i })).toBeNull();
    expect(fixture.calls.some((call) => call.op.startsWith('vault.spend.'))).toBe(false);
  });
  it.each(['broker', 'audit'] as const)('makes the vault read-only when %s is unavailable', async (service) => {
    await mount({ status: { [service]: 'unavailable' } });
    expect(screen.getByRole('alert').textContent).toContain('Read-only');
    expect(screen.getByRole('button', { name: 'New item' }).hasAttribute('disabled')).toBe(true);
    await openScreen('Passkeys');
    expect(screen.getByRole('button', { name: 'Register passkey' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Create recovery codes' }).hasAttribute('disabled')).toBe(true);
  });
  it('fails closed when status is malformed and offers a retry', async () => {
    const fixture = createVaultFixture({ responses: { 'vault.status': { mode: 'pre_review' } } });
    render(<VaultSection port={fixture.port} />);
    await screen.findByText('The vault returned an invalid response. Nothing was displayed.');
    expect(screen.queryByRole('button', { name: 'New item' })).toBeNull();
    delete fixture.responses['vault.status'];
    fireEvent.click(screen.getByRole('button', { name: 'Refresh vault status' }));
    await screen.findByRole('button', { name: 'New item' });
  });
  it('shows reserved operations honestly as unavailable', async () => {
    const fixture = createVaultFixture({ errors: { 'vault.status': { status: 501, message: generatedCanary() } } });
    render(<VaultSection port={fixture.port} />);
    await screen.findByText('This vault operation is not available yet.');
    expect(screen.queryByRole('navigation', { name: 'Vault screens' })).toBeNull();
  });
  it('signs in, refreshes and signs out with HttpOnly-session metadata only', async () => {
    const fixture = await mount({ signedIn: false });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with passkey' }));
    await screen.findByRole('button', { name: 'Refresh session' });
    expect(navigator.credentials.get).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh session' }));
    await waitFor(() => expect(fixture.calls.some((call) => call.op === 'vault.session.refresh')).toBe(true));
    await screen.findByRole('button', { name: 'Sign out of vault' });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out of vault' }));
    await screen.findByRole('button', { name: 'Sign in with passkey' });
    expect(fixture.calls.some((call) => call.op === 'vault.session.end')).toBe(true);
  });
  it('renders a refused sign-in without leaking a server message', async () => {
    const canary = generatedCanary();
    await mount({ signedIn: false, errors: { 'vault.session.begin': { message: canary, details: { reason: 'step_up_invalid' } } } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with passkey' }));
    await screen.findByText('Passkey verification was refused. Start a new verification.');
    expect(document.body.textContent?.includes(canary)).toBe(false);
  });
  it('renders an expired session and prevents owner actions', async () => {
    await mount({ status: { viewer: { passkeys: 2, recoveryCodesRemaining: 10,
      vaultSession: { sessionId: ids.session, expiresAt: new Date(0).toISOString() } } } });
    expect(screen.getByText('Session expired.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Sessions', exact: true }));
    await screen.findByText('Sign in with a passkey to open this screen.');
    expect(screen.queryByRole('button', { name: /Revoke session/ })).toBeNull();
  });
  it.each(['Enrollment code', 'Recovery code', 'Existing passkey (step-up)'])('registers a passkey using %s', async (method) => {
    const fixture = await mount(); await openScreen('Passkeys');
    await screen.findByRole('button', { name: 'Revoke Example passkey 1' });
    fireEvent.change(screen.getByLabelText('Passkey name'), { target: { value: 'New device' } });
    const value = { 'Enrollment code': 'enrollment', 'Recovery code': 'recovery', 'Existing passkey (step-up)': 'passkey' }[method];
    fireEvent.change(screen.getByLabelText('Registration authorization'), { target: { value } });
    if (method !== 'Existing passkey (step-up)') fireEvent.change(screen.getByLabelText(method), { target: { value: 'fixture-code' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register passkey' }));
    await screen.findByRole('button', { name: 'Revoke Example new passkey' });
    expect(navigator.credentials.create).toHaveBeenCalledOnce();
    expect(fixture.calls.some((call) => call.op === 'vault.webauthn.challenge')).toBe(method === 'Existing passkey (step-up)');
    expect((screen.getByLabelText('Passkey name') as HTMLInputElement).value).toBe('');
  });
  it('clears a refused enrollment code and renders fixed refusal copy', async () => {
    await mount({ errors: { 'vault.passkeys.registerBegin': { details: { reason: 'code_invalid' } } } });
    await openScreen('Passkeys');
    fireEvent.change(screen.getByLabelText('Passkey name'), { target: { value: 'New device' } });
    fireEvent.change(screen.getByLabelText('Enrollment code'), { target: { value: generatedCanary() } });
    fireEvent.click(screen.getByRole('button', { name: 'Register passkey' }));
    await screen.findByText('The code is invalid, expired, or already used.');
    expect((screen.getByLabelText('Enrollment code') as HTMLInputElement).value).toBe('');
    expect(navigator.credentials.create).not.toHaveBeenCalled();
  });
  it('revokes passkeys without step-up and explicitly confirms the last one', async () => {
    const fixture = await mount(); await openScreen('Passkeys');
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke Example passkey 2' }));
    await screen.findByLabelText('I understand this revokes my last passkey');
    expect(screen.getByRole('button', { name: 'Revoke Example passkey 1' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByLabelText('I understand this revokes my last passkey'));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Example passkey 1' }));
    await waitFor(() => expect(fixture.calls.filter((call) => call.op === 'vault.passkeys.revoke').length).toBe(2));
    expect(navigator.credentials.get).not.toHaveBeenCalled();
  });
  it('shows recovery codes once, copies only after a click, and drops them on close', async () => {
    const canary = generatedCanary();
    const codes = Array.from({ length: 10 }, (_, index) => `${canary}-${index}`);
    const fixture = await mount({ responses: { 'vault.recovery.codes.create': { codes, createdAt: new Date().toISOString() } } });
    await openScreen('Passkeys');
    fireEvent.click(screen.getByRole('button', { name: 'Create recovery codes' }));
    const panel = await screen.findByRole('region', { name: 'Recovery codes shown once' });
    expect(panel.textContent?.includes(canary)).toBe(true);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy recovery codes' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Close recovery codes' }));
    expect(screen.queryByRole('region', { name: 'Recovery codes shown once' })).toBeNull();
    expect(document.body.textContent?.includes(canary)).toBe(false);
    await openScreen('Items'); await openScreen('Passkeys');
    expect(document.body.textContent?.includes(canary)).toBe(false);
    expect(fixture.calls.filter((call) => call.op === 'vault.recovery.codes.create').length).toBe(1);
  });
  it('drops recovery codes when leaving the panel and never reopens them', async () => {
    const canary = generatedCanary();
    await mount({ responses: { 'vault.recovery.codes.create': { codes: Array.from({ length: 10 }, (_, i) => `${canary}-${i}`), createdAt: new Date().toISOString() } } });
    await openScreen('Passkeys'); fireEvent.click(screen.getByRole('button', { name: 'Create recovery codes' }));
    await screen.findByRole('region', { name: 'Recovery codes shown once' });
    await openScreen('Items'); await openScreen('Passkeys');
    expect(document.body.textContent?.includes(canary)).toBe(false);
  });
  it('does not show a recovery panel after a refused step-up', async () => {
    await mount({ errors: { 'vault.webauthn.challenge': { details: { reason: 'step_up_invalid' } } } });
    await openScreen('Passkeys'); fireEvent.click(screen.getByRole('button', { name: 'Create recovery codes' }));
    await screen.findByText('Passkey verification was refused. Start a new verification.');
    expect(screen.queryByRole('region', { name: 'Recovery codes shown once' })).toBeNull();
  });
});

describe('metadata items, capture and use-only sharing', () => {
  it('shows item states, tiers, exact origins and activity with no reveal control', async () => {
    await mount(); await screen.findByText('blocked_until_rotated', { selector: '.vault-badge' });
    expect(screen.getByText('tombstoned', { selector: '.vault-badge' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /reveal|show secret|copy secret|export/i })).toBeNull();
    await openItem();
    expect(screen.getByText('Used 3 times in the last 7 days by Example agent on https://github.com.')).toBeDefined();
    expect(screen.getByText('Exact bound origins')).toBeDefined();
    expect(screen.getByText('Exposure tier')).toBeDefined();
  });
  it('creates new and rotation links and opens the standalone capture page with noopener', async () => {
    const fixture = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'New item' }));
    await waitFor(() => expect(window.open).toHaveBeenCalledOnce());
    expect(vi.mocked(window.open).mock.calls[0].slice(1)).toEqual(['_blank', 'noopener,noreferrer']);
    await openItem(); expect(screen.getAllByText('Test secrets only.', { selector: 'strong', exact: true }).length).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    await waitFor(() => expect(window.open).toHaveBeenCalledTimes(2));
    const bodies = fixture.calls.filter((call) => call.op === 'vault.captureLinks.create').map((call) => call.opts!.body);
    expect(bodies[1]).toMatchObject({ purpose: 'replace', itemId: ids.item, itemType: 'login' });
  });
  it('opens import only after review and feature gates permit it', async () => {
    const fixture = await mount({ status: { reviewGate: 'passed', testSecretsOnly: false,
      features: { capture: true, import: true, grants: true, fill: true, callApi: true, spend: false } } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(window.open).toHaveBeenCalledWith(`${VAULT_IMPORT_PAGE_PATH}#s=${ids.space}`, '_blank', 'noopener,noreferrer');
    expect(fixture.calls.some((call) => call.op.startsWith('vault.imports.'))).toBe(false);
  });
  it('opens import with no space for a single-membership transport', async () => {
    await mount({ spaceId: null, status: { reviewGate: 'passed', testSecretsOnly: false,
      features: { capture: true, import: true, grants: true, fill: true, callApi: true, spend: false } } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(window.open).toHaveBeenCalledWith(VAULT_IMPORT_PAGE_PATH, '_blank', 'noopener,noreferrer');
  });
  it('does not render item details or actions from a partial response', async () => {
    await mount({ responses: { 'vault.items.get': { name: 'Partial metadata' } } });
    fireEvent.click(await screen.findByRole('button', { name: 'Example login' }));
    await screen.findByText('The vault returned an invalid response. Nothing was displayed.');
    expect(screen.queryByText('Partial metadata')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rotate' })).toBeNull();
  });
  it('creates constrained grants with step-up and revokes in one click without it', async () => {
    const fixture = await mount(); await openItem();
    fireEvent.change(screen.getByLabelText('Recipient ID'), { target: { value: ids.owner } });
    fireEvent.click(screen.getByLabelText('https://github.com', { selector: 'input' }));
    fireEvent.change(screen.getByLabelText('Grant expiry'), { target: { value: '2099-01-01T12:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create grant with passkey' }));
    await screen.findByText('Use-only grant created.');
    const created = fixture.calls.find((call) => call.op === 'vault.grants.create')!.opts!.body;
    expect(created).toMatchObject({ constraints: { origins: ['https://github.com'], hosts: [], requireApprovalPerUse: true }, stepUp: { challengeId: ids.challenge } });
    const getCount = vi.mocked(navigator.credentials.get).mock.calls.length;
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke grant to Example teammate' }));
    await screen.findByText('Grant revoked, effective within 5 s. A use already in progress may complete.');
    expect(vi.mocked(navigator.credentials.get).mock.calls.length).toBe(getCount);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Revoke grant to Example teammate' })).toBeNull());
  });
  it('does not offer rotation or grants for a tombstoned item', async () => {
    await mount(); fireEvent.click(await screen.findByRole('button', { name: 'Example deleted note' }));
    await screen.findByRole('heading', { name: 'Example deleted note' });
    expect(screen.queryByRole('button', { name: 'Rotate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create grant with passkey' })).toBeNull();
  });
});

// Review F02, brief addendum 5: generic API mode is weaker than a vetted connector, and the owner
// sees that wherever use of such a key is authorized, before the decision.
describe('generic API mode is labelled weaker', () => {
  const policy = (mode: 'connector' | 'generic', injection: VaultPolicyView['injection'] = { kind: 'bearer' }): VaultPolicyView => ({
    version: 1, mode, connector: mode === 'connector' ? 'github' : null, hosts: ['api.example.test'], methods: ['GET', 'POST'],
    pathPrefixes: ['/v1'], maxRequestBytes: 4096, maxResponseBytes: 4096, injection,
  });
  const weaker = () => screen.queryAllByRole('note', { name: 'Weaker API mode' });

  async function openApiKey() {
    fireEvent.click(await screen.findByRole('button', { name: 'Example API key' }));
    await screen.findByRole('heading', { name: 'Example API key' });
    await screen.findByText('No grants for this item.');
  }

  it('shows the weaker mode on a per-use API approval, in the inbox and before Approve', async () => {
    const fixture = await mount({ api: { policy: policy('generic', { kind: 'query', name: 'api_key' }),
      approval: { policyMode: 'generic', keyInjection: 'query' } } });
    await openScreen('Approvals');
    await screen.findByRole('button', { name: 'Review Example API key' });
    expect(weaker()).toHaveLength(1);
    expect(weaker()[0]!.textContent).toContain('Weaker mode: generic API access, not a vetted connector.');
    fireEvent.click(screen.getByRole('button', { name: 'Review Example API key' }));
    await screen.findByRole('heading', { name: 'Approval details' });
    await screen.findByText('Requesting actor');
    const [notice] = weaker();
    expect(notice!.textContent).toContain('the query and body are sent as the agent wrote them');
    expect(notice!.textContent).toContain('The key is sent in the request URL, so upstream logs may keep it.');
    const approveButton = screen.getByRole('button', { name: 'Approve with passkey' });
    expect(notice!.compareDocumentPosition(approveButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(approveButton);
    await screen.findByText('Approval approved.');
    expect(fixture.calls.filter((call) => call.op === 'vault.approvals.decide')).toHaveLength(1);
  });

  it('does not label an approval bound to a vetted connector weaker', async () => {
    await mount({ api: { policy: policy('connector'), approval: { policyMode: 'connector', keyInjection: 'bearer' } } });
    await openApproval('Example API key');
    expect(weaker()).toHaveLength(0);
    expect(screen.getByText('Bound policyMode').nextSibling?.textContent).toBe('connector');
  });

  it('labels the API policy and the grant form of a generic-mode key', async () => {
    await mount({ api: { policy: policy('generic', { kind: 'query', name: 'api_key' }) } }); await openApiKey();
    const summary = screen.getByRole('region', { name: 'API policy' });
    expect(summary.textContent).toContain('Generic (weaker)');
    expect(summary.textContent).toContain('Request URL (query parameter)');
    expect(weaker()).toHaveLength(2);
    expect(screen.getByRole('group', { name: 'Allowed API hosts' }).textContent).toContain('Weaker mode: generic API access');
  });

  it('shows a vetted connector plainly and a key with no policy as refused', async () => {
    await mount({ api: { policy: policy('connector') } }); await openApiKey();
    expect(screen.getByRole('region', { name: 'API policy' }).textContent).toContain('Vetted connector: github');
    expect(weaker()).toHaveLength(0);
    cleanup();
    await mount({ api: { policy: null } }); await openApiKey();
    expect(screen.getByText('No API policy is set. API calls with this key are refused.')).toBeDefined();
    expect(weaker()).toHaveLength(0);
  });
});

describe('approvals and outcomes', () => {
  it('shows exact origin and prominent lookalike assessment before a one-use approval', async () => {
    const fixture = await mount(); await openApproval();
    const warning = screen.getByRole('alert');
    expect(warning.textContent).toContain('Exact requested origin: https://githhub.com');
    expect(warning.textContent).toContain('resembles https://github.com');
    expect(screen.getByText('one-use')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Approve with passkey' }));
    await screen.findByText('Approval approved.');
    expect(screen.queryByRole('button', { name: 'Approve with passkey' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to approvals' }));
    await screen.findByText('approved', { selector: '.vault-badge' });
    expect(fixture.calls.filter((call) => call.op === 'vault.approvals.decide').length).toBe(1);
    expect(navigator.credentials.get).toHaveBeenCalledOnce();
  });
  it('denies without a passkey and cannot decide the final row again', async () => {
    await mount(); await openApproval(); fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await screen.findByText('Approval denied.');
    expect(navigator.credentials.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Approve with passkey' })).toBeNull();
  });
  it('refreshes a stale approval after the broker reports that it has already been decided', async () => {
    const fixture = await mount(); await openApproval();
    const approval = await fixture.port.approvalGet(ids.approval);
    fixture.responses['vault.approvals.get'] = { ...approval, state: 'consumed', consumedAt: new Date().toISOString() };
    fixture.errors['vault.approvals.decide'] = { details: { reason: 'approval_not_pending' } };
    fireEvent.click(screen.getByRole('button', { name: 'Approve with passkey' }));
    await screen.findByText('This approval is consumed. It cannot be decided again.');
    expect(screen.queryByRole('button', { name: 'Approve with passkey' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });
  it.each(['denied', 'expired', 'consumed', 'approved'] as const)('renders a %s approval with no decision controls', async (approvalState) => {
    await mount({ approvalState }); await openApproval();
    expect(screen.queryByRole('button', { name: 'Approve with passkey' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(screen.getByText(`This approval is ${approvalState}. It cannot be decided again.`)).toBeDefined();
  });
  it('renders merchant and exact minor-unit amount, while spend approval stays unavailable', async () => {
    await mount(); await openApproval('Example payment instrument');
    expect(screen.getByText('Example merchant')).toBeDefined();
    expect(screen.getByText('1234 minor units USD')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Approve with passkey' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDefined();
  });
  it('renders masked PNG outcomes with their masked-region count', async () => {
    const source = createVaultFixture(); const outcome = await source.port.operationGet(ids.operation);
    const operation = { ...outcome, kind: 'fill', result: { state: 'done', operationId: ids.operation, itemId: ids.item,
      finalOrigin: 'https://github.com', submitted: false, screenshot: { mime: 'image/png', dataBase64: tinyPng(), width: 1, height: 1, maskedRegions: 4 } } };
    await mount({ responses: { 'vault.operations.get': operation } }); await openScreen('Operations');
    fireEvent.change(screen.getByLabelText('Operation ID'), { target: { value: ids.operation } });
    fireEvent.click(screen.getByRole('button', { name: 'Read operation' }));
    await screen.findByRole('img', { name: 'Masked operation screenshot' });
    expect(screen.getByText('4 masked regions')).toBeDefined();
  });
  it.each([btoa('<svg/>'), 'invalid base64', btoa('bad PNG data')])('refuses screenshot data without a PNG signature', (dataBase64) => {
    render(<MaskedScreenshot screenshot={{ mime: 'image/png', dataBase64, width: 1, height: 1, maskedRegions: 1 }} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('invalid PNG');
  });
});

describe('sessions, audit and fixed errors on each screen', () => {
  it('lists and revokes a device session without step-up', async () => {
    const fixture = await mount(); await openScreen('Sessions');
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke session Example device 2' }));
    await waitFor(() => expect(fixture.calls.some((call) => call.op === 'vault.sessions.revoke')).toBe(true));
    await screen.findByRole('heading', { name: 'Vault sessions' });
    await screen.findByText('revoked');
    expect(navigator.credentials.get).not.toHaveBeenCalled();
  });
  it('shows import audit entries and independent chain verification', async () => {
    const fixture = await mount(); await openScreen('Audit');
    await screen.findByText('item.imported');
    expect(screen.getByText('Chain verified; feed verified.')).toBeDefined();
    expect(fixture.calls.some((call) => call.op === 'vault.audit.verify')).toBe(true);
  });
  it('raises an alarm and locks writes when chain verification is broken', async () => {
    await mount({ chain: 'broken' }); await openScreen('Audit');
    await screen.findByRole('heading', { name: 'Audit chain broken' });
    expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('Vault writes are locked'))).toBe(true);
    await openScreen('Items');
    expect(screen.getByRole('button', { name: 'New item' }).hasAttribute('disabled')).toBe(true);
  });
  it('labels an unverified chain clearly', async () => {
    await mount({ chain: 'unverified' }); await openScreen('Audit');
    await screen.findByText('Chain unverified; feed unverified.');
  });
  it('fails closed on audit verification errors without showing a partially loaded feed', async () => {
    await mount({ errors: { 'vault.audit.verify': { details: { reason: 'audit_unavailable' } } } });
    await openScreen('Audit'); await screen.findByText('Audit is unavailable. The vault is read-only.');
    expect(screen.queryByText('item.imported')).toBeNull();
  });
  it.each([
    ['Items', 'vault.items.list'], ['Approvals', 'vault.approvals.list'], ['Passkeys', 'vault.passkeys.list'],
    ['Sessions', 'vault.sessions.list'], ['Audit', 'vault.audit.list'],
  ] as const)('renders a fixed error on %s', async (name, op) => {
    await mount({ errors: { [op]: { code: 'forbidden', message: generatedCanary() } } });
    await openScreen(name); await screen.findByText('This action was refused.');
  });
  it('renders the same unavailable copy for an inaccessible operation id', async () => {
    await mount({ errors: { 'vault.operations.get': { code: 'not_found', message: generatedCanary() } } });
    await openScreen('Operations');
    fireEvent.change(screen.getByLabelText('Operation ID'), { target: { value: ids.operation } });
    fireEvent.click(screen.getByRole('button', { name: 'Read operation' }));
    await screen.findByText('The requested record is unavailable.');
    expect(screen.queryByLabelText('Recorded operation outcome')).toBeNull();
  });
});

describe('canary sweep across every owner surface', () => {
  it('keeps generated fixture metadata and recovery codes out of storage, cookies, console and location', async () => {
    const canary = generatedCanary();
    const local = vi.spyOn(localStorage, 'setItem'); const session = vi.spyOn(sessionStorage, 'setItem');
    const cookie = vi.spyOn(document, 'cookie', 'set');
    const logs = Object.getOwnPropertyNames(console)
      .filter((method) => typeof (console as unknown as Record<string, unknown>)[method] === 'function')
      .map((method) => vi.spyOn(console, method as 'log').mockImplementation(() => {}));
    const push = vi.spyOn(history, 'pushState'); const replace = vi.spyOn(history, 'replaceState');
    const locationBefore = location.href; const cookieBefore = document.cookie;
    const fixture = await mount({ metadata: canary, responses: {
      'vault.recovery.codes.create': { codes: Array.from({ length: 10 }, (_, i) => `${canary}-${i}`), createdAt: new Date().toISOString() },
    } });
    fireEvent.click(screen.getByRole('button', { name: 'New item' }));
    await waitFor(() => expect(window.open).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole('button', { name: `${canary} login` }));
    await screen.findByRole('button', { name: `Revoke grant to ${canary} teammate` });
    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    await waitFor(() => expect(window.open).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Back to items' }));
    await openScreen('Approvals');
    fireEvent.click(await screen.findByRole('button', { name: `Review ${canary} login` }));
    await screen.findByText('Requesting actor');
    await openScreen('Passkeys');
    await screen.findByRole('button', { name: `Revoke ${canary} passkey 1` });
    fireEvent.click(screen.getByRole('button', { name: 'Create recovery codes' }));
    await screen.findByRole('region', { name: 'Recovery codes shown once' });
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close recovery codes' }));
    await openScreen('Sessions'); await screen.findByText(`${canary} device 1`);
    await openScreen('Audit'); await screen.findByText('item.imported');
    await openScreen('Operations');
    fireEvent.change(screen.getByLabelText('Operation ID'), { target: { value: ids.operation } });
    fireEvent.click(screen.getByRole('button', { name: 'Read operation' }));
    await screen.findByLabelText('Recorded operation outcome');
    expect(local).not.toHaveBeenCalled(); expect(session).not.toHaveBeenCalled(); expect(cookie).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
    expect(location.href).toBe(locationBefore); expect(document.cookie).toBe(cookieBefore);
    expect(location.href.includes(canary)).toBe(false);
    for (const log of logs) expect(JSON.stringify(log.mock.calls).includes(canary)).toBe(false);
    for (const storage of [localStorage, sessionStorage]) {
      expect(Array.from({ length: storage.length }, (_, i) => storage.getItem(storage.key(i)!)).join('').includes(canary)).toBe(false);
    }
    expect(fixture.calls.filter((call) => call.op === 'vault.recovery.codes.create').length).toBe(1);
  });
});
