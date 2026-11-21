import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VAULT_OPERATIONS } from '@tm8/contract';
import { BROKER_ENV_KNOBS, BrokerConfigError } from '../../src/broker/config.js';
import { BROKER_RUNTIME_ENV_KNOBS, composeBroker, createVaultHandlers, failureMessage, type ComposedBroker } from '../../src/broker/main.js';
import { SYSTEM_ACTOR, VaultError, actorOf, systemClock, type VaultAlert, type VaultTx } from '../../src/core-types.js';
import { crc32c } from '../../src/gcp/crc32c.js';
import { VAULT_ALERTS_HEADER, decodeVaultAlerts } from '../../src/relay/alerts.js';
import { exportAttestationKeyPair, generateAttestationKeyPair, signAttestation } from '../../src/relay/attestation.js';
import { OWNER_ID, SPACE_A, fakeSecret, newLogin, otherCaller, scopeOf, testCaller } from '../support/kit.js';
import { json, keyName, keyVersionName, loopbackSuite, tokens } from '../gcp/fake.js';
import { PG_ENABLED, PG_REASON, pgHarness, type PgHarness } from '../store/pg-harness.js';

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
    [{ TM8_VAULT_BROKER_MTLS_LISTEN: '127.0.0.1' }, 'TM8_VAULT_BROKER_MTLS_LISTEN'],
    [{ TM8_VAULT_BROKER_MTLS_LISTEN: '127.0.0.1:0' }, 'TM8_VAULT_BROKER_MTLS_LISTEN'],
    [{ TM8_VAULT_BROKER_MTLS_LISTEN: '127.0.0.1:65536' }, 'TM8_VAULT_BROKER_MTLS_LISTEN'],
    [{ TM8_VAULT_BROKER_MTLS_LISTEN: '127.0.0.1:8443', TM8_VAULT_BROKER_TLS_KEY_FILE: '/k', TM8_VAULT_BROKER_TLS_CERT_FILE: '/c' }, 'TM8_VAULT_BROKER_TLS_CA_FILE'],
    [{ TM8_VAULT_BROKER_TLS_KEY_FILE: '/k' }, 'TM8_VAULT_BROKER_TLS_KEY_FILE'],
    [{ TM8_VAULT_KMS_KIND: 'vault-transit' }, 'TM8_VAULT_KMS_KIND'],
    [{ TM8_VAULT_KMS_KIND: 'test-fake' }, 'TM8_VAULT_KMS_KIND'],
    [{ TM8_VAULT_CANARY_FILE: '/nonexistent/vault-test-canaries' }, 'TM8_VAULT_CANARY_FILE'],
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
  ] as const)('production %j is refused as %s before any KMS, database or network call', async (patch, knob) => {
    const dir = await temporary();
    const error = await refusal(composeBroker(preReviewEnv(dir, { TM8_VAULT_MODE: 'production', ...patch })));
    expect(error.knob).toBe(knob);
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
    const broker = (await composeBroker(preReviewEnv(dir, {
      TM8_VAULT_DATABASE_URL: h.url, TM8_VAULT_AUDIT_SINK: 'file', TM8_VAULT_CHECKPOINT_DIR: join(dir, 'checkpoints'),
      TM8_VAULT_CHECKPOINT_KEY_FILE: join(dir, 'checkpoint.key'),
    }), { log: (record) => records.push(record) }))!;
    brokers.push(broker);

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
      for (const name of ['server', 'client']) {
        openssl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', file(dir, `${name}.key`), '-out', file(dir, `${name}.csr`), '-subj', `/CN=vault-test-${name}`]);
        await writeFile(file(dir, `${name}.ext`), name === 'server' ? 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' : 'extendedKeyUsage=clientAuth\n');
        openssl(['x509', '-req', '-in', file(dir, `${name}.csr`), '-CA', file(dir, 'ca.crt'), '-CAkey', file(dir, 'ca.key'), '-CAcreateserial',
          '-out', file(dir, `${name}.crt`), '-days', '1', '-extfile', file(dir, `${name}.ext`)]);
      }
    }
    async function freePort(): Promise<number> {
      const server = createNetServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return port;
    }
    async function googleFake() {
      const signing = generateKeyPairSync('ed25519');
      const pem = signing.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      return fake((req, res) => {
        const path = req.url.pathname;
        if (req.method === 'GET' && path === `/v1/${keyName}`) return json(res, { purpose: 'ENCRYPT_DECRYPT', primary: { state: 'ENABLED', protectionLevel: 'HSM' } });
        if (req.method === 'GET' && path === `/v1/${keyVersionName}/publicKey`) {
          return json(res, { pem, pemCrc32c: String(crc32c(Buffer.from(pem))), algorithm: 'EC_SIGN_ED25519', name: keyVersionName });
        }
        if (req.method === 'GET' && path === `/storage/v1/b/${bucket}`) return json(res, {});
        json(res, { error: { code: 404 } }, 404);
      });
    }

    it('refuses any database login but a dedicated broker role, then serves only over pinned mTLS', async () => {
      const h = await database();
      const dir = await temporary();
      await writeRelayKey(dir);
      await certificates(dir);
      const google = await googleFake();
      const port = await freePort();
      const env = (databaseUrl: string) => ({
        ...preReviewEnv(dir), TM8_VAULT_MODE: 'production', TM8_VAULT_REVIEW_GATE: 'passed', TM8_VAULT_LOCAL_KEK_FILE: undefined,
        TM8_VAULT_DATABASE_URL: databaseUrl, TM8_VAULT_PUBLIC_ORIGIN: 'https://tm8.example.test',
        TM8_VAULT_KMS_KIND: 'gcp-kms', TM8_VAULT_GCP_KMS_KEY: keyName,
        TM8_VAULT_AUDIT_SINK: 'gcs', TM8_VAULT_GCS_BUCKET: bucket, TM8_VAULT_GCP_CHECKPOINT_KEY_VERSION: keyVersionName,
        TM8_VAULT_BROKER_MTLS_LISTEN: `127.0.0.1:${port}`, TM8_VAULT_BROKER_TLS_KEY_FILE: file(dir, 'server.key'),
        TM8_VAULT_BROKER_TLS_CERT_FILE: file(dir, 'server.crt'), TM8_VAULT_BROKER_TLS_CA_FILE: file(dir, 'ca.crt'),
      });
      const gcp = { tokens, kmsBaseUrl: google.baseUrl, gcsBaseUrl: google.baseUrl };

      // The trust-auth superuser ignores RLS (review finding HIGH): production never runs on it.
      const superuser = await refusal(composeBroker(env(h.url), { gcp, log: () => undefined }));
      expect(superuser.knob).toBe('TM8_VAULT_DATABASE_URL');
      const wider = await refusal(composeBroker(env(await loginRole(h, 'tm8_vault_broker', 'tm8_app')), { gcp, log: () => undefined }));
      expect(wider.knob).toBe('TM8_VAULT_DATABASE_URL');
      const outsider = await refusal(composeBroker(env(await loginRole(h)), { gcp, log: () => undefined }));
      expect(outsider.knob).toBe('TM8_VAULT_DATABASE_URL');
      await expect(lstat(join(dir, 'broker.sock'))).rejects.toMatchObject({ code: 'ENOENT' });

      const broker = (await composeBroker(env(await loginRole(h, 'tm8_vault_broker')), { gcp, log: () => undefined }))!;
      brokers.push(broker);
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
    }, 30_000);
  });
});
