import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_QUEUED_ALERTS, RelayAlertQueue } from '../../src/broker/alerts.js';
import { buildCanarySet } from '../../src/canary/index.js';
import { VAULT_ALERT_KINDS, type VaultAlert } from '../../src/core-types.js';
import {
  VAULT_ALERTS_HEADER, VAULT_ALERTS_HEADER_MAX_CHARS, VAULT_ALERTS_MAX_PER_HEADER, VaultAlertHeaderError,
  decodeVaultAlerts, encodeVaultAlerts,
} from '../../src/relay/alerts.js';
import { MEMBER_ID, OWNER_ID, SPACE_A } from '../support/kit.js';
import { harness, type Harness } from './support.js';

// Assembled at runtime: no decoy-shaped literal in the tree.
const decoy = ['vault', 'alert', 'test', 'decoy', 'value'].join('-');
const canaries = buildCanarySet([decoy]);
const alert = (patch: Partial<VaultAlert> = {}): VaultAlert => ({ kind: 'egress_refused', memberId: OWNER_ID, spaceId: SPACE_A,
  itemId: null, params: { host: 'api.example.com', status: 403, retried: false }, at: '2026-11-21T00:00:00.000Z', ...patch });
const queue = (capacity?: number) => new RelayAlertQueue({ canaries, ...(capacity === undefined ? {} : { capacity }) });
const decodeAll = (alerts: RelayAlertQueue): { dropped: number; alerts: VaultAlert[] }[] => {
  const batches = [];
  for (let header = alerts.take(); header !== null; header = alerts.take()) {
    expect(header.length).toBeLessThanOrEqual(VAULT_ALERTS_HEADER_MAX_CHARS);
    batches.push(decodeVaultAlerts(header)!);
  }
  return batches;
};

describe('relay alert queue', () => {
  it('round-trips every alert kind, oldest first, and is empty afterwards', () => {
    const alerts = queue();
    const raised = VAULT_ALERT_KINDS.map((kind, n) => alert({ kind, itemId: n % 2 ? randomUUID() : null, memberId: n % 3 ? OWNER_ID : MEMBER_ID }));
    for (const value of raised) alerts.raise(value);
    expect(alerts.pending).toBe(raised.length);
    expect(decodeAll(alerts)).toEqual([{ dropped: 0, alerts: raised }]);
    expect(alerts.pending).toBe(0);
    expect(alerts.take()).toBeNull();
  });

  it('stores a frozen copy, so a later change by the raiser is not carried', () => {
    const alerts = queue();
    const value = alert();
    alerts.raise(value);
    (value.params as Record<string, unknown>).host = 'changed.example.com';
    (value as { memberId: string }).memberId = MEMBER_ID;
    expect(decodeAll(alerts)[0]!.alerts).toEqual([alert()]);
  });

  it.each([
    ['an invalid key', { '1host': 'api.example.com' }],
    ['a control character', { host: 'api.example.com\u0007' }],
    ['seventeen entries', Object.fromEntries(Array.from({ length: 17 }, (_, n) => [`p${n}`, n]))],
    ['a nested object', { request: { host: 'api.example.com' } }],
    ['a long array', { hosts: Array.from({ length: 33 }, () => 'api.example.com') }],
    ['a long string', { host: 'a'.repeat(513) }],
    ['a non-finite number', { ms: Number.POSITIVE_INFINITY }],
    ['a planted decoy', { host: `${decoy}.example.com` }],
    ['an encoded decoy', { note: Buffer.from(decoy).toString('base64') }],
    ['more than half the header budget', Object.fromEntries(Array.from({ length: 16 }, (_, n) => [`p${n}`, 'a'.repeat(400)]))],
  ])('keeps the kind, ids and time but no params for %s', (_name, params) => {
    const alerts = queue();
    alerts.raise(alert({ params: params as VaultAlert['params'] }));
    const [batch] = decodeAll(alerts);
    expect(batch).toEqual({ dropped: 0, alerts: [alert({ params: {} })] });
    expect(JSON.stringify(batch)).not.toContain(decoy);
  });

  it('counts, and never carries, an alert whose own fields fail the schema', () => {
    const alerts = queue();
    alerts.raise(alert({ memberId: 'not-a-uuid' }));
    alerts.raise(alert({ kind: 'unknown_kind' as VaultAlert['kind'] }));
    alerts.raise(alert({ at: '2026-11-21 00:00:00' }));
    alerts.raise(alert({ itemId: decoy }));
    expect(alerts.pending).toBe(0);
    expect(alerts.dropped).toBe(4);
    expect(decodeAll(alerts)).toEqual([{ dropped: 4, alerts: [] }]);
    expect(alerts.dropped).toBe(0);
    expect(alerts.take()).toBeNull();
  });

  it('is bounded, counts overflow and reports it with the next batch', () => {
    const alerts = queue(2);
    for (let n = 0; n < 5; n += 1) alerts.raise(alert({ params: { n } }));
    expect([alerts.pending, alerts.dropped]).toEqual([2, 3]);
    expect(decodeAll(alerts)).toEqual([{ dropped: 3, alerts: [alert({ params: { n: 0 } }), alert({ params: { n: 1 } })] }]);
    const defaults = queue();
    for (let n = 0; n <= MAX_QUEUED_ALERTS; n += 1) defaults.raise(alert());
    expect([defaults.pending, defaults.dropped]).toEqual([MAX_QUEUED_ALERTS, 1]);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses capacity %s', (capacity) => {
    expect(() => queue(capacity)).toThrow('vault alerts: invalid capacity');
  });

  it('splits by count and by the header budget without losing or reordering an alert', () => {
    const small = queue();
    for (let n = 0; n < 40; n += 1) small.raise(alert({ params: { n } }));
    // Measured: about 24 ordinary alerts fill one 6 KiB header, so the budget binds before the count cap.
    const sizes = decodeAll(small).map((batch) => batch.alerts.length);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(40);
    expect(sizes[0]).toBeGreaterThan(16);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(VAULT_ALERTS_MAX_PER_HEADER);

    const large = queue();
    const big = (n: number) => alert({ params: { n, ...Object.fromEntries(Array.from({ length: 4 }, (_, k) => [`p${k}`, 'a'.repeat(450)])) } });
    for (let n = 0; n < 7; n += 1) large.raise(big(n));
    const batches = decodeAll(large);
    expect(batches.length).toBeGreaterThan(2);
    expect(batches.flatMap((batch) => batch.alerts)).toEqual(Array.from({ length: 7 }, (_, n) => big(n)));
  });
});

describe('alert header codec', () => {
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const valid = { v: 1, dropped: 0, alerts: [alert()] };

  it('returns null for an absent header and round-trips a valid one', () => {
    expect(decodeVaultAlerts(undefined)).toBeNull();
    expect(decodeVaultAlerts(encodeVaultAlerts({ dropped: 2, alerts: [alert()] }))).toEqual({ dropped: 2, alerts: [alert()] });
  });

  it.each([
    ['an array', ['e30']],
    ['empty', ''],
    ['over budget', 'A'.repeat(VAULT_ALERTS_HEADER_MAX_CHARS + 1)],
    ['padding', `${encoded(valid)}=`],
    ['standard base64 characters', encoded(valid).replace(/.$/, '+')],
    ['non-canonical trailing bits', 'e31'],
    ['invalid UTF-8', Buffer.from([0xff, 0xfe]).toString('base64url')],
    ['invalid JSON', Buffer.from('{').toString('base64url')],
    ['another version', encoded({ ...valid, v: 2 })],
    ['an extra field', encoded({ ...valid, from: 'elsewhere' })],
    ['a negative drop count', encoded({ ...valid, dropped: -1 })],
    ['a fractional drop count', encoded({ ...valid, dropped: 1.5 })],
    ['too many alerts', encoded({ ...valid, alerts: Array.from({ length: VAULT_ALERTS_MAX_PER_HEADER + 1 }, () => alert()) })],
    ['an alert with an extra field', encoded({ ...valid, alerts: [{ ...alert(), secret: decoy }] })],
    ['an alert with a bad id', encoded({ ...valid, alerts: [alert({ spaceId: decoy })] })],
  ])('refuses %s with one fixed error that echoes nothing', (_name, header) => {
    let error: unknown;
    try { decodeVaultAlerts(header as string); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(VaultAlertHeaderError);
    expect((error as Error).message).toBe('vault alerts: malformed header');
    expect(JSON.stringify({ ...(error as object), message: (error as Error).message, stack: (error as Error).stack })).not.toContain(decoy);
  });

  it('refuses to encode a batch that would not decode', () => {
    expect(() => encodeVaultAlerts({ dropped: 0, alerts: [alert({ memberId: 'not-a-uuid' })] })).toThrow(VaultAlertHeaderError);
    expect(() => encodeVaultAlerts({ dropped: -1, alerts: [] })).toThrow(VaultAlertHeaderError);
  });
});

describe('@tm8/vault/relay', () => {
  it('is the relay entry: request signing, the alerts codec, the route table, cookie names, the retired-key denylist and the account-file parsers, nothing that opens a store, key, file or socket', async () => {
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { exports: Record<string, unknown> };
    expect(pkg.exports['./relay']).toEqual({ types: './dist/relay/index.d.ts', default: './dist/relay/index.js' });
    expect(Object.keys(await import('../../src/relay/index.js')).sort()).toEqual([
      'ATTESTATION_DEFAULT_TTL_SECONDS', 'ATTESTATION_MAX_HEADER_CHARS', 'ATTESTATION_MAX_ORIGIN_CHARS', 'ATTESTATION_MAX_SKEW_SECONDS', 'ATTESTATION_MAX_TTL_SECONDS',
      'AttestationError', 'AttestationTooLargeError', 'AttestationVerifier',
      // The host-boundary checks at both ends read the local account files through these and probe these sockets (review F03: R3, R4, B3).
      'CONTAINER_SOCKETS', 'MAX_HOST_ID',
      // The retired-key denylist both ends check (independent review F03, R7 and B2): a parser, and a hash of a key already loaded.
      'MAX_RETIRED_KEYS', 'RETIRED_KEY_KNOB',
      'VAULT_ALERTS_HEADER', 'VAULT_ALERTS_HEADER_MAX_CHARS',
      'VAULT_ALERTS_MAX_PER_HEADER', 'VAULT_ALERT_KINDS', 'VAULT_ATTESTATION_HEADER', 'VAULT_BODY_LIMITS', 'VAULT_COOKIE_NAMES', 'VaultAlertHeaderError',
      'VaultAlertSchema', 'decodeVaultAlerts', 'encodeVaultAlerts', 'exportAttestationKeyPair', 'generateAttestationKeyPair',
      // The relay and the broker share one canonical-origin rule for the signed origin claim (independent review F04).
      'isCanonicalBrowserOrigin', 'loadAttestationPrivateKey', 'loadAttestationPublicKey', 'matchVaultRoute',
      'parseGroupFile', 'parsePasswdFile', 'parseRetiredKeys', 'publicKeySha256', 'signAttestation', 'vaultBodyLimit',
    ]);
    // The route table both ends match against is pure data over the contract: no fs, net or store import.
    const routes = await readFile(new URL('../../src/relay/routes.ts', import.meta.url), 'utf8');
    expect([...routes.matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['@tm8/contract']);
    // The denylist reads no file and opens nothing: it parses a knob's text and hashes a key the caller loaded.
    const retired = await readFile(new URL('../../src/relay/retired-keys.ts', import.meta.url), 'utf8');
    expect([...retired.matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['node:crypto']);
    // The account-file parsers import nothing at all: the caller reads the text, and the socket list is data.
    const identity = await readFile(new URL('../../src/relay/host-identity.ts', import.meta.url), 'utf8');
    expect([...identity.matchAll(/\bfrom\s+['"]|\bimport\s*\(|\brequire\s*\(/g)]).toEqual([]);
  });
});

describe('broker server alert delivery', () => {
  const opened: Harness[] = [];
  afterEach(async () => { for (const h of opened.splice(0)) await h.close(); });

  it('attaches pending alerts to attested responses only, errors included', async () => {
    const alerts = queue();
    const h = await harness({ server: { alertOutbox: alerts } });
    opened.push(h);
    expect((await h.send('vault.status')).headers[VAULT_ALERTS_HEADER]).toBeUndefined();

    alerts.raise(alert());
    for (const attestation of [null, 'invalid-test-only']) {
      const refused = await h.send('vault.status', { attestation });
      expect(refused.status).toBe(401);
      expect(refused.headers[VAULT_ALERTS_HEADER]).toBeUndefined();
    }
    expect(alerts.pending).toBe(1);
    const carried = await h.send('vault.status');
    expect(carried.status).toBe(200);
    expect(decodeVaultAlerts(carried.headers[VAULT_ALERTS_HEADER])).toEqual({ dropped: 0, alerts: [alert()] });
    expect(JSON.stringify(carried.json)).not.toContain('egress_refused');

    alerts.raise(alert({ kind: 'canary_detected' }));
    const missing = await h.send('vault.items.get', { params: { itemId: randomUUID() } });
    expect(missing.status).toBe(404);
    expect(decodeVaultAlerts(missing.headers[VAULT_ALERTS_HEADER])!.alerts.map((value) => value.kind)).toEqual(['canary_detected']);
  });

  it('a failing outbox never changes the response', async () => {
    const h = await harness({ server: { alertOutbox: { take() { throw new Error(decoy); } } } });
    opened.push(h);
    const response = await h.send('vault.status');
    expect(response.status).toBe(200);
    expect(response.headers[VAULT_ALERTS_HEADER]).toBeUndefined();
    expect(response.text).not.toContain(decoy);
  });
});
