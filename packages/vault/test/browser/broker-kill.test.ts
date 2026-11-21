/**
 * Acceptance test 13, its broker clause: kill the broker mid-fill, and an
 * automated scan finds zero canary secret values in logs, traces or crash
 * artifacts.
 *
 * A real broker process (pre_review, a dedicated login role on scratch
 * Postgres) drives a real fill worker process. The fill types a canary password
 * into a page that never finishes loading, and the broker is SIGKILLed while
 * the fill is in flight. Then:
 *  - the worker, its broker connection closed, kills every process of the fill
 *    (Playwright runs the browser in a session of its own), removes the fill's
 *    scratch profile and serves again;
 *  - a restarted broker marks the fill unknown before it serves, so a retry of
 *    the same operation is told `unknown` and never fills a second time;
 *  - no canary, in any encoding the vault's own filter matches, is in either
 *    broker's or the worker's stdout or stderr (the broker's only trace is its
 *    per-request log line), in any file under the test's directories (every
 *    TMPDIR, runtime and profile directory), in a crash report or core that
 *    apport wrote for this user during the test, or in the vault schema's dump.
 *
 * The restart removes the broker's socket directory first, as systemd's
 * RuntimeDirectory= does when the unit stops: the broker refuses a leftover
 * socket path rather than unlinking it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock, type VaultCaller } from '../../src/core-types.js';
import { LocalDevKms } from '../../src/crypto/kms.js';
import { exportAttestationKeyPair, generateAttestationKeyPair, signAttestation } from '../../src/relay/attestation.js';
import { zeroize } from '../../src/secret-material.js';
import { PG_ENABLED, PG_REASON, pgHarness, type PgHarness } from '../store/pg-harness.js';
import { agentOf, newLogin, scopeOf, testCaller, testSecret } from '../support/kit.js';
import { E2E_REASON, descendants, e2eEnabled, ended, gatherFiles, localServer, loginPage, pin, reap, settles, startWorkerHost,
  until, waitExit, workerHealth, type PinnedProcess } from './fixtures.js';

const BROKER_MAIN = fileURLToPath(new URL('../../dist/broker/main.js', import.meta.url));
const relay = generateAttestationKeyPair();

interface BrokerProcess { child: ChildProcess; output: Buffer[]; errors: Buffer[] }

/** `node dist/broker/main.js`, once it logs that it listens. */
async function startBrokerProcess(env: Record<string, string>, cwd: string): Promise<BrokerProcess> {
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  const child = spawn(process.execPath, [BROKER_MAIN], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', (chunk: Buffer) => output.push(chunk));
  child.stderr!.on('data', (chunk: Buffer) => errors.push(chunk));
  let exited = false; child.once('exit', () => { exited = true; });
  try {
    await until(() => {
      // The broker's stderr is a fixed vocabulary: naming it here cannot print a secret.
      if (exited) throw new Error(`test broker exited before listening: ${Buffer.concat(errors).toString('utf8').slice(0, 200)}`);
      return Buffer.concat(output).includes('"vault_broker_listening"');
    }, 15_000);
  } catch (error) { child.kill('SIGKILL'); await waitExit(child); throw error; }
  return { child, output, errors };
}

/** One attested request on the broker's socket. A dropped connection resolves as `failed`, never throws. */
function attested(socketPath: string, caller: VaultCaller, path: string, body: Buffer): Promise<{ status: number; text: Buffer } | { failed: string }> {
  const header = signAttestation({ privateKey: relay.privateKey, caller, clock: systemClock, request: { method: 'POST', path, query: '', body } });
  return new Promise((resolve) => {
    const failed = (error: NodeJS.ErrnoException) => resolve({ failed: error.code ?? 'error' });
    const req = httpRequest({ socketPath, path, method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': String(body.length), 'x-tm8-vault-caller': header } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks) }));
      res.once('error', failed);
    });
    req.once('error', failed);
    req.end(body);
  });
}

/**
 * A canary in each encoding the vault's filter matches (src/canary/encodings.ts:
 * raw, which its JSON and URL forms equal for this alphabet, and base64), plus
 * hex and UTF-16. Base64 at all three byte alignments, keeping only the
 * sextets the value alone determines, so the value is found inside any larger
 * encoded blob.
 */
function encodings(value: Buffer): Buffer[] {
  const hex = value.toString('hex');
  const needles = [Buffer.from(value), Buffer.from(hex), Buffer.from(hex.toUpperCase()), Buffer.from(value.toString('utf8'), 'utf16le')];
  for (let shift = 0; shift < 3; shift += 1) {
    const text = Buffer.concat([Buffer.alloc(shift), value]).toString('base64');
    const core = text.slice(Math.ceil((shift * 8) / 6), Math.floor(((shift + value.length) * 8) / 6));
    needles.push(Buffer.from(core), Buffer.from(core.replaceAll('+', '-').replaceAll('/', '_')));
  }
  return needles;
}

/** What apport wrote for this user since `since`: where a crash report or core of this test's processes would land. */
async function crashArtifactsSince(since: number): Promise<Buffer[]> {
  const found: Buffer[] = [];
  const uid = process.getuid?.() ?? -1;
  for (const directory of ['/var/crash', '/var/lib/apport/coredump']) {
    let names: string[];
    try { names = await readdir(directory); } catch { continue; }
    for (const name of names) {
      const info = await stat(join(directory, name)).catch(() => null);
      if (!info?.isFile() || info.uid !== uid || info.mtimeMs < since) continue;
      // An artifact the scan cannot read cannot be shown clean: readFile throws.
      found.push(await readFile(join(directory, name)));
    }
  }
  return found;
}

const SKIPPED = !e2eEnabled ? E2E_REASON : !PG_ENABLED ? PG_REASON : null;

if (SKIPPED) describe('broker SIGKILL mid-fill, acceptance 13', () => { it('requires the browser E2E harness and a scratch Postgres', (ctx) => ctx.skip(SKIPPED)); });
else describe('broker SIGKILL mid-fill, acceptance 13', () => {
  let site: Awaited<ReturnType<typeof localServer>>;
  let filled = 0;
  const fonts: ServerResponse[] = [];
  beforeAll(async () => {
    site = await localServer((request, response) => {
      if (request.url === '/font') { fonts.push(response); return; }
      if (request.url === '/filled') { filled += 1; response.end('ok'); return; }
      if (request.url === '/session') { response.end('<body>Logged in</body>'); return; }
      response.setHeader('Content-Type', 'text/html');
      // The held font keeps the fill in flight after the password is typed.
      response.end(loginPage('/session', '<style>@font-face{font-family:hold;src:url(/font)}body{font-family:hold}</style><p>Hold font</p>',
        'password.addEventListener("input",()=>{fetch("/filled")})'));
    });
  });
  afterAll(async () => { for (const response of fonts) response.end(); await site?.close(); });

  it('13: a broker SIGKILLed mid-fill leaves no canary in logs, traces, crash artifacts or the database, and its restart reports the fill unknown', async () => {
    const since = Date.now();
    const root = await mkdtemp('/dev/shm/vault-broker-kill-');
    const brokerDir = join(root, 'broker');
    const workerDir = join(root, 'worker');
    const runtime = join(workerDir, 'runtime');
    for (const directory of [brokerDir, workerDir, runtime]) await mkdir(directory, { mode: 0o700 });
    const role = `vault_test_login_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const password = Buffer.from(['canary', randomUUID(), 'password'].join('-'));
    const notes = Buffer.from(['canary', randomUUID(), 'notes'].join('-'));
    const needles = [...encodings(password), ...encodings(notes)];
    const hit = (haystack: Buffer) => needles.some((needle) => haystack.includes(needle));
    let h: PgHarness | undefined;
    let worker: Awaited<ReturnType<typeof startWorkerHost>> | undefined;
    const brokers: BrokerProcess[] = [];
    let fill: PinnedProcess[] = [];
    const scanned: Buffer[] = [];
    try {
      h = await pgHarness();
      await h.admin.query(`create role ${role} login`);
      await h.admin.query(`grant tm8_vault_broker to ${role}`);
      const databaseUrl = new URL(h.url);
      databaseUrl.username = role;
      // The broker opens this same KEK file, so it can decrypt what the test seals.
      const kms = LocalDevKms.fromFile(join(brokerDir, 'kek'));
      const item = newLogin(testCaller, { devMode: true, origins: [site.origin], username: 'fixture-user', hasNotes: true });
      const secret = await testSecret(kms, { id: item.id, ownerMemberId: testCaller.memberId }, 1,
        JSON.stringify({ password: password.toString('utf8'), notes: notes.toString('utf8') }));
      await h.store.transaction(scopeOf(testCaller), (tx) => tx.items.create(item, secret));
      await writeFile(join(brokerDir, 'relay.pub'), exportAttestationKeyPair(relay).publicPem, { mode: 0o600 });

      const fillSocket = join(workerDir, 'fill.sock');
      const brokerSocket = join(brokerDir, 'run', 'broker.sock');
      const env = {
        PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_OPTIONS: '', TMPDIR: brokerDir,
        TM8_VAULT_MODE: 'pre_review',
        TM8_VAULT_DATABASE_URL: databaseUrl.toString(),
        TM8_VAULT_BROKER_SOCKET: brokerSocket,
        TM8_VAULT_RELAY_PUBLIC_KEY_FILE: join(brokerDir, 'relay.pub'),
        TM8_VAULT_DELETION_LEDGER: join(brokerDir, 'deletions.log'),
        TM8_VAULT_FILL_SOCKET: fillSocket,
        TM8_VAULT_LOCAL_KEK_FILE: join(brokerDir, 'kek'),
        TM8_VAULT_PRE_REVIEW_FILL_ORIGINS: site.origin,
      };
      worker = await startWorkerHost(fillSocket, runtime, 20_000);
      brokers.push(await startBrokerProcess(env, brokerDir));

      const caller = agentOf(testCaller);
      const operationId = randomUUID();
      const path = `/v2/vault/items/${item.id}/fill`;
      const body = Buffer.from(JSON.stringify({ operationId, origin: site.origin, startUrl: `${site.origin}/slow`, submit: false, purpose: 'acceptance test 13' }));
      const before = filled;
      const first = attested(brokerSocket, caller, path, body);
      let early: { status: number; text: Buffer } | null = null;
      void first.then((reply) => { if ('status' in reply) early = reply; });
      await until(() => {
        // A refusal carries a problem code, never a secret: name it rather than time out blind.
        if (early) throw new Error(`test fill answered before typing: ${early.status} ${early.text.toString('utf8').slice(0, 200)}`);
        return filled > before;
      }, 15_000);
      fill = await pin(await descendants(worker.child.pid!));
      // The fill child, and a browser that is not the worker's own child.
      expect([fill.some((entry) => entry.parent === worker!.child.pid), fill.some((entry) => entry.parent !== worker!.child.pid)]).toEqual([true, true]);

      brokers[0]!.child.kill('SIGKILL');
      await waitExit(brokers[0]!.child);
      expect('failed' in (await first)).toBe(true);
      // The worker saw its broker go: every process of the fill is dead, its profile gone, and the worker serves again.
      expect(await settles(() => ended(fill), 5_000)).toBe(true);
      expect(await settles(async () => (await readdir(runtime)).length === 0, 5_000)).toBe(true);
      expect(await settles(async () => (await workerHealth(fillSocket)).ready === true, 5_000)).toBe(true);
      const typed = filled;

      await rm(join(brokerDir, 'run'), { recursive: true, force: true });
      brokers.push(await startBrokerProcess(env, brokerDir));
      const retry = await attested(brokerSocket, caller, path, body);
      if ('failed' in retry) throw new Error(`test retry failed: ${retry.failed}`);
      scanned.push(retry.text);
      expect([retry.status, JSON.parse(retry.text.toString('utf8')).data]).toEqual([200, { state: 'unknown', operationId, itemId: item.id }]);
      expect(filled).toBe(typed);

      // Every writer stops before the scan, so each stream is complete.
      brokers[1]!.child.kill('SIGTERM');
      await waitExit(brokers[1]!.child);
      worker.child.kill('SIGTERM');
      await waitExit(worker.child);
      const streams = [...brokers.flatMap((broker) => [Buffer.concat(broker.output), Buffer.concat(broker.errors)]),
        Buffer.concat(worker.output), Buffer.concat(worker.errors)];
      const files: Buffer[] = [];
      await gatherFiles(root, files);
      const crashes = await crashArtifactsSince(since);
      const dump = Buffer.from(await h.dump());
      scanned.push(...streams, ...files, ...crashes, dump);
      // Not vacuous: these are the real streams, files and ledger of this fill.
      expect([streams[0]!.includes('"vault_broker_listening"'), streams[2]!.includes('"vault_broker_listening"'),
        streams[2]!.includes('"vault_broker_request"'), streams[4]!.includes('worker-ready'), files.length >= 2,
        dump.includes(item.id), dump.includes('fill.started'), dump.includes('fill.unknown')]).toEqual(new Array(8).fill(true));
      // The scan finds each canary embedded at any byte offset in every encoding it checks.
      const planted = [password, notes].flatMap((value) => [0, 1, 2].flatMap((offset) => {
        const wrapped = Buffer.concat([Buffer.alloc(offset, 0x7b), value, Buffer.from('"}')]);
        return [Buffer.concat([Buffer.from('log '), wrapped]), Buffer.from(`k=${wrapped.toString('base64')}`),
          Buffer.from(`k=${wrapped.toString('base64url')}`), Buffer.from(`k=${wrapped.toString('hex').toUpperCase()}`),
          Buffer.from(`k=${wrapped.toString('utf8')}`, 'utf16le')];
      }));
      expect(planted.map(hit)).toEqual(planted.map(() => true));
      for (const buffer of planted) zeroize(buffer);
      // Only booleans: a failing scan names where, never what.
      expect({ streams: streams.some(hit), files: files.some(hit), crashes: crashes.some(hit), database: hit(dump),
        replies: hit(retry.text) }).toEqual({ streams: false, files: false, crashes: false, database: false, replies: false });
    } finally {
      await reap(fill);
      for (const broker of brokers) {
        if (broker.child.exitCode === null && broker.child.signalCode === null) { broker.child.kill('SIGKILL'); await waitExit(broker.child); }
        for (const buffer of [...broker.output, ...broker.errors]) zeroize(buffer);
      }
      await worker?.stop();
      for (const buffer of [password, notes, ...needles, ...scanned]) zeroize(buffer);
      if (h) {
        await h.admin.query(`drop role if exists ${role}`).catch(() => undefined);
        await h.dispose();
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
