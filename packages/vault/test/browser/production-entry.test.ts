import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { SecretMaterial, zeroize } from '../../src/secret-material.js';
import { RemoteFillDriver } from '../../src/browser/remote-driver.js';
import { FrameReader, MAX_RESPONSE_BYTES, encodeJsonFrame } from '../../src/browser/protocol.js';
import { until } from './fixtures.js';

const entry = fileURLToPath(new URL('../../dist/browser/worker-main.js', import.meta.url));

describe('production entry forbids unsafe browser modes (fake executable, no browser)', () => {
  it('ignores test env switches, uses sandbox flags and keeps failed probes unready', async () => {
    const directory = await mkdtemp('/dev/shm/vault-production-entry-');
    const socketPath = join(directory, 'fill.sock');
    const executablePath = join(directory, 'fake-browser.mjs');
    // No material reaches this fixture. It records only Chromium launch flags.
    await writeFile(executablePath, '#!/usr/bin/env node\nimport {writeFileSync} from "node:fs";\nwriteFileSync(new URL("./flags.json", import.meta.url),JSON.stringify(process.argv.slice(2)));\nprocess.exitCode=1;\n', { mode: 0o700 });
    const child = spawn(process.execPath, [entry, socketPath], {
      stdio: 'ignore', env: { ...process.env, TMPDIR: directory, TM8_VAULT_CHROMIUM_EXECUTABLE: executablePath,
        TM8_VAULT_FILL_TEST_NO_SANDBOX: '1', TM8_VAULT_FILL_TEST_SINGLE_PROCESS: '1', DEBUG: '', PWDEBUG: '0', NODE_OPTIONS: '' },
    });
    const driver = new RemoteFillDriver(socketPath);
    const password = SecretMaterial.fromUtf8(['test', 'fixture'].join('-'));
    try {
      await until(async () => { try { return (await stat(socketPath)).isSocket(); } catch { return false; } });
      const flags: string[] = JSON.parse(await readFile(join(directory, 'flags.json'), 'utf8'));
      expect(flags.includes('--no-sandbox')).toBe(false);
      expect(flags.includes('--single-process')).toBe(false);
      expect(flags.includes('--no-zygote')).toBe(false);
      expect(flags.includes('--headless')).toBe(true);
      expect(await healthReady(socketPath)).toBe(false);
      const outcome = await driver.fill({ intent: { operationId: 'test-op', itemId: 'test-item', origin: 'https://github.com', submit: false, devMode: false },
        material: { username: null, password, totp: null } });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('browser_unavailable');
      zeroize(outcome.screenshot?.data);
      expect(password.disposed).toBe(false);
    } finally { password.dispose(); await driver.close(); child.kill('SIGTERM'); await exited(child); await rm(directory, { recursive: true, force: true }); }
  });

  it.each([['--no-sandbox'], ['--single-process'], ['--fill-child']])('refuses CLI mode %s without a private parent channel', async (argument) => {
    const child = spawn(process.execPath, [entry, argument], { stdio: 'ignore', env: { ...process.env, TM8_VAULT_FILL_TEST_NO_SANDBOX: '1' } });
    await exited(child);
    expect(child.exitCode).toBe(1);
  });

  it('refuses flags appended to a socket path', async () => {
    const directory = await mkdtemp('/dev/shm/vault-production-flags-');
    const child = spawn(process.execPath, [entry, join(directory, 'fill.sock'), '--single-process'], { stdio: 'ignore' });
    try { await exited(child); expect(child.exitCode).toBe(1); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
});

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

async function healthReady(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const outgoing = encodeJsonFrame({ id: 'production-probe', op: 'health' });
    const reader = new FrameReader(MAX_RESPONSE_BYTES, (body) => {
      try { const result = JSON.parse(body.toString('utf8')); resolve(result.id === 'production-probe' && result.op === 'health' && result.ready === true); }
      catch { resolve(false); }
      finally { zeroize(body); socket.destroy(); }
    });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 2_000);
    socket.on('connect', () => socket.write(outgoing, () => zeroize(outgoing)));
    socket.on('data', (chunk) => { try { reader.push(chunk); } catch { socket.destroy(); resolve(false); } });
    socket.on('error', () => resolve(false));
    socket.on('close', () => { clearTimeout(timer); zeroize(outgoing); reader.dispose(); });
  });
}
