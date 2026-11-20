import { createServer, type Socket } from 'node:net';
import { chmod } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SecretMaterial, zeroize } from '../secret-material.js';
import type { FillOutcome } from '../types.js';
import { PlaywrightFillDriver } from './playwright-driver.js';
import { probeIsolatedBrowser } from './browser-session.js';
import { DEFAULT_FILL_TIMEOUT_MS, FrameReader, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, decodeOutcome,
  encodeJsonFrame, encodeOutcome, frame, parseRequest, refusal } from './protocol.js';

/** Parent serves the uid-protected socket; each fill gets a killable process group. */
interface WorkerOptions {
  socketPath: string; timeoutMs?: number; executablePath?: string; runtimeDirectory?: string;
  /** Only set by the opt-in test harness on hosts that prohibit user namespaces. */
  testOnlyDisableSandbox?: boolean;
}

export async function startFillWorker(options: WorkerOptions): Promise<{ close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  let active: ChildProcess | null = null;
  let closed = false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FILL_TIMEOUT_MS;
  // Probe sandbox AND renderer before accepting material. A failed probe leaves
  // a reachable but unready socket, so the broker fails closed without guessing.
  const browserReady = await probeWorker(options);
  const server = createServer((socket) => {
    sockets.add(socket);
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => socket.destroy(), 5_000);
    const reader = new FrameReader(MAX_REQUEST_BYTES, (body) => {
      if (timer) clearTimeout(timer);
      timer = null;
      let request;
      try { request = parseRequest(body); }
      catch { zeroize(body); socket.destroy(); return; }
      if (request.op === 'health') {
        zeroize(body);
        send(socket, encodeJsonFrame({ id: request.id, op: 'health', ok: true, ready: browserReady && !active && !closed }));
        return;
      }
      const id = request.id;
      // Drop parsed password strings before awaiting the child. V8 copies cannot be wiped.
      request.password_b64 = '';
      if (!browserReady || active || closed) { zeroize(body); send(socket, encodeOutcome(id, refusal('browser_unavailable'))); return; }
      const child = spawnFillChild(options);
      active = child;
      let finished = false;
      const finish = (outcome: FillOutcome) => {
        if (finished) { zeroize(outcome.screenshot?.data); return; }
        finished = true;
        if (timer) clearTimeout(timer);
        timer = null;
        killGroup(child);
        responseReader.dispose();
        // Keep the busy flag until the old process has actually exited.
        send(socket, encodeOutcome(id, outcome));
        zeroize(outcome.screenshot?.data);
      };
      const responseReader = new FrameReader(MAX_RESPONSE_BYTES, (response) => {
        try { finish(decodeOutcome(response, id)); } finally { zeroize(response); }
      });
      timer = setTimeout(() => finish(refusal('timeout')), timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        try { responseReader.push(chunk); } catch { finish(refusal('browser_unavailable')); }
      });
      child.once('error', () => finish(refusal('browser_unavailable')));
      child.once('exit', () => { if (active === child) active = null; finish(refusal('browser_unavailable')); });
      const outgoing = frame(body);
      zeroize(body);
      child.stdin?.on('error', () => { zeroize(outgoing); finish(refusal('browser_unavailable')); });
      // Keep the pipe open: EOF tells the child that its supervisor died.
      child.stdin?.write(outgoing, () => zeroize(outgoing));
      socket.once('close', () => finish(refusal('timeout')));
    });
    socket.on('data', (chunk: Buffer) => {
      try { reader.push(chunk); } catch { socket.destroy(); }
    });
    socket.on('error', () => {});
    socket.once('close', () => {
      reader.dispose();
      if (timer) clearTimeout(timer);
      sockets.delete(socket);
    });
  });
  server.maxConnections = 16;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => resolve());
  });
  // The unit/CLI umask makes the creation window owner-only. Publish to the broker group.
  await chmod(options.socketPath, 0o660);
  server.on('error', () => {});
  return {
    async close() {
      closed = true;
      if (active) killGroup(active);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function send(socket: Socket, outgoing: Buffer): void {
  if (socket.destroyed) { zeroize(outgoing); return; }
  const wipe = () => zeroize(outgoing);
  socket.once('close', wipe);
  socket.end(outgoing, () => { wipe(); socket.removeListener('close', wipe); });
}

function killGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already reaped */ }
}

function spawnFillChild(options: WorkerOptions): ChildProcess {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--fill-child'], {
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore', 'ipc'],
    env: {
      PATH: process.env.PATH,
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
      TMPDIR: options.runtimeDirectory ?? '/dev/shm',
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
      TM8_VAULT_CHROMIUM_EXECUTABLE: options.executablePath,
      TM8_VAULT_FILL_TIMEOUT_MS: String(options.timeoutMs ?? DEFAULT_FILL_TIMEOUT_MS),
      DEBUG: '', PWDEBUG: '0', NODE_OPTIONS: '',
    },
  });
  // This private inherited channel is never connected to the broker socket.
  // No CLI argument or environment variable can enable unsafe test flags.
  child.send?.({ testOnlyDisableSandbox: options.testOnlyDisableSandbox === true }, () => {});
  return child;
}

async function probeWorker(options: WorkerOptions): Promise<boolean> {
  const child = spawnFillChild({ ...options, timeoutMs: 5_000 });
  return new Promise<boolean>((resolve) => {
    let finished = false;
    const finish = (ready: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reader.dispose();
      killGroup(child);
      resolve(ready);
    };
    const reader = new FrameReader(MAX_RESPONSE_BYTES, (body) => {
      try {
        const result = JSON.parse(body.toString('utf8'));
        finish(result.id === 'startup-probe' && result.op === 'health' && result.ok === true && result.ready === true);
      } catch { finish(false); }
      finally { zeroize(body); }
    });
    const timer = setTimeout(() => finish(false), 5_000);
    child.stdout?.on('data', (chunk: Buffer) => { try { reader.push(chunk); } catch { finish(false); } });
    child.once('error', () => finish(false));
    child.once('exit', () => finish(false));
    const outgoing = encodeJsonFrame({ id: 'startup-probe', op: 'health' });
    child.stdin?.on('error', () => { zeroize(outgoing); finish(false); });
    child.stdin?.write(outgoing, () => zeroize(outgoing));
  });
}

async function runFillChild(): Promise<void> {
  if (!process.send || !process.connected) throw new Error('private worker channel required');
  const configuration = await new Promise<{ testOnlyDisableSandbox: boolean }>((resolve, reject) => {
    process.once('message', (message: unknown) => {
      if (!message || typeof message !== 'object' || Object.keys(message).length !== 1 ||
          typeof (message as Record<string, unknown>).testOnlyDisableSandbox !== 'boolean') {
        reject(new Error('invalid private worker configuration')); return;
      }
      resolve(message as { testOnlyDisableSandbox: boolean });
    });
    process.once('disconnect', () => reject(new Error('private worker unavailable')));
  });
  let completed = false;
  const reader = new FrameReader(MAX_REQUEST_BYTES, (body) => {
    void (async () => {
      let password: SecretMaterial | null = null;
      let driver: PlaywrightFillDriver | null = null;
      let id = '';
      try {
        const request = parseRequest(body);
        zeroize(body);
        id = request.id;
        const browserOptions = {
          executablePath: process.env.TM8_VAULT_CHROMIUM_EXECUTABLE,
          timeoutMs: parseTimeout(process.env.TM8_VAULT_FILL_TIMEOUT_MS),
          testOnlyDisableSandbox: configuration.testOnlyDisableSandbox,
        };
        if (request.op === 'health') {
          const ready = await probeIsolatedBrowser(browserOptions);
          const outgoing = encodeJsonFrame({ id, op: 'health', ok: true, ready });
          process.stdout.write(outgoing, () => { zeroize(outgoing); process.stdout.end(); });
          return;
        }
        password = SecretMaterial.adopt(Buffer.from(request.password_b64, 'base64'));
        request.password_b64 = '';
        driver = new PlaywrightFillDriver(browserOptions);
        const outcome = await driver.fill({ intent: request.intent, material: { username: request.username, password, totp: null } });
        const outgoing = encodeOutcome(id, outcome);
        zeroize(outcome.screenshot?.data);
        process.stdout.write(outgoing, () => { zeroize(outgoing); process.stdout.end(); });
      } catch {
        const outgoing = encodeOutcome(id, refusal('browser_unavailable'));
        process.stdout.write(outgoing, () => { zeroize(outgoing); process.stdout.end(); });
      } finally {
        completed = true;
        zeroize(body);
        reader.dispose();
        password?.dispose();
        await driver?.close();
        process.stdin.destroy();
      }
    })();
  });
  process.stdin.on('data', (chunk: Buffer) => { try { reader.push(chunk); } catch { reader.dispose(); process.exitCode = 1; process.stdin.destroy(); } });
  process.stdin.on('error', () => { reader.dispose(); });
  process.stdin.once('end', () => {
    // Includes Chromium descendants when a supervisor is killed without systemd.
    if (!completed) { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exitCode = 1; } }
  });
}

function parseTimeout(value: string | undefined): number {
  const timeout = Number(value ?? DEFAULT_FILL_TIMEOUT_MS);
  return Number.isInteger(timeout) && timeout >= 100 && timeout <= 120_000 ? timeout : DEFAULT_FILL_TIMEOUT_MS;
}

async function main(): Promise<void> {
  process.umask(0o077); // Private browser directories keep their required search bits.
  if (process.argv[2] === '--fill-child') { await runFillChild(); return; }
  if (process.argv.length > 3) throw new Error('invalid worker arguments');
  const socketPath = process.argv[2] ?? process.env.TM8_VAULT_FILL_SOCKET;
  if (!socketPath || !socketPath.startsWith('/') || socketPath.length > 100) throw new Error('invalid worker socket');
  const worker = await startFillWorker({ socketPath, runtimeDirectory: process.env.TMPDIR,
    executablePath: process.env.TM8_VAULT_CHROMIUM_EXECUTABLE, timeoutMs: parseTimeout(process.env.TM8_VAULT_FILL_TIMEOUT_MS) });
  let stopping = false;
  const shutdown = () => { if (stopping) return; stopping = true; void worker.close().then(() => { process.exitCode = 0; }); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.exitCode = 1; }); // fixed exit status; never print an exception.
}
