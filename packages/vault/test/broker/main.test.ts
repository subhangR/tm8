import { execFileSync } from 'node:child_process';
import { X509Certificate, createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createConnection, createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VAULT_OPERATIONS } from '@tm8/contract';
import { BROKER_ENV_KNOBS, BrokerConfigError } from '../../src/broker/config.js';
import { AUDIT_GENESIS_HASH, checkpointSigningInput } from '../../src/audit/chain.js';
import { VaultAuditGate } from '../../src/audit/gate.js';
import { HostMemoryError } from '../../src/broker/host-memory.js';
import { BROKER_RUNTIME_ENV_KNOBS, auditMaintenance, composeBroker, createVaultHandlers, failureMessage, type ComposedBroker } from '../../src/broker/main.js';
import { SYSTEM_ACTOR, VaultError, actorOf, systemClock, type AuditVerification, type VaultAlert, type VaultTx } from '../../src/core-types.js';
import { MemoryVaultStore } from '../../src/store/memory.js';
import { crc32c } from '../../src/gcp/crc32c.js';
import { VAULT_ALERTS_HEADER, decodeVaultAlerts } from '../../src/relay/alerts.js';
import { exportAttestationKeyPair, generateAttestationKeyPair, signAttestation } from '../../src/relay/attestation.js';
import { publicKeySha256 } from '../../src/relay/retired-keys.js';
import { OWNER_ID, SPACE_A, fakeSecret, newLogin, otherCaller, scopeOf, testCaller } from '../support/kit.js';
import { json, keyName, keyVersionName, loopbackSuite, tokens } from '../gcp/fake.js';
import { PG_ENABLED, PG_REASON, pgHarness, type PgHarness } from '../store/pg-harness.js';
import { exposedHost, hardenedHost } from '../support/host-memory.js';

const dirs: string[] = [];
const brokers: ComposedBroker[] = [];
afterEach(async () => {
  for (const broker of brokers.splice(0)) await broker.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temporary(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vault-main-'));
  dirs.push(dir);
  return dir;
}

/** Every path absolute and unopened: refusals below must happen before anything reads them. */
function preReviewEnv(dir: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    TM8_VAULT_MODE: 'pre_review',
    TM8_VAULT_DATABASE_URL: 'postgres://vault_test_broker@127.0.0.1:1/vault_test',
    TM8_VAULT_BROKER_SOCKET: join(dir, 'broker.sock'),
    TM8_VAULT_RELAY_PUBLIC_KEY_FILE: join(dir, 'relay.pub'),
    TM8_VAULT_DELETION_LEDGER: join(dir, 'deletions.log'),
    TM8_VAULT_FILL_SOCKET: join(dir, 'fill.sock'),
    TM8_VAULT_LOCAL_KEK_FILE: join(dir, 'kek'),
    ...extra,
  };
}

/** A listener with every TLS file named, so only the relay certificate pin (review F03) is left to check. */
const LISTENER = {
  TM8_VAULT_BROKER_MTLS_LISTEN: '127.0.0.1:8443', TM8_VAULT_BROKER_TLS_KEY_FILE: '/k', TM8_VAULT_BROKER_TLS_CERT_FILE: '/c',
  TM8_VAULT_BROKER_TLS_CA_FILE: '/ca',
} as const;
const PIN = 'TM8_VAULT_RELAY_CLIENT_CERT_SHA256';

async function refusal(promise: Promise<unknown>): Promise<BrokerConfigError> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(BrokerConfigError);
    return error as BrokerConfigError;
  }
  throw new Error('test expected a refusal');
}

interface Reply { status: number; headers: IncomingHttpHeaders; json: any }
function statusOverSocket(socketPath: string, attested: boolean): Promise<Reply> {
  const header = signAttestation({ privateKey: relayPair.privateKey, caller: testCaller, clock: systemClock,
    request: { method: 'GET', path: '/v2/vault/status', query: '', body: Buffer.alloc(0) } });
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path: '/v2/vault/status', method: 'GET', agent: false,
      headers: attested ? { 'x-tm8-vault-caller': header } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.once('error', reject);
    req.end();
  });
}

const relayPair = generateAttestationKeyPair();
async function writeRelayKey(dir: string): Promise<void> {
  await writeFile(join(dir, 'relay.pub'), exportAttestationKeyPair(relayPair).publicPem, { mode: 0o600 });
}

describe('broker composition root: static refusals', () => {
  it('serves exactly the contract catalog', () => {
    expect(Object.keys(createVaultHandlers()).sort()).toEqual(VAULT_OPERATIONS.map((row) => row.name).sort());
  });

  it('documents every environment knob it reads', async () => {
    const source = await readFile(new URL('../../src/broker/main.ts', import.meta.url), 'utf8');
    const documented = new Set<string>([...BROKER_RUNTIME_ENV_KNOBS, ...BROKER_ENV_KNOBS].map((knob) => knob.name));
    expect([...new Set(source.match(/TM8_VAULT_[A-Z0-9_]+/g))].filter((name) => !documented.has(name))).toEqual([]);
    expect(new Set(BROKER_RUNTIME_ENV_KNOBS.map((knob) => knob.name)).size).toBe(BROKER_RUNTIME_ENV_KNOBS.length);
  });

  it('mode off returns null before it validates, opens or creates anything', async () => {
    const dir = await temporary();
    for (const env of [{}, { TM8_VAULT_MODE: 'off', TM8_VAULT_LOCAL_KEK_FILE: join(dir, 'kek'), TM8_VAULT_DATABASE_URL: 'not a url',
      TM8_VAULT_FILL_TIMEOUT_MS: 'not a number', TM8_VAULT_BROKER_SOCKET: 'relative.sock' }]) {
      expect(await composeBroker(env)).toBeNull();
    }
    expect(await readdir(dir)).toEqual([]);
  });

  const marker = ['test', 'only', 'pg', 'password'].join('-');
  // Built at runtime so no credential-shaped URL literal sits in the tree.
  const inlinePassword = Object.assign(new URL('postgres://vault_test_broker@127.0.0.1/vault_test'), { password: marker }).toString();
  it.each([
    [{ TM8_VAULT_MODE: 'prod' }, 'TM8_VAULT_MODE'],
    [{ TM8_VAULT_MODE: '' }, 'TM8_VAULT_MODE'],
    [{ TM8_VAULT_DATABASE_URL: undefined }, 'TM8_VAULT_DATABASE_URL'],
    [{ TM8_VAULT_DATABASE_URL: inlinePassword }, 'TM8_VAULT_DATABASE_URL'],
    [{ TM8_VAULT_DATABASE_URL: `postgres://vault_test_broker@127.0.0.1/vault_test?password=${marker}` }, 'TM8_VAULT_DATABASE_URL'],
    [{ TM8_VAULT_DATABASE_URL: `mysql://vault_test_broker@127.0.0.1/${marker}` }, 'TM8_VAULT_DATABASE_URL'],
    [{ TM8_VAULT_DATABASE_URL: marker }, 'TM8_VAULT_DATABASE_URL'],
    [{ TM8_VAULT_BROKER_SOCKET: 'broker.sock' }, 'TM8_VAULT_BROKER_SOCKET'],
    [{ TM8_VAULT_BROKER_SOCKET: `/${'a'.repeat(100)}` }, 'TM8_VAULT_BROKER_SOCKET'],
    [{ TM8_VAULT_BROKER_SOCKET: '/run/tm8-vault/broker\n.sock' }, 'TM8_VAULT_BROKER_SOCKET'],
    [{ TM8_VAULT_RELAY_PUBLIC_KEY_FILE: undefined }, 'TM8_VAULT_RELAY_PUBLIC_KEY_FILE'],
    [{ TM8_VAULT_DELETION_LEDGER: undefined }, 'TM8_VAULT_DELETION_LEDGER'],
    [{ TM8_VAULT_DELETION_LEDGER: '/nonexistent-vault-test/deletions.log' }, 'TM8_VAULT_DELETION_LEDGER'],
    [{ TM8_VAULT_FILL_SOCKET: 'fill.sock' }, 'TM8_VAULT_FILL_SOCKET'],
    [{ TM8_VAULT_FILL_TIMEOUT_MS: '99' }, 'TM8_VAULT_FILL_TIMEOUT_MS'],
    [{ TM8_VAULT_FILL_TIMEOUT_MS: '120001' }, 'TM8_VAULT_FILL_TIMEOUT_MS'],
    [{ TM8_VAULT_FILL_TIMEOUT_MS: '1e4' }, 'TM8_VAULT_FILL_TIMEOUT_MS'],
    [{ TM8_VAULT_CHECKPOINT_INTERVAL_MS: '9999' }, 'TM8_VAULT_CHECKPOINT_INTERVAL_MS'],
    [{ TM8_VAULT_AUDIT_VERIFY_INTERVAL_MS: '59999' }, 'TM8_VAULT_AUDIT_VERIFY_INTERVAL_MS'],
    [{ TM8_VAULT_AUDIT_VERIFY_INTERVAL_MS: '86400001' }, 'TM8_VAULT_AUDIT_VERIFY_INTERVAL_MS'],
    [{ TM8_VAULT_AUDIT_VERIFY_INTERVAL_MS: 'hourly' }, 'TM8_VAULT_AUDIT_VERIFY_INTERVAL_MS'],
    [{ TM8_VAULT_AUDIT_ANCHOR_BUDGET_MS: '19999' }, 'TM8_VAULT_AUDIT_ANCHOR_BUDGET_MS'],
    [{ TM8_VAULT_AUDIT_ANCHOR_BUDGET_MS: '172800001' }, 'TM8_VAULT_AUDIT_ANCHOR_BUDGET_MS'],
    // Review F01: one missed checkpoint must not fail closed, so the budget covers at least two periods.
    [{ TM8_VAULT_CHECKPOINT_INTERVAL_MS: '600000' }, 'TM8_VAULT_AUDIT_ANCHOR_BUDGET_MS'],
    [{ TM8_VAULT_CHECKPOINT_INTERVAL_MS: '20000', TM8_VAULT_AUDIT_ANCHOR_BUDGET_MS: '39999' }, 'TM8_VAULT_AUDIT_ANCHOR_BUDGET_MS'],
    [{ TM8_VAULT_BROKER_MTLS_LISTEN: '127.0.0.1' }, 'TM8_VAULT_BROKER_MTLS_LISTEN'],
    [{ TM8_VAULT_BROKER_MTLS_LISTEN: '127.0.0.1:0' }, 'TM8_VAULT_BROKER_MTLS_LISTEN'],
    [{ TM8_VAULT_BROKER_MTLS_LISTEN: '127.0.0.1:65536' }, 'TM8_VAULT_BROKER_MTLS_LISTEN'],
    [{ TM8_VAULT_BROKER_MTLS_LISTEN: '127.0.0.1:8443', TM8_VAULT_BROKER_TLS_KEY_FILE: '/k', TM8_VAULT_BROKER_TLS_CERT_FILE: '/c' }, 'TM8_VAULT_BROKER_TLS_CA_FILE'],
    [{ TM8_VAULT_BROKER_TLS_KEY_FILE: '/k' }, 'TM8_VAULT_BROKER_TLS_KEY_FILE'],
    // Review F03: every mTLS listener pins the relay's certificate, so a listener without an exact pin is refused.
    [{ ...LISTENER }, PIN],
    [{ ...LISTENER, [PIN]: 'ab'.repeat(31) }, PIN],
    [{ ...LISTENER, [PIN]: 'ab'.repeat(33) }, PIN],
    [{ ...LISTENER, [PIN]: 'zz'.repeat(32) }, PIN],
    [{ ...LISTENER, [PIN]: ` ${'ab'.repeat(32)}` }, PIN],
    [{ ...LISTENER, [PIN]: `${'AB:'.repeat(32)}` }, PIN],
    // 32 bytes, but not in pairs.
    [{ ...LISTENER, [PIN]: `AB${':AB'.repeat(29)}:ABAB` }, PIN],
    [{ ...LISTENER, [PIN]: `SHA256 Fingerprint=AB${':AB'.repeat(31)}` }, PIN],
    // A pin with no listener is a mistake too: it would pin nothing.
    [{ [PIN]: 'ab'.repeat(32) }, PIN],
    [{ TM8_VAULT_KMS_KIND: 'vault-transit' }, 'TM8_VAULT_KMS_KIND'],
    [{ TM8_VAULT_KMS_KIND: 'test-fake' }, 'TM8_VAULT_KMS_KIND'],
    [{ TM8_VAULT_CANARY_FILE: '/nonexistent/vault-test-canaries' }, 'TM8_VAULT_CANARY_FILE'],
    // Review F03, B2: a malformed denylist refuses in every mode, so a typo never drops an entry unseen.
    [{ TM8_VAULT_RETIRED_KEY_SHA256: 'zz'.repeat(32) }, 'TM8_VAULT_RETIRED_KEY_SHA256'],
    [{ TM8_VAULT_RETIRED_KEY_SHA256: `${'ab'.repeat(32)},` }, 'TM8_VAULT_RETIRED_KEY_SHA256'],
    [{ TM8_VAULT_RETIRED_KEY_SHA256: `${'ab'.repeat(32)} ${'cd'.repeat(32)}` }, 'TM8_VAULT_RETIRED_KEY_SHA256'],
  ] as const)('refuses %j as %s with a fixed message and creates nothing', async (patch, knob) => {
    const dir = await temporary();
    const error = await refusal(composeBroker(preReviewEnv(dir, patch)));
    expect(error.knob).toBe(knob);
    expect(error.message).toBe(`vault broker: invalid ${knob}`);
    expect(failureMessage(error)).toBe(`vault broker: invalid ${knob}`);
    expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain(marker);
    expect(await readdir(dir)).toEqual([]);
  });

  it.each([
    ['64 hex digits', 'ab'.repeat(32)],
    ['the colon pairs openssl prints', `AB${':AB'.repeat(31)}`],
    ['mixed case', `aB${':Ab'.repeat(31)}`],
  ] as const)('review F03: takes the relay certificate pin as %s', async (_form, pin) => {
    const dir = await temporary();
    const error = await composeBroker(preReviewEnv(dir, { ...LISTENER, [PIN]: pin }), { log: () => undefined })
      .then(() => null, (reason: unknown) => reason);
    // Past every configuration check (a BrokerConfigError would name a knob): the unreachable test database refuses.
    expect(error).not.toBeInstanceOf(BrokerConfigError);
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).message).toBe('vault: vault_unavailable');
  });

  it.each([
    [{}, 'TM8_VAULT_REVIEW_GATE'],
    [{ TM8_VAULT_REVIEW_GATE: 'open' }, 'TM8_VAULT_REVIEW_GATE'],
    [{ TM8_VAULT_REVIEW_GATE: 'passed' }, 'TM8_VAULT_KMS_KIND'],
    [{ TM8_VAULT_REVIEW_GATE: 'passed', TM8_VAULT_KMS_KIND: 'local-dev' }, 'TM8_VAULT_KMS_KIND'],
    [{ TM8_VAULT_REVIEW_GATE: 'passed', TM8_VAULT_KMS_KIND: 'gcp-kms' }, 'TM8_VAULT_AUDIT_SINK'],
    [{ TM8_VAULT_REVIEW_GATE: 'passed', TM8_VAULT_KMS_KIND: 'gcp-kms', TM8_VAULT_AUDIT_SINK: 'file' }, 'TM8_VAULT_GCP_CHECKPOINT_KEY_VERSION'],
    [{ TM8_VAULT_REVIEW_GATE: 'passed', TM8_VAULT_KMS_KIND: 'gcp-kms', TM8_VAULT_AUDIT_SINK: 'gcs',
      TM8_VAULT_GCP_CHECKPOINT_KEY_VERSION: keyVersionName }, 'TM8_VAULT_LOCAL_KEK_FILE'],
    [{ TM8_VAULT_REVIEW_GATE: 'passed', TM8_VAULT_KMS_KIND: 'gcp-kms', TM8_VAULT_AUDIT_SINK: 'gcs',
      TM8_VAULT_GCP_CHECKPOINT_KEY_VERSION: keyVersionName, TM8_VAULT_LOCAL_KEK_FILE: undefined, TM8_VAULT_CHECKPOINT_KEY_FILE: '/k' }, 'TM8_VAULT_CHECKPOINT_KEY_FILE'],
    [{ TM8_VAULT_REVIEW_GATE: 'passed', TM8_VAULT_KMS_KIND: 'gcp-kms', TM8_VAULT_AUDIT_SINK: 'gcs',
      TM8_VAULT_GCP_CHECKPOINT_KEY_VERSION: keyVersionName, TM8_VAULT_LOCAL_KEK_FILE: undefined }, 'TM8_VAULT_BROKER_MTLS_LISTEN'],
    [{ TM8_VAULT_REVIEW_GATE: 'passed', TM8_VAULT_KMS_KIND: 'gcp-kms', TM8_VAULT_AUDIT_SINK: 'gcs',
      TM8_VAULT_GCP_CHECKPOINT_KEY_VERSION: keyVersionName, TM8_VAULT_LOCAL_KEK_FILE: undefined, ...LISTENER }, PIN],
  ] as const)('production %j is refused as %s before any KMS, database or network call', async (patch, knob) => {
    const dir = await temporary();
    const error = await refusal(composeBroker(preReviewEnv(dir, { TM8_VAULT_MODE: 'production', ...patch }), { hostProc: hardenedHost() }));
    expect(error.knob).toBe(knob);
    expect(await readdir(dir)).toEqual([]);
  });

  it('review F05: production refuses a host that would write broker memory to disk, before it reads a key or calls KMS, a database or the network', async () => {
    const dir = await temporary();
    const host = exposedHost();
    const records: Record<string, unknown>[] = [];
    // Every prerequisite is met; on a hardened host this env is refused for its missing mTLS listener (above).
    const error = await composeBroker(preReviewEnv(dir, { TM8_VAULT_MODE: 'production', TM8_VAULT_REVIEW_GATE: 'passed',
      TM8_VAULT_KMS_KIND: 'gcp-kms', TM8_VAULT_AUDIT_SINK: 'gcs', TM8_VAULT_GCP_CHECKPOINT_KEY_VERSION: keyVersionName,
      TM8_VAULT_LOCAL_KEK_FILE: undefined }), { hostProc: host.proc, log: (record) => records.push(record) })
      .then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(HostMemoryError);
    expect(failureMessage(error)).toBe('vault broker: refused (host memory: core_limit, core_pattern, swap_limit)');
    expect(records).toEqual([{ event: 'vault_broker_host_memory', ok: false, failures: ['core_limit', 'core_pattern', 'swap_limit'],
      coreFilter: 0, coreLimit: { soft: '0', hard: 'unlimited' }, corePattern: 'pipe', swapAreas: 1, swapMax: 'max' }]);
    expect(host.writes).toEqual([['/proc/self/coredump_filter', '0']]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses a canary file that is not private, not text or has a short value, and never echoes it', async () => {
    const dir = await temporary();
    const decoy = ['vault', 'test', 'decoy', 'value', 'one'].join('-');
    const cases: [string, string | Buffer, number][] = [
      ['open', `${decoy}\n`, 0o644], ['short', `${decoy}\nshort\n`, 0o600], ['binary', Buffer.from([0xff, 0xfe, 0x00]), 0o600],
    ];
    for (const [name, content, mode] of cases) {
      await writeFile(join(dir, name), content, { mode });
      const error = await refusal(composeBroker(preReviewEnv(dir, { TM8_VAULT_CANARY_FILE: join(dir, name) })));
      expect(error.knob).toBe('TM8_VAULT_CANARY_FILE');
      expect(String(error)).not.toContain(decoy);
    }
    await expect(lstat(join(dir, 'kek'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('maps any other startup failure to a fixed line', () => {
    expect(failureMessage(VaultError.reason('kms_unavailable'))).toBe('vault broker: refused (kms_unavailable)');
    expect(failureMessage(new Error(`connect ECONNREFUSED ${marker}`))).toBe('vault broker: start failed');
    expect(failureMessage('not an error')).toBe('vault broker: start failed');
  });
});

describe('periodic audit verification (review F01)', () => {
  const verification = (status: AuditVerification['status']): AuditVerification => ({ status, checkedThroughSeq: 0, headHash: AUDIT_GENESIS_HASH, firstBrokenSeq: null });
  function maintained(options: { checkpoint?: () => Promise<void> } = {}) {
    const calls: string[] = [];
    const logs: Record<string, unknown>[] = [];
    const results = { incremental: 'verified' as AuditVerification['status'], full: 'verified' as AuditVerification['status'], throws: false };
    let time = 1_000;
    const audit = {
      verifyIncremental: async () => { calls.push('incremental'); if (results.throws) throw new Error('test-only'); return verification(results.incremental); },
      verifyAll: async () => { calls.push('full'); if (results.throws) throw new Error('test-only'); return verification(results.full); },
    };
    const maintenance = auditMaintenance({ audit, verifyIntervalMs: 60_000, now: () => time, log: (record) => logs.push(record),
      checkpoint: options.checkpoint ?? (async () => { calls.push('checkpoint'); }) });
    return { maintenance, calls, logs, results, advance: (ms: number) => { time += ms; } };
  }

  it('anchors first, verifies incrementally each period and from seq 1 once the full period has passed', async () => {
    const m = maintained();
    await m.maintenance.tick();
    m.advance(59_999);
    await m.maintenance.tick();
    m.advance(1);
    await m.maintenance.tick();
    await m.maintenance.tick();
    m.advance(60_000);
    await m.maintenance.tick();
    expect(m.calls).toEqual(['checkpoint', 'incremental', 'checkpoint', 'incremental', 'checkpoint', 'full', 'checkpoint', 'incremental', 'checkpoint', 'full']);
    expect(m.logs).toEqual([]);
  });

  it('logs every verification that is not verified, and a failed full walk comes round again a period later', async () => {
    const m = maintained();
    m.results.incremental = 'unverified';
    await m.maintenance.tick();
    m.advance(60_000);
    m.results.full = 'broken';
    await m.maintenance.tick();
    m.results.throws = true;
    await m.maintenance.tick();
    m.advance(60_000);
    await m.maintenance.tick();
    expect(m.calls.filter((call) => call !== 'checkpoint')).toEqual(['incremental', 'full', 'incremental', 'full']);
    expect(m.logs).toEqual([
      { event: 'vault_audit_verification_failed', status: 'unverified', full: false },
      { event: 'vault_audit_verification_failed', status: 'broken', full: true },
      { event: 'vault_audit_verification_failed', status: 'unverified', full: false },
      { event: 'vault_audit_verification_failed', status: 'unverified', full: true },
    ]);
  });

  it('shares one run between overlapping ticks, never rejects, and close can wait for it', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const m = maintained({ checkpoint: async () => { m.calls.push('checkpoint'); await held; throw new Error('test-only checkpoint failure'); } });
    const first = m.maintenance.tick();
    expect(m.maintenance.tick()).toBe(first);
    let idle = false;
    const waiting = m.maintenance.idle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    release();
    await expect(first).resolves.toBeUndefined();
    await waiting;
    expect(m.calls).toEqual(['checkpoint', 'incremental']);
    expect(m.logs).toEqual([{ event: 'vault_checkpoint_failed' }]);
    await expect(m.maintenance.idle()).resolves.toBeUndefined();
  });

  it('finds an old event edited in place, which incremental verification passes over, within one full period', async () => {
    const store = new MemoryVaultStore();
    const audit = new VaultAuditGate({ store });
    for (let n = 1; n <= 3; n++) {
      await store.transaction({ kind: 'system', purpose: 'audit' }, (tx) => tx.audit.append({ action: 'session.signed_in', actor: SYSTEM_ACTOR,
        itemId: null, subjectMemberId: OWNER_ID, spaceId: SPACE_A, params: { n } }));
    }
    expect((await audit.verifyIncremental()).status).toBe('verified');
    await store.testing.tamperAuditEvent(1, { params: { n: 9 } });
    let time = 0;
    const logs: Record<string, unknown>[] = [];
    const maintenance = auditMaintenance({ audit, checkpoint: async () => undefined, verifyIntervalMs: 60_000, now: () => time, log: (record) => logs.push(record) });
    await maintenance.tick();
    expect(logs).toEqual([]);
    expect(audit.status()).toBe('ok');
    time = 60_000;
    await maintenance.tick();
    expect(logs).toEqual([{ event: 'vault_audit_verification_failed', status: 'broken', full: true }]);
    expect(audit.status()).toBe('unavailable');
    expect(await audit.verifyIncremental()).toMatchObject({ status: 'broken', firstBrokenSeq: 1 });
  });
});

if (!PG_ENABLED) describe('broker composition root over Postgres', () => { it('requires a scratch Postgres', (ctx) => ctx.skip(PG_REASON)); });
else describe('broker composition root over Postgres', () => {
  const harnesses: PgHarness[] = [];
  const roles: string[] = [];
  afterEach(async () => {
    for (const broker of brokers.splice(0)) await broker.close();
    for (const h of harnesses.splice(0)) {
      for (const role of roles.splice(0)) await h.admin.query(`drop role if exists ${role}`);
      await h.dispose();
    }
  });
  async function database(): Promise<PgHarness> { const h = await pgHarness(); harnesses.push(h); return h; }
  async function loginRole(h: PgHarness, ...memberships: string[]): Promise<string> {
    const role = `vault_test_login_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    roles.push(role);
    await h.admin.query(`create role ${role} login`);
    for (const group of memberships) await h.admin.query(`grant ${group} to ${role}`);
    const url = new URL(h.url);
    url.username = role;
    return url.toString();
  }

  it('starts pre_review on an owner-only socket, answers attested calls and carries alerts only on them', async () => {
    const h = await database();
    const dir = await temporary();
    await writeRelayKey(dir);
    await writeFile(join(dir, 'checkpoint.key'), generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await mkdir(join(dir, 'checkpoints'), { mode: 0o700 });
    const records: Record<string, unknown>[] = [];
    const host = exposedHost();
    const broker = (await composeBroker(preReviewEnv(dir, {
      TM8_VAULT_DATABASE_URL: h.url, TM8_VAULT_AUDIT_SINK: 'file', TM8_VAULT_CHECKPOINT_DIR: join(dir, 'checkpoints'),
      TM8_VAULT_CHECKPOINT_KEY_FILE: join(dir, 'checkpoint.key'),
    }), { log: (record) => records.push(record), hostProc: host.proc }))!;
    brokers.push(broker);

    // Review F05: pre_review runs on a host that would write its memory out, after setting the filter, and says so.
    expect(host.writes).toEqual([['/proc/self/coredump_filter', '0']]);
    expect(records).toContainEqual(expect.objectContaining({ event: 'vault_broker_host_memory', ok: false,
      failures: ['core_limit', 'core_pattern', 'swap_limit'], coreFilter: 0 }));

    expect(broker.databaseRole.dedicated).toBe(false);
    expect(records).toContainEqual({ event: 'vault_broker_database_role_not_dedicated', mode: 'pre_review' });
    expect((await lstat(join(dir, 'kek'))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(dir, 'broker.sock'))).mode & 0o777).toBe(0o600);
    expect(broker.server.https).toBeNull();

    const status = await statusOverSocket(join(dir, 'broker.sock'), true);
    expect(status.status).toBe(200);
    expect(status.json.data).toMatchObject({ mode: 'pre_review', reviewGate: 'open', testSecretsOnly: true,
      kms: { kind: 'local-dev', productionGrade: false }, features: { spend: false, import: false } });
    expect(status.headers[VAULT_ALERTS_HEADER]).toBeUndefined();

    const alert: VaultAlert = { kind: 'canary_detected', memberId: OWNER_ID, spaceId: SPACE_A, itemId: null, params: { channel: 'test' }, at: '2026-11-21T00:00:00.000Z' };
    broker.alerts.raise(alert);
    const refused = await statusOverSocket(join(dir, 'broker.sock'), false);
    expect(refused.status).toBe(401);
    expect(refused.headers[VAULT_ALERTS_HEADER]).toBeUndefined();
    expect(broker.alerts.pending).toBe(1);
    const carried = await statusOverSocket(join(dir, 'broker.sock'), true);
    expect(decodeVaultAlerts(carried.headers[VAULT_ALERTS_HEADER])).toEqual({ dropped: 0, alerts: [alert] });
    expect(broker.alerts.pending).toBe(0);

    const requests = records.filter((record) => record.event === 'vault_broker_request');
    expect(requests.length).toBe(3);
    for (const record of requests) expect(Object.keys(record).sort()).toEqual(['event', 'ms', 'op', 'requestId', 'status']);

    // An empty chain was not anchored at start; one new event is anchored once.
    expect(await readdir(join(dir, 'checkpoints'))).toEqual([]);
    await h.store.transaction(scopeOf(testCaller), (tx) => tx.audit.append({ action: 'session.signed_in', actor: actorOf(testCaller),
      itemId: null, subjectMemberId: OWNER_ID, spaceId: SPACE_A, params: {} }));
    expect(await broker.checkpointer!.checkpointIfAdvanced()).toMatchObject({ seq: 1, sink: 'file', anchored: true });
    expect(await broker.checkpointer!.checkpointIfAdvanced()).toBeNull();
    expect(await readdir(join(dir, 'checkpoints'))).toHaveLength(1);

    await broker.close();
    await expect(lstat(join(dir, 'broker.sock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a login that belongs to the broker role only as dedicated', async () => {
    const h = await database();
    const dir = await temporary();
    await writeRelayKey(dir);
    const broker = (await composeBroker(preReviewEnv(dir, { TM8_VAULT_DATABASE_URL: await loginRole(h, 'tm8_vault_broker') }), { log: () => undefined }))!;
    brokers.push(broker);
    expect(broker.databaseRole.dedicated).toBe(true);
    expect((await statusOverSocket(join(dir, 'broker.sock'), true)).status).toBe(200);
  });

  it('refuses to start when the file checkpoint sink is unhealthy, before the socket binds', async () => {
    const h = await database();
    const dir = await temporary();
    await writeRelayKey(dir);
    await writeFile(join(dir, 'checkpoint.key'), generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const error = await composeBroker(preReviewEnv(dir, { TM8_VAULT_DATABASE_URL: h.url, TM8_VAULT_AUDIT_SINK: 'file',
      TM8_VAULT_CHECKPOINT_DIR: join(dir, 'missing'), TM8_VAULT_CHECKPOINT_KEY_FILE: join(dir, 'checkpoint.key') }), { log: () => undefined })
      .then(() => null, (reason: unknown) => reason);
    expect(failureMessage(error)).toBe('vault broker: refused (audit_unavailable)');
    await expect(lstat(join(dir, 'broker.sock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('review F03, B2: refuses a relay public key on TM8_VAULT_RETIRED_KEY_SHA256 before the socket binds', async () => {
    const h = await database();
    const dir = await temporary();
    await writeRelayKey(dir);
    const fingerprint = publicKeySha256(relayPair.publicKey);
    const records: Record<string, unknown>[] = [];
    const error = await composeBroker(preReviewEnv(dir, { TM8_VAULT_DATABASE_URL: h.url, TM8_VAULT_RETIRED_KEY_SHA256: `${'ab'.repeat(32)},${fingerprint}` }),
      { log: (record) => records.push(record), hostProc: hardenedHost() }).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(BrokerConfigError);
    expect(failureMessage(error)).toBe('vault broker: TM8_VAULT_RELAY_PUBLIC_KEY_FILE is a retired relay key (TM8_VAULT_RETIRED_KEY_SHA256, review F03 B2)');
    expect(JSON.stringify([records, Object.getOwnPropertyDescriptors(error)])).not.toContain(fingerprint);
    await expect(lstat(join(dir, 'broker.sock'))).rejects.toMatchObject({ code: 'ENOENT' });
    // The same start with the key off the list serves.
    const broker = (await composeBroker(preReviewEnv(dir, { TM8_VAULT_DATABASE_URL: h.url, TM8_VAULT_RETIRED_KEY_SHA256: 'ab'.repeat(32) }),
      { log: () => undefined, hostProc: hardenedHost() }))!;
    brokers.push(broker);
    expect((await statusOverSocket(join(dir, 'broker.sock'), true)).status).toBe(200);
  });

  it('review F01: a database restored to before the newest retained checkpoint is refused at start, though its own receipts agree', async () => {
    const h = await database();
    const dir = await temporary();
    await writeRelayKey(dir);
    await writeFile(join(dir, 'checkpoint.key'), generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await mkdir(join(dir, 'checkpoints'), { mode: 0o700 });
    const records: Record<string, unknown>[] = [];
    const env = preReviewEnv(dir, { TM8_VAULT_DATABASE_URL: h.url, TM8_VAULT_AUDIT_SINK: 'file', TM8_VAULT_CHECKPOINT_DIR: join(dir, 'checkpoints'),
      TM8_VAULT_CHECKPOINT_KEY_FILE: join(dir, 'checkpoint.key') });
    const start = () => composeBroker(env, { log: (record) => records.push(record) });
    const event = (n: number) => h.store.transaction(scopeOf(testCaller), (tx) => tx.audit.append({ action: 'session.signed_in', actor: actorOf(testCaller),
      itemId: null, subjectMemberId: OWNER_ID, spaceId: SPACE_A, params: { n } }));

    const first = (await start())!;
    await event(1);
    expect(await first.checkpointer!.checkpointIfAdvanced()).toMatchObject({ seq: 1, anchored: true });
    const before = await h.dump();
    await event(2);
    await event(3);
    expect(await first.checkpointer!.checkpointIfAdvanced()).toMatchObject({ seq: 3, anchored: true });
    const after = await h.dump();
    await first.close();
    expect((await readdir(join(dir, 'checkpoints'))).map((name) => name.split('-')[0]).sort()).toEqual(['1', '3']);

    // Control: the same database and sink start cleanly.
    const control = (await start())!;
    expect((await statusOverSocket(join(dir, 'broker.sock'), true)).status).toBe(200);
    await control.close();

    // Restored to before seq 3: the restored receipts agree with the restored chain; only the retained anchor disagrees.
    await h.restoreDump(before);
    expect((await h.admin.query('select max(seq)::int as seq from vault.audit_events')).rows[0].seq).toBe(1);
    records.length = 0;
    const error = await start().then(() => null, (reason: unknown) => reason);
    expect(failureMessage(error)).toBe('vault broker: refused (audit_unavailable)');
    expect(records).toContainEqual({ event: 'vault_audit_anchor_failed', reason: 'anchor_rollback' });
    await expect(lstat(join(dir, 'broker.sock'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(join(dir, 'checkpoints'))).map((name) => name.split('-')[0]).sort()).toEqual(['1', '3']);

    // The supported recovery: a restore that contains the anchored head.
    await h.restoreDump(after);
    const recovered = (await start())!;
    brokers.push(recovered);
    expect((await statusOverSocket(join(dir, 'broker.sock'), true)).status).toBe(200);
    await recovered.close();

    // An event a stopped broker never anchored is anchored at start, before the socket binds.
    await event(4);
    const anchored = (await start())!;
    brokers.push(anchored);
    expect((await readdir(join(dir, 'checkpoints'))).map((name) => name.split('-')[0]).sort()).toEqual(['1', '3', '4']);
  }, 60_000);

  it('replays the ledger file before the socket binds: a grant a restore revived is revoked again, and a damaged line stops the start', async () => {
    const h = await database();
    const dir = await temporary();
    await writeRelayKey(dir);
    const as = <T>(caller: typeof testCaller, fn: (tx: VaultTx) => Promise<T>): Promise<T> => h.store.transaction(scopeOf(caller), fn);
    const item = await as(testCaller, (tx) => tx.items.create(newLogin(), fakeSecret()));
    const grant = await as(testCaller, (tx) => tx.grants.create({ id: randomUUID(), itemId: item.id, granteeKind: 'member', granteeId: otherCaller.memberId,
      constraints: { origins: null, hosts: null, requireApprovalPerUse: false }, expiresAt: null, createdBy: actorOf(testCaller) }));
    // As a restore leaves it: the ledger holds the revocation, the database holds the grant active.
    const line = { kind: 'grant_revoked', grantId: grant.id, itemId: item.id, spaceId: item.spaceId, ownerMemberId: item.ownerMemberId,
      revokedAt: '2026-11-21T00:00:00.000Z' };
    const env = preReviewEnv(dir, { TM8_VAULT_DATABASE_URL: h.url });

    await writeFile(join(dir, 'deletions.log'), JSON.stringify({ ...line, itemId: randomUUID() }) + '\n', { mode: 0o600 });
    const error = await composeBroker(env, { log: () => undefined }).then(() => null, (reason: unknown) => reason);
    expect(failureMessage(error)).toBe('vault broker: start failed');
    await expect(lstat(join(dir, 'broker.sock'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await as(testCaller, (tx) => tx.grants.get(grant.id)))?.revokedAt).toBeNull();

    await writeFile(join(dir, 'deletions.log'), JSON.stringify(line) + '\n', { mode: 0o600 });
    const broker = (await composeBroker(env, { log: () => undefined }))!;
    brokers.push(broker);
    expect(await as(testCaller, (tx) => tx.grants.get(grant.id))).toMatchObject({ revokedAt: line.revokedAt, revokedBy: SYSTEM_ACTOR });
    expect(await as(otherCaller, (tx) => tx.items.get(item.id))).toBeNull();
    expect((await statusOverSocket(join(dir, 'broker.sock'), true)).status).toBe(200);
  });

  describe('production', () => {
    const fake = loopbackSuite();
    const bucket = 'test-only-checkpoint-bucket';
    const file = (dir: string, name: string) => join(dir, name);
    async function certificates(dir: string): Promise<void> {
      const openssl = (args: string[]) => execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'ignore'] });
      // Ephemeral test-only fixtures, generated at runtime.
      openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', file(dir, 'ca.key'), '-out', file(dir, 'ca.crt'), '-subj', '/CN=vault-test-ca', '-days', '1']);
      // `other` is a second client certificate from the same CA: it passes the CA, not the pin (review F03).
      for (const name of ['server', 'client', 'other']) {
        openssl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', file(dir, `${name}.key`), '-out', file(dir, `${name}.csr`), '-subj', `/CN=vault-test-${name}`]);
        await writeFile(file(dir, `${name}.ext`), name === 'server' ? 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' : 'extendedKeyUsage=clientAuth\n');
        openssl(['x509', '-req', '-in', file(dir, `${name}.csr`), '-CA', file(dir, 'ca.crt'), '-CAkey', file(dir, 'ca.key'), '-CAcreateserial',
          '-out', file(dir, `${name}.crt`), '-days', '1', '-extfile', file(dir, `${name}.ext`)]);
      }
      // The pin exactly as deploy/vault/README.md tells the operator to take it: what openssl prints after '='.
      const printed = execFileSync('openssl', ['x509', '-noout', '-fingerprint', '-sha256', '-in', file(dir, 'client.crt')], { encoding: 'utf8' });
      await writeFile(file(dir, 'client.pin'), printed.trim().split('=')[1]!);
    }
    const fingerprintOf = (dir: string, name: string) => createHash('sha256').update(new X509Certificate(readFileSync(file(dir, `${name}.crt`))).raw).digest('hex');
    async function freePort(): Promise<number> {
      const server = createNetServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return port;
    }
    /**
     * KMS and a checkpoint bucket that already carries a retention policy (review F01). `objects` is what the
     * bucket retains; the checkpoint key's private half is exposed only so a test can plant a signed anchor.
     */
    async function googleFake(options: { retention?: Record<string, unknown> | null; objects?: Map<string, Buffer> } = {}) {
      const signing = generateKeyPairSync('ed25519');
      const pem = signing.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const retention = options.retention === undefined ? { retentionPeriod: '86400', isLocked: false } : options.retention;
      const objects = options.objects ?? new Map<string, Buffer>();
      const listPath = `/storage/v1/b/${bucket}/o`;
      const server = await fake((req, res) => {
        const path = req.url.pathname;
        if (req.method === 'GET' && path === `/v1/${keyName}`) return json(res, { purpose: 'ENCRYPT_DECRYPT', primary: { state: 'ENABLED', protectionLevel: 'HSM' } });
        if (req.method === 'GET' && path === `/v1/${keyVersionName}/publicKey`) {
          return json(res, { pem, pemCrc32c: String(crc32c(Buffer.from(pem))), algorithm: 'EC_SIGN_ED25519', name: keyVersionName });
        }
        if (req.method === 'GET' && path === `/storage/v1/b/${bucket}`) return json(res, retention === null ? {} : { retentionPolicy: retention });
        if (req.method === 'GET' && path === listPath) {
          const start = req.url.searchParams.get('startOffset') ?? '';
          const names = [...objects.keys()].filter((name) => name.startsWith('checkpoints/') && name >= start).sort();
          return json(res, names.length ? { items: names.map((name) => ({ name })) } : {});
        }
        const bytes = req.method === 'GET' && path.startsWith(`${listPath}/`) && req.url.searchParams.get('alt') === 'media'
          ? objects.get(decodeURIComponent(path.slice(listPath.length + 1))) : undefined;
        if (bytes) { res.end(bytes); return; }
        json(res, { error: { code: 404 } }, 404);
      });
      return Object.assign(server, { signing });
    }
    function productionEnv(dir: string, databaseUrl: string, port: number): Record<string, string | undefined> {
      return {
        ...preReviewEnv(dir), TM8_VAULT_MODE: 'production', TM8_VAULT_REVIEW_GATE: 'passed', TM8_VAULT_LOCAL_KEK_FILE: undefined,
        TM8_VAULT_DATABASE_URL: databaseUrl, TM8_VAULT_PUBLIC_ORIGIN: 'https://tm8.example.test',
        TM8_VAULT_KMS_KIND: 'gcp-kms', TM8_VAULT_GCP_KMS_KEY: keyName,
        TM8_VAULT_AUDIT_SINK: 'gcs', TM8_VAULT_GCS_BUCKET: bucket, TM8_VAULT_GCP_CHECKPOINT_KEY_VERSION: keyVersionName,
        TM8_VAULT_BROKER_MTLS_LISTEN: `127.0.0.1:${port}`, TM8_VAULT_BROKER_TLS_KEY_FILE: file(dir, 'server.key'),
        TM8_VAULT_BROKER_TLS_CERT_FILE: file(dir, 'server.crt'), TM8_VAULT_BROKER_TLS_CA_FILE: file(dir, 'ca.crt'),
        [PIN]: readFileSync(file(dir, 'client.pin'), 'utf8'),
      };
    }
    const refusesConnections = (port: number) => new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(true));
    });

    it('refuses any database login but a dedicated broker role, then serves only the pinned relay certificate over mTLS', async () => {
      const h = await database();
      const dir = await temporary();
      await writeRelayKey(dir);
      await certificates(dir);
      const google = await googleFake();
      const port = await freePort();
      const env = (databaseUrl: string) => productionEnv(dir, databaseUrl, port);
      const gcp = { tokens, kmsBaseUrl: google.baseUrl, gcsBaseUrl: google.baseUrl };

      // The trust-auth superuser ignores RLS (review finding HIGH): production never runs on it.
      const superuser = await refusal(composeBroker(env(h.url), { gcp, log: () => undefined, hostProc: hardenedHost() }));
      expect(superuser.knob).toBe('TM8_VAULT_DATABASE_URL');
      const wider = await refusal(composeBroker(env(await loginRole(h, 'tm8_vault_broker', 'tm8_app')), { gcp, log: () => undefined, hostProc: hardenedHost() }));
      expect(wider.knob).toBe('TM8_VAULT_DATABASE_URL');
      const outsider = await refusal(composeBroker(env(await loginRole(h)), { gcp, log: () => undefined, hostProc: hardenedHost() }));
      expect(outsider.knob).toBe('TM8_VAULT_DATABASE_URL');
      await expect(lstat(join(dir, 'broker.sock'))).rejects.toMatchObject({ code: 'ENOENT' });

      const records: Record<string, unknown>[] = [];
      const broker = (await composeBroker(env(await loginRole(h, 'tm8_vault_broker')), { gcp, log: (record) => records.push(record), hostProc: hardenedHost() }))!;
      brokers.push(broker);
      // openssl prints colon pairs in upper case; the broker took that form.
      expect(readFileSync(file(dir, 'client.pin'), 'utf8')).toMatch(/^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/);
      expect(broker.databaseRole.dedicated).toBe(true);
      expect(broker.config).toMatchObject({ mode: 'production', reviewGate: 'passed', auditSink: 'gcs' });
      expect(broker.server.https).not.toBeNull();
      expect(google.requests.some((request) => request.method !== 'GET')).toBe(false);

      const header = signAttestation({ privateKey: relayPair.privateKey, caller: testCaller, clock: systemClock,
        request: { method: 'GET', path: '/v2/vault/status', query: '', body: Buffer.alloc(0) } });
      const [ca, cert, key] = await Promise.all(['ca.crt', 'client.crt', 'client.key'].map((name) => readFile(file(dir, name))));
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpsRequest({ host: '127.0.0.1', port, path: '/v2/vault/status', ca, cert, key, agent: false,
          headers: { 'x-tm8-vault-caller': header } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
        req.once('error', reject);
        req.end();
      });
      expect(status).toBe(200);
      await expect(new Promise((resolve, reject) => {
        const req = httpsRequest({ host: '127.0.0.1', port, path: '/v2/vault/status', ca, agent: false }, resolve);
        req.once('error', reject);
        req.end();
      })).rejects.toThrow();
      // Review F03: a certificate the same CA issued, with a valid attestation, is closed before any handler runs.
      const served = records.filter((record) => record.event === 'vault_broker_request').length;
      const [otherCert, otherKey] = await Promise.all(['other.crt', 'other.key'].map((name) => readFile(file(dir, name))));
      await expect(new Promise((resolve, reject) => {
        const req = httpsRequest({ host: '127.0.0.1', port, path: '/v2/vault/status', ca, cert: otherCert, key: otherKey, agent: false,
          headers: { 'x-tm8-vault-caller': header } }, resolve);
        req.once('error', reject);
        req.end();
      })).rejects.toThrow();
      expect(records).toContainEqual({ event: 'vault_broker_mtls_peer_refused', fingerprint: fingerprintOf(dir, 'other') });
      expect(records.filter((record) => record.event === 'vault_broker_request')).toHaveLength(served);
      expect(broker.server.refusedPeers).toBe(1);
    }, 30_000);

    it('review F01: refuses a checkpoint bucket with no retention policy, or one it cannot read, and never writes one', async () => {
      const h = await database();
      const dir = await temporary();
      await writeRelayKey(dir);
      await certificates(dir);
      const port = await freePort();
      const role = await loginRole(h, 'tm8_vault_broker');
      for (const [retention, logged] of [[null, { ok: true, retention: 'none' }], [{ isLocked: 'yes' }, { ok: false, retention: 'unknown' }]] as const) {
        const google = await googleFake({ retention });
        const records: Record<string, unknown>[] = [];
        const error = await composeBroker(productionEnv(dir, role, port), { gcp: { tokens, kmsBaseUrl: google.baseUrl, gcsBaseUrl: google.baseUrl }, hostProc: hardenedHost(),
          log: (record) => records.push(record) }).then(() => null, (reason: unknown) => reason);
        expect(failureMessage(error)).toBe('vault broker: refused (audit_unavailable)');
        expect(records).toContainEqual({ event: 'vault_checkpoint_sink', sink: 'gcs', ...logged });
        expect(google.requests.some((request) => request.method !== 'GET')).toBe(false);
        expect(await refusesConnections(port)).toBe(true);
      }
    }, 30_000);

    it('review F01: a signed checkpoint the bucket retains beyond the database is a rollback; one signed by another key is invalid', async () => {
      const h = await database();
      const dir = await temporary();
      await writeRelayKey(dir);
      await certificates(dir);
      const port = await freePort();
      const role = await loginRole(h, 'tm8_vault_broker');
      const plant = (privateKey: Parameters<typeof sign>[2]) => {
        const body = { seq: 5, headHash: 'b'.repeat(64), at: '2026-11-21T00:00:00.000Z', keyId: keyVersionName };
        return new Map([['checkpoints/000000000005.json', Buffer.from(JSON.stringify({ ...body, signature: sign(null, checkpointSigningInput(body), privateKey).toString('base64url') }))]]);
      };
      const objects = new Map<string, Buffer>();
      const google = await googleFake({ objects });
      const cases = [[google.signing.privateKey, 'anchor_rollback'], [generateKeyPairSync('ed25519').privateKey, 'anchor_invalid']] as const;
      for (const [privateKey, reason] of cases) {
        objects.clear();
        for (const [name, bytes] of plant(privateKey)) objects.set(name, bytes);
        const records: Record<string, unknown>[] = [];
        const error = await composeBroker(productionEnv(dir, role, port), { gcp: { tokens, kmsBaseUrl: google.baseUrl, gcsBaseUrl: google.baseUrl }, hostProc: hardenedHost(),
          log: (record) => records.push(record) }).then(() => null, (reason: unknown) => reason);
        expect(failureMessage(error)).toBe('vault broker: refused (audit_unavailable)');
        expect(records).toContainEqual({ event: 'vault_audit_anchor_failed', reason });
        expect(await refusesConnections(port)).toBe(true);
      }
      expect(google.requests.some((request) => request.method !== 'GET')).toBe(false);
      expect(google.requests.filter((request) => request.url.searchParams.get('alt') === 'media')).toHaveLength(2);
    }, 30_000);
  });
});
