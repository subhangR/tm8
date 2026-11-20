import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { RemoteFillDriver } from '../../src/browser/remote-driver.js';
import { FrameReader, MAX_RESPONSE_BYTES, encodeJsonFrame } from '../../src/browser/protocol.js';
import { SecretMaterial, zeroize } from '../../src/secret-material.js';
import { E2E_REASON, descendants, e2eEnabled, localServer, loginPage, until } from './fixtures.js';

describe.skipIf(!e2eEnabled)(`worker isolation and SIGKILL acceptance 13 — ${E2E_REASON}`, () => {
  let site: Awaited<ReturnType<typeof localServer>>;
  let filled = 0;
  const fonts: import('node:http').ServerResponse[] = [];
  beforeAll(async () => {
    site = await localServer((request, response) => {
      if (request.url === '/font') { fonts.push(response); return; }
      if (request.url === '/filled') { filled += 1; response.end('ok'); return; }
      if (request.url === '/session') { response.end('<body>Logged in</body>'); return; }
      response.setHeader('Content-Type', 'text/html');
      response.end(loginPage('/session', request.url === '/slow' ? '<style>@font-face{font-family:hold;src:url(/font)}body{font-family:hold}</style><p>Hold font</p>' : '',
        'password.addEventListener("input",()=>{fetch("/filled")})'));
    });
  });
  afterAll(async () => { for (const response of fonts) response.end(); await site?.close(); });

  async function worker(timeoutMs = 10_000) {
    const directory = await mkdtemp('/dev/shm/vault-worker-test-');
    const profile = join(directory, 'profile'); await mkdir(profile, { mode: 0o700 });
    const socketPath = join(directory, 'fill.sock');
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    const child = spawn(process.execPath, [fileURLToPath(new URL('./worker-host.mjs', import.meta.url)), socketPath, profile, String(timeoutMs)],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: profile, DEBUG: '', PWDEBUG: '0', NODE_OPTIONS: '' } });
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    let exited = false; child.once('exit', () => { exited = true; });
    try { await until(async () => { if (exited) throw new Error('test worker exited before ready'); return output.some((x) => x.includes('worker-ready')); }); }
    catch { child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); throw new Error('test worker unavailable'); }
    return { child, directory, profile, socketPath, output, errors,
      async cleanup() {
        const pids = child.pid ? await descendants(child.pid) : [];
        if (!exited) child.kill('SIGTERM');
        for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } }
        if (!exited) await waitExit(child);
        for (const buffer of [...output, ...errors]) zeroize(buffer);
        await rm(directory, { recursive: true, force: true });
      } };
  }
  function material() { return { username: 'fixture-user', password: SecretMaterial.fromUtf8(['canary', randomUUID(), 'fixture'].join('-')), totp: null }; }
  function intent(path: string) { return { operationId: randomUUID(), itemId: 'fixture-login', origin: site.origin, startUrl: `${site.origin}${path}`, submit: false, devMode: true }; }

  it('serves distinct correlated health and fill responses on a mode-0660 socket', async () => {
    const host = await worker();
    const driver = new RemoteFillDriver(host.socketPath);
    const login = material();
    try {
      expect((await stat(host.socketPath)).mode & 0o777).toBe(0o660);
      const health = await getHealth(host.socketPath);
      expect(health).toEqual({ id: 'health-test', op: 'health', ok: true, ready: true });
      const outcome = await driver.fill({ intent: intent('/'), material: login });
      try { expect(outcome.ok).toBe(true); expect(outcome.screenshot !== null).toBe(true); }
      finally { zeroize(outcome.screenshot?.data); }
      expect(login.password.disposed).toBe(false);
    } finally { login.password.dispose(); await driver.close(); await host.cleanup(); }
  });

  it('runs only one fill at a time and enforces the hard fill deadline', async () => {
    const host = await worker(3_000);
    const driver = new RemoteFillDriver(host.socketPath, { timeoutMs: 6_000 });
    const login = material();
    const before = filled;
    const started = Date.now();
    const pending = driver.fill({ intent: intent('/slow'), material: login });
    try {
      await until(() => filled > before);
      expect((await getHealth(host.socketPath)).ready).toBe(false);
      const duplicate = await driver.fill({ intent: intent('/'), material: login });
      try { expect(duplicate.ok).toBe(false); if (!duplicate.ok) expect(duplicate.code).toBe('browser_unavailable'); }
      finally { zeroize(duplicate.screenshot?.data); }
      const outcome = await pending;
      try { expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.code).toBe('timeout'); }
      finally { zeroize(outcome.screenshot?.data); }
      expect(Date.now() - started < 5_000).toBe(true);
    } finally {
      const outcome = await pending; zeroize(outcome.screenshot?.data);
      login.password.dispose(); await driver.close(); await host.cleanup();
    }
  });

  it('13: SIGKILL mid-fill leaves no canary in output, runtime/profile files or any core file', async () => {
    const host = await worker();
    const driver = new RemoteFillDriver(host.socketPath);
    const login = material();
    const encodings = login.password.use((bytes) => [Buffer.from(bytes), Buffer.from(bytes.toString('base64')), Buffer.from(bytes.toString('hex'))]);
    const before = filled;
    const pending = driver.fill({ intent: intent('/slow'), material: login });
    try {
      await until(() => filled > before);
      const processes = await descendants(host.child.pid!);
      expect(processes.length > 0).toBe(true);
      host.child.kill('SIGKILL');
      await waitExit(host.child);
      const outcome = await pending;
      try { expect(outcome.ok).toBe(false); } finally { zeroize(outcome.screenshot?.data); }
      // EOF must also reap descendants, not just remove the Unix listener.
      await until(async () => {
        for (const pid of processes) {
          try { const status = await readFile(`/proc/${pid}/stat`, 'utf8'); if (status.slice(status.lastIndexOf(')') + 2, status.lastIndexOf(')') + 3) !== 'Z') return false; }
          catch { /* reaped */ }
        }
        return true;
      });
      // Scan complete streams too: a canary may span two transport chunks.
      const artifacts = [Buffer.concat(host.output), Buffer.concat(host.errors)];
      await gatherFiles(host.directory, artifacts);
      try {
        // Assertion exposes only a boolean; a failing scan never prints a canary.
        expect(artifacts.some((artifact) => encodings.some((value) => artifact.includes(value)))).toBe(false);
      } finally { for (const artifact of artifacts) zeroize(artifact); }
    } finally {
      const outcome = await pending; zeroize(outcome.screenshot?.data);
      for (const value of encodings) zeroize(value);
      login.password.dispose(); await driver.close(); await host.cleanup();
    }
  });
});

async function getHealth(path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const outgoing = encodeJsonFrame({ id: 'health-test', op: 'health' });
    const reader = new FrameReader(MAX_RESPONSE_BYTES, (body) => {
      try { resolve(JSON.parse(body.toString('utf8'))); }
      catch { reject(new Error('invalid test health response')); }
      finally { zeroize(body); reader.dispose(); socket.destroy(); }
    });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('test health timeout')); }, 2_000);
    socket.on('connect', () => socket.write(outgoing, () => zeroize(outgoing)));
    socket.on('data', (chunk) => { try { reader.push(chunk); } catch { reject(new Error('invalid test health frame')); socket.destroy(); } });
    socket.on('error', () => reject(new Error('test health unavailable')));
    socket.on('close', () => { clearTimeout(timer); zeroize(outgoing); reader.dispose(); });
  });
}

async function gatherFiles(directory: string, result: Buffer[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await gatherFiles(path, result);
    else if (entry.isFile()) {
      // Includes all runtime and profile files, and any core/minidump files.
      try { result.push(await readFile(path)); } catch { throw new Error('test artifact scan failed'); }
    }
  }
}

async function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}
