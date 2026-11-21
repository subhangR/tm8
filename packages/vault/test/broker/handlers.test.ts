import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BROKER_CORE_OPS, actorOf, memberScope } from '../../src/core-types.js';
import { sealCapture } from '../../src/capture/seal.js';
import { createImportParser } from '../../src/import/index.js';
import { createBrokerCoreHandlers } from '../../src/broker/handlers/index.js';
import { decryptSecretVersion } from '../../src/crypto/aead.js';
import { FakeOwnerAuth, MemoryDeletionLedger, fakeStepUpProof, newApiKey, newLogin, otherCaller, seedItem, testCaller } from '../support/kit.js';
import { harness, type Harness } from './support.js';

const opened: Harness[] = [];
afterEach(async () => { for (const h of opened.splice(0)) await h.close(); });
async function setup(): Promise<Harness> { const h = await harness(); opened.push(h); return h; }
const command = () => ({ clientMutationId: randomUUID() });
const stepCommand = () => ({ ...command(), stepUp: fakeStepUpProof() });

describe('core item, grant and audit handlers', () => {
  it('covers exactly the twenty broker-core operations', () => {
    expect(Object.keys(createBrokerCoreHandlers()).sort()).toEqual([...BROKER_CORE_OPS].sort());
  });
  it('returns scoped metadata, updates it by compare-and-set, and summarizes activity', async () => {
    const h = await setup();
    const item = await seedItem(h.store, testCaller, newLogin(testCaller, { origins: ['https://login.example.com'] }));
    const listed = await h.send('vault.items.list');
    expect(listed.json.data.items.map((row: { id: string }) => row.id)).toEqual([item.id]);
    const updated = await h.send('vault.items.update', { params: { itemId: item.id }, input: { ...command(), expectedVersion: item.version, name: 'Updated note', username: 'test-user-new' } });
    expect(updated.status).toBe(200);
    expect(updated.json.data.version).toBe(2);
    const stale = await h.send('vault.items.update', { params: { itemId: item.id }, input: { ...command(), expectedVersion: 1, name: 'Stale' } });
    expect(stale.status).toBe(409);
    expect(stale.json.error.details.currentVersion).toBe(2);
    const changed = await h.send('vault.items.setProperties', { params: { itemId: item.id }, input: { ...stepCommand(), expectedVersion: 2,
      addOrigins: ['https://example.com'], removeOrigins: item.origins, devMode: false } });
    expect(changed.status).toBe(200);
    expect(changed.json.data.origins).toEqual(['https://example.com']);
    await h.store.transaction(memberScope(testCaller), async (tx) => {
      for (const action of ['fill.done', 'fill.done', 'api.done']) await tx.audit.append({ action, actor: { kind: 'agent', memberId: testCaller.memberId,
        sessionId: null, name: null }, itemId: item.id, subjectMemberId: testCaller.memberId, spaceId: testCaller.spaceId,
      params: action === 'api.done' ? { host: 'api.example.com' } : { origin: 'https://example.com' } });
    });
    const activity = await h.send('vault.items.activity', { params: { itemId: item.id }, query: 'days=7' });
    expect(activity.status).toBe(200);
    expect(activity.json.data.uses).toMatchObject([{ fills: 2, apiCalls: 1, origins: ['https://example.com'], hosts: ['api.example.com'] }]);
    const audit = await h.send('vault.audit.list');
    expect(audit.status).toBe(200);
    expect(audit.json.data.events.some((event: { action: string }) => event.action === 'item.updated')).toBe(true);
    let fullVerified = false;
    h.audit.verifyAll = async () => { fullVerified = true; return h.audit.verification; };
    const checkpoint = await h.store.transaction({ kind: 'system', purpose: 'audit' }, async (tx) => {
      const head = await tx.audit.head();
      await tx.audit.recordCheckpoint({ seq: head.seq, headHash: head.hash, at: h.clock.iso(), sink: 'file', anchored: true,
        location: 'test-only-checkpoint', keyId: 'test-only', signature: 'AAAA' });
      return { seq: head.seq, at: h.clock.iso(), sink: 'file', anchored: true };
    });
    const verified = await h.send('vault.audit.verify');
    expect(fullVerified).toBe(true);
    expect(verified.json.data.checkpoint).toEqual(checkpoint);
  });
  it('refuses credential-shaped metadata on update and checks the human assertion inside handlers', async () => {
    const h = await setup();
    const item = await seedItem(h.store);
    const shaped = ['gh', 'p_', 'B'.repeat(36)].join('');
    const response = await h.send('vault.items.update', { params: { itemId: item.id }, input: { ...command(), expectedVersion: 1, username: shaped } });
    expect(response.json.error.details.reason).toBe('secret_in_metadata');
    const ctx = await h.context('vault.items.update', { caller: { ...testCaller, kind: 'agent', sessionId: randomUUID() } });
    await expect(createBrokerCoreHandlers()['vault.items.update'](ctx, { params: { itemId: item.id }, input: { ...command(), expectedVersion: 1, name: 'Test' } })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('checks ownership and version before the durable ledger, then writes the ledger before tombstoning', async () => {
    const h = await setup();
    const item = await seedItem(h.store);
    const ledger = h.components.deletionLedger as MemoryDeletionLedger;
    const original = ledger.append.bind(ledger);
    let liveAtAppend = false;
    ledger.append = async (entry) => {
      liveAtAppend = (await h.store.transaction(memberScope(testCaller), (tx) => tx.items.currentSecret(item.id))) !== null;
      await original(entry);
    };
    const stale = await h.send('vault.items.delete', { params: { itemId: item.id }, input: { ...stepCommand(), expectedVersion: 7 } });
    expect(stale.status).toBe(409);
    expect(await ledger.entries()).toHaveLength(0);
    const response = await h.send('vault.items.delete', { params: { itemId: item.id }, input: { ...stepCommand(), expectedVersion: 1 } });
    expect(response.status).toBe(200);
    expect(liveAtAppend).toBe(true);
    expect(await ledger.entries()).toHaveLength(1);
    expect(await h.store.transaction(memberScope(testCaller), (tx) => tx.items.currentSecret(item.id))).toBe(null);
    expect((await h.store.transaction(memberScope(testCaller), (tx) => tx.items.get(item.id)))!.state).toBe('tombstoned');
  });
  it('does not tombstone when ledger append fails, and retains durable intent when the audit transaction fails', async () => {
    const h = await setup();
    const item = await seedItem(h.store);
    const ledger = h.components.deletionLedger as MemoryDeletionLedger;
    ledger.failAppend = true;
    expect((await h.send('vault.items.delete', { params: { itemId: item.id }, input: { ...stepCommand(), expectedVersion: 1 } })).status).toBe(500);
    expect((await h.store.transaction(memberScope(testCaller), (tx) => tx.items.get(item.id)))!.state).toBe('active');
    ledger.failAppend = false;
    h.store.faults.auditAppend = true;
    expect((await h.send('vault.items.delete', { params: { itemId: item.id }, input: { ...stepCommand(), expectedVersion: 1 } })).status).toBe(503);
    expect(await ledger.entries()).toHaveLength(1);
    expect((await h.store.transaction(memberScope(testCaller), (tx) => tx.items.get(item.id)))!.state).toBe('active');
  });
  it('sets policies only on API keys and refuses invalid connector and host constraints', async () => {
    const h = await setup();
    const login = await seedItem(h.store);
    const api = await seedItem(h.store, testCaller, newApiKey());
    const policy = { mode: 'generic', connector: null, hosts: ['api.example.com'], methods: ['GET'], pathPrefixes: ['/v1'], maxRequestBytes: 1024,
      maxResponseBytes: 1024, injection: { kind: 'bearer' } };
    const wrong = await h.send('vault.policies.set', { params: { itemId: login.id }, input: { ...stepCommand(), expectedVersion: 1, policy } });
    expect(wrong.json.error.details.reason).toBe('wrong_item_type');
    expect((await h.send('vault.policies.set', { params: { itemId: api.id }, input: { ...stepCommand(), expectedVersion: 1,
      policy: { ...policy, hosts: ['127.0.0.1'] } } })).status).toBe(400);
    const good = await h.send('vault.policies.set', { params: { itemId: api.id }, input: { ...stepCommand(), expectedVersion: 1, policy } });
    expect(good.status).toBe(200);
    expect(good.json.data.policy.hosts).toEqual(['api.example.com']);
    expect(good.json.data.version).toBe(2);
  });
  it('stores a connector policy only for a built-in template with vetted operations (review F02)', async () => {
    const h = await setup();
    const api = await seedItem(h.store, testCaller, newApiKey());
    const github = { mode: 'connector', connector: 'github', hosts: ['api.github.com'], methods: ['GET'], pathPrefixes: ['/repos'],
      maxRequestBytes: 1024, maxResponseBytes: 1024, injection: { kind: 'bearer' } };
    // 'constructor' passes the contract's id pattern and used to reach Object.prototype through
    // the registry lookup; 'unknown' names no template.
    for (const connector of ['constructor', 'unknown']) {
      const refused = await h.send('vault.policies.set', { params: { itemId: api.id }, input: { ...stepCommand(), expectedVersion: 1,
        policy: { ...github, connector } } });
      expect(refused.status).toBe(400);
      expect(refused.json.error.code).toBe('invalid_input');
    }
    expect((await h.send('vault.policies.set', { params: { itemId: api.id }, input: { ...stepCommand(), expectedVersion: 1,
      policy: { ...github, hosts: ['api.github.com', 'uploads.github.com'] } } })).status).toBe(400);
    const good = await h.send('vault.policies.set', { params: { itemId: api.id }, input: { ...stepCommand(), expectedVersion: 1, policy: github } });
    expect(good.status).toBe(200);
    expect(good.json.data.policy).toMatchObject({ mode: 'connector', connector: 'github', hosts: ['api.github.com'] });
  });
  it('shows the mode a stored policy runs in, so a connector row without vetted operations reads generic (review F02)', async () => {
    const h = await setup();
    const api = await seedItem(h.store, testCaller, newApiKey());
    // vault.policies.set refuses this row (test above). It exists only if written below the handlers,
    // or if a template were retired, and the egress runs it in generic mode either way.
    await h.store.transaction(memberScope(testCaller), (tx) => tx.policies.set(api.id, 1, { mode: 'connector', connector: 'retired_connector',
      hosts: ['api.github.com'], methods: ['GET'], pathPrefixes: ['/user'], maxRequestBytes: 1024, maxResponseBytes: 1024,
      injection: { kind: 'bearer' } }, actorOf(testCaller)));
    const detail = await h.send('vault.items.get', { params: { itemId: api.id } });
    expect(detail.status).toBe(200);
    expect(detail.json.data.policy).toMatchObject({ mode: 'generic', connector: 'retired_connector', hosts: ['api.github.com'] });
  });
  it('creates use-only grants, projects constrained metadata and revokes with only a session', async () => {
    const h = await setup();
    const item = await seedItem(h.store, testCaller, newLogin(testCaller, { origins: ['https://example.com', 'https://other.example.com'] }));
    const created = await h.send('vault.grants.create', { params: { itemId: item.id }, input: { ...stepCommand(), grantee: { kind: 'member', id: otherCaller.memberId },
      constraints: { origins: ['https://example.com'], hosts: null, requireApprovalPerUse: true }, expiresAt: null } });
    expect(created.status).toBe(200);
    const saved = h.auth.session;
    h.auth.session = FakeOwnerAuth.signedIn(h.clock, otherCaller).session;
    const shared = await h.send('vault.items.get', { caller: otherCaller, params: { itemId: item.id } });
    expect(shared.status).toBe(200);
    expect(shared.json.data.access).toBe('grant');
    expect(shared.json.data.origins).toEqual(['https://example.com']);
    const denied = await h.send('vault.items.update', { caller: otherCaller, params: { itemId: item.id }, input: { ...command(), expectedVersion: 1, name: 'No authority' } });
    expect(denied.status).toBe(404);
    h.auth.session = saved;
    h.auth.mode = 'invalid';
    const revoked = await h.send('vault.grants.revoke', { params: { grantId: created.json.data.id as string }, input: command() });
    expect(revoked.status).toBe(200);
    const missing = await h.send('vault.items.get', { caller: otherCaller, params: { itemId: item.id } });
    expect(missing.status).toBe(404);
    const listed = await h.send('vault.grants.list', { params: { itemId: item.id } });
    expect(listed.status).toBe(200);
    expect(listed.json.data.grants[0].revokedAt !== null).toBe(true);
  });
  it('refuses grant creation while audit is unhealthy but allows revocation', async () => {
    const h = await setup();
    const item = await seedItem(h.store);
    h.audit.state = 'unavailable';
    const result = await h.send('vault.grants.create', { params: { itemId: item.id }, input: { ...stepCommand(), grantee: { kind: 'member', id: otherCaller.memberId },
      constraints: { origins: null, hosts: null, requireApprovalPerUse: false }, expiresAt: null } });
    expect(result.json.error.details.reason).toBe('audit_unavailable');
  });
});

async function upload(h: Harness, csv: string) {
  h.components.importParser = createImportParser();
  const begun = await h.send('vault.imports.begin');
  expect(begun.status).toBe(200);
  const id = begun.json.data.importId as string;
  const bytes = Buffer.from(csv);
  try {
    const sealed = sealCapture(bytes, h.components.captureKeys.publicKey(), id);
    const response = await h.send('vault.imports.upload', { params: { importId: id }, input: { ...command(), sealed } });
    expect(response.status).toBe(200);
    return { id, response };
  } finally { bytes.fill(0); }
}

describe('import state and sealed export lifetime', () => {
  it('keeps previews metadata-only, commits tier a blocked, then rotation makes it active', async () => {
    const h = await setup();
    const marker = ['test-only-password', randomUUID()].join('-');
    const imported = await upload(h, `name,url,username,password\nTest login,https://example.com,test-user,${marker}\n`);
    expect(imported.response.text.includes(marker)).toBe(false);
    const committed = await h.send('vault.imports.commit', { params: { importId: imported.id }, input: { ...stepCommand(), rows: [{ index: 0, include: true, exposureTier: 'a' }] } });
    expect(committed.status).toBe(200);
    expect(committed.json.data.created[0].state).toBe('blocked_until_rotated');
    const itemId = committed.json.data.created[0].itemId as string;
    const before = await h.store.transaction(memberScope(testCaller), (tx) => tx.items.get(itemId));
    expect(before!.state).toBe('blocked_until_rotated');
    const capture = await h.send('vault.captureLinks.create', { input: { ...command(), itemType: 'login', purpose: 'replace', itemId } });
    const link = new URL(capture.json.data.url as string);
    const token = new URLSearchParams(link.hash.slice(1)).get('t')!;
    const captureId = capture.json.data.captureId as string;
    const rotatedValue = ['test-only', 'rotated-value'].join('-');
    const bytes = Buffer.from(JSON.stringify({ type: 'login', name: 'Rotated login', origin: 'https://example.com', username: 'test-user', password: rotatedValue }));
    try {
      const rotated = await h.send('vault.captures.submit', { params: { captureId }, input: { ...stepCommand(), linkToken: token,
        sealed: sealCapture(bytes, h.components.captureKeys.publicKey(), captureId) } });
      expect(rotated.status).toBe(200);
      expect(rotated.json.data.state).toBe('active');
      expect(rotated.json.data.secretVersion).toBe(2);
    } finally { bytes.fill(0); }
    const version = await h.store.transaction(memberScope(testCaller), (tx) => tx.items.currentSecret(itemId));
    const secret = await decryptSecretVersion(h.components.kms, version!, { itemId, ownerId: testCaller.memberId, version: 2 });
    try { expect(secret.use((value) => JSON.parse(value.toString()).password === rotatedValue)).toBe(true); }
    finally { secret.dispose(); }
    expect((await h.send('vault.imports.cancel', { params: { importId: imported.id } })).status).toBe(404);
  });
  it('refuses an invalid origin until an explicit normalized override is bound in the commit', async () => {
    const h = await setup();
    const imported = await upload(h, 'name,url,username,password\nTest login,http://localhost,test-user,test-only\n');
    expect(imported.response.json.data.candidates[0].originError).toBe('scheme_not_https');
    const refused = await h.send('vault.imports.commit', { params: { importId: imported.id }, input: { ...stepCommand(), rows: [{ index: 0, include: true, exposureTier: 'b' }] } });
    expect(refused.json.error.details.reason).toBe('origin_refused');
    h.clock.advanceSeconds(60);
    const retried = await upload(h, 'name,url,username,password\nTest login,http://localhost,test-user,test-only\n');
    const fixed = await h.send('vault.imports.commit', { params: { importId: retried.id }, input: { ...stepCommand(), rows: [{ index: 0, include: true, exposureTier: 'c', originOverride: 'https://example.com' }] } });
    expect(fixed.status).toBe(200);
    expect(fixed.json.data.created[0].state).toBe('active');
  });
  it('drops cancelled, expired and failed-commit sessions, and refuses duplicate indices atomically', async () => {
    const h = await setup();
    const imported = await upload(h, 'name,url,username,password\nTest login,https://example.com,test-user,test-only\n');
    expect((await h.send('vault.imports.cancel', { params: { importId: imported.id } })).status).toBe(200);
    expect((await h.send('vault.imports.cancel', { params: { importId: imported.id } })).status).toBe(404);
    h.clock.advanceSeconds(60);
    const duplicated = await upload(h, 'name,url,username,password\nTest login,https://example.com,test-user,test-only\n');
    const row = { index: 0, include: true, exposureTier: 'b' };
    const response = await h.send('vault.imports.commit', { params: { importId: duplicated.id }, input: { ...stepCommand(), rows: [row, row] } });
    expect(response.status).toBe(400);
    expect(await h.store.transaction(memberScope(testCaller), (tx) => tx.items.countOwned())).toBe(0);
    expect((await h.send('vault.imports.cancel', { params: { importId: duplicated.id } })).status).toBe(404);
    h.clock.advanceSeconds(60);
    const expiring = await h.send('vault.imports.begin');
    h.clock.advanceSeconds(601);
    expect((await h.send('vault.imports.cancel', { params: { importId: expiring.json.data.importId as string } })).status).toBe(404);
  });
});
