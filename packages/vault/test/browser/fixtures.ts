import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { FrameReader, MAX_RESPONSE_BYTES, encodeJsonFrame } from '../../src/browser/protocol.js';
import { zeroize } from '../../src/secret-material.js';

export const E2E_REASON = 'requires TM8_VAULT_BROWSER_E2E=1 (local Chromium, /proc and SIGKILL harness)';
export const e2eEnabled = process.env.TM8_VAULT_BROWSER_E2E === '1';
// Review F06: on a GitHub runner these suites are a release gate. A run that would skip them
// fails to load instead, so a CI job that drops the switch or its Chromium cannot go green.
if (!e2eEnabled && process.env.GITHUB_ACTIONS === 'true') {
  throw new Error(`vault browser suites cannot be skipped on a CI runner: ${E2E_REASON}`);
}

export async function localServer(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server unavailable');
  return { origin: `http://localhost:${address.port}`, port: address.port,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

export function loginPage(action = '/session', extra = '', script = ''): string {
  return `<!doctype html><html><head><style>body{margin:0}input{display:block;width:240px;height:30px;margin:10px}</style></head><body>
    <form action="${action}" method="post"><input name="username" autocomplete="username" id="username">
    <input name="password" type="password" id="password"><button type="submit">Log in</button>${extra}</form>
    <p id="mirror"></p><script>${script}</script></body></html>`;
}

export async function until(check: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('test condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** `until` as a boolean, so that a failed assertion names the condition that never held. */
export async function settles(check: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<boolean> {
  try { await until(check, timeoutMs); return true; } catch { return false; }
}

export async function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

/** The fill worker in a process of its own (worker-host.mjs), once it serves. Its output is kept for canary scans. */
export async function startWorkerHost(socketPath: string, runtimeDirectory: string, timeoutMs: number) {
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  const child = spawn(process.execPath, [fileURLToPath(new URL('./worker-host.mjs', import.meta.url)), socketPath, runtimeDirectory, String(timeoutMs)],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: runtimeDirectory, DEBUG: '', PWDEBUG: '0', NODE_OPTIONS: '' } });
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
  let exited = false; child.once('exit', () => { exited = true; });
  try { await until(async () => { if (exited) throw new Error('test worker exited before ready'); return output.some((x) => x.includes('worker-ready')); }); }
  catch { child.kill('SIGKILL'); await waitExit(child); throw new Error('test worker unavailable'); }
  return { child, output, errors,
    /** SIGTERM the worker, SIGKILL anything it still parents, and zeroize its output. */
    async stop() {
      // An exited worker's pid may already name another process: never walk its tree.
      const pids = child.pid && !exited ? await descendants(child.pid) : [];
      if (!exited) child.kill('SIGTERM');
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } }
      if (!exited) await waitExit(child);
      for (const buffer of [...output, ...errors]) zeroize(buffer);
    } };
}

/** One health round trip on a fill worker's socket. */
export async function workerHealth(path: string): Promise<Record<string, unknown>> {
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

export async function descendants(root: number): Promise<number[]> {
  const parents = new Map<number, number>();
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      parents.set(Number(entry), Number(fields[1]));
    } catch { /* raced with exit */ }
  }
  const result: number[] = [];
  const queue = [root];
  for (let index = 0; index < queue.length; index += 1) {
    for (const [pid, ppid] of parents) if (ppid === queue[index]) { result.push(pid); queue.push(pid); }
  }
  return result;
}

/** One process, pinned by its start time so that a recycled pid never stands in for it. */
export interface PinnedProcess { pid: number; parent: number; start: string }

async function processStat(pid: number): Promise<{ state: string; parent: number; start: string } | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0]!, parent: Number(fields[1]), start: fields[19]! };
  } catch { return null; }
}

/** Pins each pid that is still running. One that has already exited is left out. */
export async function pin(pids: number[]): Promise<PinnedProcess[]> {
  const pinned: PinnedProcess[] = [];
  for (const pid of pids) {
    const stat = await processStat(pid);
    if (stat && stat.state !== 'Z') pinned.push({ pid, parent: stat.parent, start: stat.start });
  }
  return pinned;
}

/** True once every pinned process has exited: gone, a zombie, or its pid reused. */
export async function ended(processes: PinnedProcess[]): Promise<boolean> {
  for (const entry of processes) {
    const stat = await processStat(entry.pid);
    if (stat && stat.start === entry.start && stat.state !== 'Z') return false;
  }
  return true;
}

/** Test cleanup only: SIGKILL each pinned process that is still the same process. */
export async function reap(processes: PinnedProcess[]): Promise<void> {
  for (const entry of processes) {
    const stat = await processStat(entry.pid);
    if (stat && stat.start === entry.start && stat.state !== 'Z') { try { process.kill(entry.pid, 'SIGKILL'); } catch { /* exited */ } }
  }
}

/** Every regular file under `directory`, read whole: runtime, profile, crash and core files alike. */
export async function gatherFiles(directory: string, result: Buffer[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await gatherFiles(path, result);
    else if (entry.isFile()) {
      try { result.push(await readFile(path)); } catch { throw new Error('test artifact scan failed'); }
    }
  }
}

export async function inspectBrowserProcesses(pids: number[]) {
  const commandLines: string[][] = [];
  const ownedSockets = new Set<string>();
  const listeningSockets = new Set<string>();
  for (const pid of pids) {
    try {
      const command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
      if (!command.some((part) => /chrome|chromium|headless_shell/.test(part))) continue;
      commandLines.push(command);
      for (const fd of await readdir(`/proc/${pid}/fd`)) {
        try { const link = await readlink(`/proc/${pid}/fd/${fd}`); const match = /^socket:\[(\d+)\]$/.exec(link); if (match?.[1]) ownedSockets.add(match[1]); } catch { /* closed */ }
      }
      for (const table of ['tcp', 'tcp6']) {
        const rows = (await readFile(`/proc/${pid}/net/${table}`, 'utf8')).trim().split('\n').slice(1);
        for (const row of rows) { const fields = row.trim().split(/\s+/); if (fields[3] === '0A' && fields[9]) listeningSockets.add(fields[9]); }
      }
    } catch { /* process exited */ }
  }
  return { commandLines, listeningOwned: [...ownedSockets].filter((inode) => listeningSockets.has(inode)) };
}

/** Decode a PNG pixel to prove masks cover the rendered controls, not just a count. */
export function pngPixel(data: Buffer, x: number, y: number): number[] {
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const depth = data[24];
  const color = data[25];
  if (depth !== 8 || (color !== 2 && color !== 6)) throw new Error('unexpected test PNG');
  const channels = color === 6 ? 4 : 3;
  const compressed: Buffer[] = [];
  for (let offset = 8; offset + 12 <= data.length;) {
    const size = data.readUInt32BE(offset);
    if (data.toString('ascii', offset + 4, offset + 8) === 'IDAT') compressed.push(data.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const raw = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  let previous = Buffer.alloc(stride);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)]!;
    const current = Buffer.alloc(stride);
    for (let index = 0; index < stride; index += 1) {
      const left = current[index - channels] ?? 0, up = previous[index] ?? 0, upperLeft = previous[index - channels] ?? 0;
      const p = left + up - upperLeft, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upperLeft);
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : a <= b && a <= c ? left : b <= c ? up : upperLeft;
      current[index] = (raw[row * (stride + 1) + 1 + index]! + predictor) & 255;
    }
    if (row === y) return [...current.subarray(x * channels, x * channels + 3)];
    previous = current;
  }
  throw new Error('test PNG pixel unavailable');
}
