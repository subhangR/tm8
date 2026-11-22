import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RemoteFillDriver } from '../../src/browser/remote-driver.js';
import { SecretMaterial, zeroize } from '../../src/secret-material.js';
import { E2E_REASON, descendants, e2eEnabled, ended, gatherFiles, localServer, loginPage, pin, reap, settles, startWorkerHost, until,
  waitExit, workerHealth, type PinnedProcess } from './fixtures.js';

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
    let host: Awaited<ReturnType<typeof startWorkerHost>>;
    try { host = await startWorkerHost(socketPath, profile, timeoutMs); }
    catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    return { ...host, directory, profile, socketPath,
      async cleanup() { await host.stop(); await rm(directory, { recursive: true, force: true }); } };
  }
  /** The in-flight fill: the worker's one fill child, and the browser under it. */
  async function inFlight(host: { child: { pid?: number } }) {
    const tree = await pin(await descendants(host.child.pid!));
    return { fillChild: tree.filter((entry) => entry.parent === host.child.pid), browser: tree.filter((entry) => entry.parent !== host.child.pid) };
  }
  function material() { return { username: 'fixture-user', password: SecretMaterial.fromUtf8(['canary', randomUUID(), 'fixture'].join('-')), totp: null }; }
  function intent(path: string) { return { operationId: randomUUID(), itemId: 'fixture-login', origin: site.origin, startUrl: `${site.origin}${path}`, submit: false, devMode: true }; }

  it('serves distinct correlated health and fill responses on a mode-0660 socket', async () => {
    const host = await worker();
    const driver = new RemoteFillDriver(host.socketPath);
    const login = material();
    try {
      expect((await stat(host.socketPath)).mode & 0o777).toBe(0o660);
      const health = await workerHealth(host.socketPath);
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
      expect((await workerHealth(host.socketPath)).ready).toBe(false);
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

  // Playwright starts Chromium in a session of its own, outside the fill child's
  // process group. A stopped browser cannot exit on its closed DevTools pipe, so
  // only the worker's own kill can end it: these two tests prove that kill.
  it('kills a wedged browser at the hard deadline and removes its profile', async () => {
    // The deadline must outlast launching Chromium and typing on a loaded host, or it kills the browser before
    // the test can wedge it.
    const host = await worker(8_000);
    const driver = new RemoteFillDriver(host.socketPath, { timeoutMs: 12_000 });
    const login = material();
    const before = filled;
    const pending = driver.fill({ intent: intent('/slow'), material: login });
    let answered = false; void pending.then(() => { answered = true; });
    let browser: PinnedProcess[] = [];
    try {
      await until(() => filled > before);
      browser = (await inFlight(host)).browser;
      if (browser.length === 0) {
        throw new Error(answered ? 'test harness: the fill ended before its browser was wedged; raise the worker deadline'
          : 'test harness: no browser outside the fill child, or the deadline has just killed it');
      }
      for (const { pid } of browser) process.kill(pid, 'SIGSTOP');
      const outcome = await pending;
      try { expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.code).toBe('timeout'); }
      finally { zeroize(outcome.screenshot?.data); }
      expect(await settles(() => ended(browser), 3_000)).toBe(true);
      expect(await settles(async () => (await readdir(host.profile)).length === 0, 3_000)).toBe(true);
    } finally {
      await reap(browser);
      const outcome = await pending; zeroize(outcome.screenshot?.data);
      login.password.dispose(); await driver.close(); await host.cleanup();
    }
  }, 30_000);

  it('kills the browser of a fill child that died on its own, found by its profile, and removes the profile', async () => {
    const host = await worker();
    const driver = new RemoteFillDriver(host.socketPath);
    const login = material();
    const before = filled;
    const pending = driver.fill({ intent: intent('/slow'), material: login });
    let browser: PinnedProcess[] = [];
    try {
      await until(() => filled > before);
      const tree = await inFlight(host);
      browser = tree.browser;
      expect([tree.fillChild.length, browser.length > 0]).toEqual([1, true]);
      for (const { pid } of browser) process.kill(pid, 'SIGSTOP');
      // Orphaned, the browser has no parent the worker could follow.
      process.kill(tree.fillChild[0]!.pid, 'SIGKILL');
      const outcome = await pending;
      try { expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.code).toBe('browser_unavailable'); }
      finally { zeroize(outcome.screenshot?.data); }
      expect(await settles(() => ended(browser), 3_000)).toBe(true);
      expect(await settles(async () => (await readdir(host.profile)).length === 0, 3_000)).toBe(true);
    } finally {
      await reap(browser);
      const outcome = await pending; zeroize(outcome.screenshot?.data);
      login.password.dispose(); await driver.close(); await host.cleanup();
    }
  });

  it('kills a wedged browser when its worker dies mid-fill, and removes its profile', async () => {
    const host = await worker();
    const driver = new RemoteFillDriver(host.socketPath);
    const login = material();
    const before = filled;
    const pending = driver.fill({ intent: intent('/slow'), material: login });
    let fill: PinnedProcess[] = [];
    try {
      await until(() => filled > before);
      const tree = await inFlight(host);
      fill = [...tree.fillChild, ...tree.browser];
      expect([tree.fillChild.length, tree.browser.length > 0]).toEqual([1, true]);
      // A responsive browser exits when its CDP pipe closes. A wedged one cannot: only the fill child, told by
      // its own parent pipe that the worker died, can kill it.
      for (const { pid } of tree.browser) process.kill(pid, 'SIGSTOP');
      host.child.kill('SIGKILL');
      await waitExit(host.child);
      const outcome = await pending;
      try { expect(outcome.ok).toBe(false); } finally { zeroize(outcome.screenshot?.data); }
      expect(await settles(() => ended(fill), 3_000)).toBe(true);
      expect(await settles(async () => (await readdir(host.profile)).length === 0, 3_000)).toBe(true);
    } finally {
      await reap(fill);
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
      // Its supervisor gone, the fill child killed the browser and removed its profile.
      expect(await readdir(host.profile)).toEqual([]);
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
