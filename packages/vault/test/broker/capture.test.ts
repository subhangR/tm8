import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { VAULT_CAPTURE_LINK_TTL_SECONDS } from '@tm8/contract';
import { CaptureKeyPair, sealCapture } from '../../src/capture/seal.js';
import { memberScope } from '../../src/core-types.js';
import { decryptSecretVersion } from '../../src/crypto/aead.js';
import { KmsUnavailableError } from '../../src/crypto/kms.js';
import { SecretMaterial } from '../../src/secret-material.js';
import { fakeStepUpProof, otherCaller, testCaller } from '../support/kit.js';
import { harness, withoutRequestId, type Harness } from './support.js';

const opened: Harness[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const h of opened.splice(0)) await h.close(); });
async function setup(): Promise<Harness> { const h = await harness(); opened.push(h); return h; }

async function link(h: Harness, type = 'note', options: Record<string, unknown> = {}) {
  const response = await h.send('vault.captureLinks.create', { input: { clientMutationId: randomUUID(), itemType: type,
    purpose: 'create', ...options }, caller: { ...testCaller, kind: 'agent', sessionId: randomUUID() } });
  expect(response.status).toBe(200);
  const url = new URL(response.json.data.url as string);
  return { id: response.json.data.captureId as string, token: new URLSearchParams(url.hash.slice(1)).get('t')!, url,
    expiresAt: response.json.data.expiresAt as string };
}
async function submit(h: Harness, created: Awaited<ReturnType<typeof link>>, payload: Record<string, unknown>) {
  const bytes = Buffer.from(JSON.stringify(payload));
  try {
    const sealed = sealCapture(bytes, h.components.captureKeys.publicKey(), created.id);
    return await h.send('vault.captures.submit', { params: { captureId: created.id }, input: { clientMutationId: randomUUID(),
      linkToken: created.token, sealed, stepUp: fakeStepUpProof() } });
  } finally { bytes.fill(0); }
}

describe('acceptance 20: capture link boundary', () => {
  it('lets an agent issue a fragment-only link, stores only a hash, and returns only a public capture key', async () => {
    const h = await setup();
    const created = await link(h);
    expect(created.url.pathname).toBe(`/vault/capture/${created.id}`);
    expect(created.url.search).toBe('');
    expect(created.token).toHaveLength(43);
    // The fragment carries the token and the space the page must act in, nothing else.
    const fragment = new URLSearchParams(created.url.hash.slice(1));
    expect([...fragment.keys()]).toEqual(['t', 's']);
    expect(fragment.get('s')).toBe(testCaller.spaceId);
    expect(Date.parse(created.expiresAt) - h.clock.now().getTime()).toBe(VAULT_CAPTURE_LINK_TTL_SECONDS * 1000);
    const rows = await h.store.transaction({ kind: 'system', purpose: 'audit' }, (tx) => tx.audit.range(1, 10));
    expect(JSON.stringify(rows).includes(created.token)).toBe(false);
    const open = await h.send('vault.captures.open', { params: { captureId: created.id },
      input: { clientMutationId: randomUUID(), linkToken: created.token } });
    expect(open.status).toBe(200);
    expect(Object.keys(open.json.data.publicKey.jwk).sort()).toEqual(['crv', 'ext', 'kty', 'x', 'y']);
    // A store lookup accepts the SHA-256 hash; presenting the raw token in that slot never finds it.
    const { createHash } = await import('node:crypto');
    const record = await h.store.transaction(memberScope(testCaller), (tx) => tx.captureLinks.getUsable(created.id, createHash('sha256').update(created.token).digest('hex')));
    expect(record !== null).toBe(true);
    expect(Object.hasOwn(record!, 'token')).toBe(false);
    expect(JSON.stringify(record).includes(created.token)).toBe(false);
  });
  it('consumes a link once at submit and makes reuse indistinguishable from unknown', async () => {
    const h = await setup();
    const created = await link(h);
    const marker = ['test-only-secret-note', randomUUID()].join('-');
    const saved = await submit(h, created, { type: 'note', name: 'Test note', body: marker });
    expect(saved.status).toBe(200);
    expect(saved.text.includes(marker)).toBe(false);
    const reused = await h.send('vault.captures.open', { params: { captureId: created.id }, input: { clientMutationId: randomUUID(), linkToken: created.token } });
    const unknown = await h.send('vault.captures.open', { params: { captureId: randomUUID() }, input: { clientMutationId: randomUUID(), linkToken: created.token } });
    expect(reused.status).toBe(403);
    expect(withoutRequestId(reused)).toEqual(withoutRequestId(unknown));
    const again = await submit(h, created, { type: 'note', name: 'Another note', body: 'test-only' });
    expect(again.json.error.details.reason).toBe('capture_link_invalid');
    const secret = await h.store.transaction(memberScope(testCaller), (tx) => tx.items.currentSecret(saved.json.data.id as string));
    const material = await decryptSecretVersion(h.components.kms, secret!, { itemId: saved.json.data.id as string, ownerId: testCaller.memberId, version: 1 });
    try { expect(material.use((bytes) => JSON.parse(bytes.toString()).body === marker)).toBe(true); }
    finally { material.dispose(); }
  });
  it('commits exactly one of two simultaneous submissions', async () => {
    const h = await setup();
    const created = await link(h);
    const outcomes = await Promise.all([1, 2].map(() => submit(h, created, { type: 'note', name: 'Test note', body: 'test-only' })));
    expect(outcomes.map((response) => response.status).sort()).toEqual([200, 403]);
    expect(await h.store.transaction(memberScope(testCaller), (tx) => tx.items.countOwned())).toBe(1);
  });
  it('gives the same refusal for expiry, another member, wrong token and an unknown link', async () => {
    const h = await setup();
    const created = await link(h);
    const input = { clientMutationId: randomUUID(), linkToken: created.token };
    const unknown = await h.send('vault.captures.open', { params: { captureId: randomUUID() }, input });
    const wrong = await h.send('vault.captures.open', { params: { captureId: created.id }, input: { ...input, linkToken: 'A'.repeat(43) } });
    const ownerSession = h.auth.session;
    h.auth.session = { ...ownerSession!, memberId: otherCaller.memberId };
    const foreign = await h.send('vault.captures.open', { caller: otherCaller, params: { captureId: created.id }, input });
    h.auth.session = ownerSession;
    h.clock.advanceSeconds(VAULT_CAPTURE_LINK_TTL_SECONDS);
    const expired = await h.send('vault.captures.open', { params: { captureId: created.id }, input });
    for (const response of [unknown, wrong, foreign, expired]) {
      expect(response.status).toBe(403);
      expect(response.json.error.details.reason).toBe('capture_link_invalid');
      expect(withoutRequestId(response)).toEqual(withoutRequestId(unknown));
    }
  });
  it('refuses a token in a query without consuming the valid body token', async () => {
    const h = await setup();
    const created = await link(h);
    const input = { clientMutationId: randomUUID(), linkToken: created.token };
    const response = await h.send('vault.captures.open', { params: { captureId: created.id }, query: `linkToken=${created.token}`, input });
    expect(response.status).toBe(400);
    expect(response.text.includes(created.token)).toBe(false);
    expect((await h.send('vault.captures.open', { params: { captureId: created.id }, input })).status).toBe(200);
  });
  it('distinguishes a valid old link after key rotation from an invalid link', async () => {
    const h = await setup();
    const created = await link(h);
    h.components.captureKeys.destroy();
    h.components.captureKeys = CaptureKeyPair.generate();
    const response = await h.send('vault.captures.open', { params: { captureId: created.id }, input: { clientMutationId: randomUUID(), linkToken: created.token } });
    expect(response.status).toBe(409);
    expect(response.json.error.details.reason).toBe('capture_key_rotated');
  });
});

describe('capture encryption, metadata and failure handling', () => {
  it('rejects credential-shaped names before persisting an item or consuming its link', async () => {
    const h = await setup();
    const created = await link(h);
    const shaped = ['gh', 'p_', 'A'.repeat(36)].join('');
    const response = await submit(h, created, { type: 'note', name: shaped, body: 'test-only' });
    expect(response.status).toBe(400);
    expect(response.json.error.details.reason).toBe('secret_in_metadata');
    expect(response.text.includes(shaped)).toBe(false);
    expect(await h.store.transaction(memberScope(testCaller), (tx) => tx.items.countOwned())).toBe(0);
    expect((await submit(h, created, { type: 'note', name: 'Safe test name', body: 'test-only' })).status).toBe(200);
  });
  it('zeroizes the unsealed bytes and disposes secret material when the KMS fails', async () => {
    const h = await setup();
    const created = await link(h);
    const unsealed = Buffer.from(JSON.stringify({ type: 'note', name: 'Test note', body: 'test-only' }));
    h.components.captureKeys.open = () => unsealed;
    h.components.kms.wrap = async () => { throw new KmsUnavailableError('test-only-unavailable'); };
    const disposed = vi.spyOn(SecretMaterial.prototype, 'dispose');
    const response = await h.send('vault.captures.submit', { params: { captureId: created.id }, input: {
      clientMutationId: randomUUID(), linkToken: created.token, sealed: { v: 1, kid: h.components.captureKeys.kid,
        epk: 'A'.repeat(87), nonce: 'A'.repeat(16), ct: 'A'.repeat(23) }, stepUp: fakeStepUpProof(),
    } });
    expect(response.status).toBe(503);
    expect(response.json.error.details.reason).toBe('kms_unavailable');
    expect(unsealed.every((byte) => byte === 0)).toBe(true);
    expect(disposed.mock.instances.length).toBeGreaterThanOrEqual(2);
    expect(disposed.mock.instances.every((material) => material instanceof SecretMaterial && material.disposed)).toBe(true);
  });
  it('rolls back item creation and token consumption if audit append fails', async () => {
    const h = await setup();
    const created = await link(h);
    h.store.faults.auditAppend = true;
    const response = await submit(h, created, { type: 'note', name: 'Test note', body: 'test-only' });
    expect(response.status).toBe(503);
    expect(h.audit.appendFailures).toBe(1);
    h.store.faults.auditAppend = false;
    expect(await h.store.transaction(memberScope(testCaller), (tx) => tx.items.countOwned())).toBe(0);
    expect((await submit(h, created, { type: 'note', name: 'Test note', body: 'test-only' })).status).toBe(200);
  });
});

/** Text from code points, so this file holds no invisible character and no escape a tool could rewrite. */
const cp = (...points: number[]) => String.fromCodePoint(...points);

async function submitBytes(h: Harness, created: Awaited<ReturnType<typeof link>>, bytes: Buffer) {
  try {
    const sealed = sealCapture(bytes, h.components.captureKeys.publicKey(), created.id);
    return await h.send('vault.captures.submit', { params: { captureId: created.id }, input: { clientMutationId: randomUUID(),
      linkToken: created.token, sealed, stepUp: fakeStepUpProof() } });
  } finally { bytes.fill(0); }
}

describe('capture content checks (review addendum 2, C6)', () => {
  it('refuses an agent-suggested link name holding a text-direction override, a control or a tag character', async () => {
    const h = await setup();
    const hidden = cp(...[...'ignore'].map((letter) => 0xe0000 + letter.charCodeAt(0)));
    for (const name of [`Bank${cp(0x202e)}moc.evil`, `Bank${cp(0x2066)}x${cp(0x2069)}`, `Bank${cp(0x1b)}[2J`, `Bank${cp(0x85)}x`, `Bank${cp(0x2028)}x`,
      `Bank${hidden}`]) {
      const response = await h.send('vault.captureLinks.create', { input: { clientMutationId: randomUUID(), itemType: 'note',
        purpose: 'create', name }, caller: { ...testCaller, kind: 'agent', sessionId: randomUUID() } });
      expect(response.status).toBe(400);
      expect(response.json.error.code).toBe('invalid_input');
      expect(response.text.includes(name)).toBe(false);
    }
    const safe = `${cp(0xc24, 0xc46, 0xc32, 0xc41, 0xc17, 0xc41)} ${cp(0x200e)}notes`;
    const created = await link(h, 'note', { name: safe });
    const open = await h.send('vault.captures.open', { params: { captureId: created.id }, input: { clientMutationId: randomUUID(), linkToken: created.token } });
    expect(open.status).toBe(200);
    expect(open.json.data.itemName).toBe(safe);
  });

  it('refuses malformed UTF-8 and lone surrogates before storing an item or consuming the link', async () => {
    const h = await setup();
    const created = await link(h);
    const prefix = Buffer.from('{"type":"note","name":"Synthetic note","body":"synthetic');
    for (const bad of [[0xff], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xe2, 0x82]]) {
      const response = await submitBytes(h, created, Buffer.concat([prefix, Buffer.from(bad), Buffer.from('"}')]));
      expect(response.status).toBe(400);
      expect(response.json.error.code).toBe('invalid_input');
    }
    const lone = await submit(h, created, { type: 'note', name: 'Synthetic note', body: `synthetic${String.fromCharCode(0xd800)}` });
    expect(lone.status).toBe(400);
    expect(lone.json.error.code).toBe('invalid_input');
    expect(await h.store.transaction(memberScope(testCaller), (tx) => tx.items.countOwned())).toBe(0);
    expect((await submit(h, created, { type: 'note', name: 'Synthetic note', body: 'test-only' })).status).toBe(200);
  });

  it('refuses unsafe names and usernames, and stores safe non-Latin labels unchanged', async () => {
    const h = await setup();
    const created = await link(h, 'login');
    // Synthetic, and assembled so the source holds no credential-shaped literal.
    const base = { type: 'login', name: 'Synthetic', origin: 'https://example.com', password: ['test', 'only', 'value'].join('-') };
    for (const payload of [{ ...base, name: `Pay${cp(0x202e)}lap` }, { ...base, username: `octo${cp(0x9)}x` }, { ...base, username: `octo${cp(0x2028)}` }]) {
      const response = await submit(h, created, payload);
      expect(response.status).toBe(400);
      expect(response.json.error.code).toBe('invalid_input');
    }
    expect(await h.store.transaction(memberScope(testCaller), (tx) => tx.items.countOwned())).toBe(0);
    const name = `${cp(0xc15, 0xc4d, 0x200c)}x ${cp(0x1f469, 0x200d, 0x1f4bb)}`;
    const username = `${cp(0x5e9, 0x5dc, 0x5d5, 0x5dd)}${cp(0x200f)}`;
    const stored = await submit(h, created, { ...base, name, username });
    expect(stored.status).toBe(200);
    expect(stored.json.data).toMatchObject({ name, username });
  });
});
