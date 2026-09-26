// A stand-in tm8 server for the restart-survival tests: it owns ONE PTY session
// (no chat child — NC1 must not measure the chat child's leaked master), prints
// the agent's pid and epoch as one JSON line, and then idles until the test
// SIGKILLs it. argv: <host|legacy> <dataDir> <registryFile>
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PtyHostService } from '../../../dist/pty/PtyHostService.js';
import { SessionHostPool } from '../../../dist/session-host/client.js';
import { fileRegistry } from './registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const [mode, dataDir, registryFile] = process.argv.slice(2);
const quiet = { info() {}, warn() {}, debug() {}, error: (m, e) => process.stderr.write(`${m} ${e?.message ?? ''}\n`) };

let pool = null;
if (mode === 'host') {
  pool = await SessionHostPool.open({
    dataDir,
    registry: fileRegistry(registryFile),
    serverBootId: `fixture-${process.pid}`,
    hostDir: join(HERE, '../../../dist/session-host'),
    logger: quiet,
  });
  if (!pool.active) throw new Error('no active session host');
}
// Legacy mode is host mode OFF (no sessionHost at all), not host mode with no host.
const pty = new PtyHostService({ logger: quiet, ...(pool ? { sessionHost: () => pool.hostForSpawn() } : {}) });
const sessionId = 'crash-1';
pty.spawn({
  sessionId,
  command: 'echo "READY-$$"; while IFS= read -r l; do echo "got:$l pid=$$"; done',
  cwd: dataDir,
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dataDir, SHELL: '/bin/bash', TERM: 'xterm-256color' },
});
const started = Date.now();
for (;;) {
  const text = pty.getReplay(sessionId, 0)?.data.toString('utf8') ?? '';
  const m = /READY-(\d+)/.exec(text);
  if (m) {
    process.stdout.write(`${JSON.stringify({ pid: Number(m[1]), epoch: pty.getEpoch(sessionId) })}\n`);
    break;
  }
  if (Date.now() - started > 30_000) throw new Error('agent never printed READY');
  await new Promise((r) => setTimeout(r, 25));
}
setInterval(() => {}, 1 << 30);
