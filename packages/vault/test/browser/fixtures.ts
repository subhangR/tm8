import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

export const E2E_REASON = 'requires TM8_VAULT_BROWSER_E2E=1 (local Chromium, /proc and SIGKILL harness)';
export const e2eEnabled = process.env.TM8_VAULT_BROWSER_E2E === '1';

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
