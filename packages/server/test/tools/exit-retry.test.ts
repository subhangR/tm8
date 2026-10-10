import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PtyHostService, ToolSessionLauncher, type ToolExit } from '@tm8/execution';

vi.setConfig({ testTimeout: 15000 });
const resources: Array<{ host: PtyHostService; launcher: ToolSessionLauncher; id: string; dir: string }> = [];
afterEach(async () => {
  for (const run of resources.splice(0)) {
    run.host.kill(run.id);
    await run.launcher.close();
    await rm(run.dir, { recursive: true, force: true });
  }
});

async function launch(failures: number, timeoutSeconds = 10, onFailure?: () => void) {
  const dir = await mkdtemp(join(tmpdir(), 'tm8-tool-retry-'));
  const id = randomUUID(), host = new PtyHostService();
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const launcher = new ToolSessionLauncher({ logger, pty: host, dataDir: dir, baseUrl: 'http://127.0.0.1:4610', pollMs: 20,
    env: { PATH: '/usr/bin:/bin', HOME: dir, SHELL: '/bin/bash' } });
  resources.push({ host, launcher, id, dir });
  const recordExit = vi.fn(async (_exit: ToolExit) => {
    if (failures-- > 0) {
      onFailure?.();
      throw new Error('Transient database failure');
    }
  });
  const revokeToken = vi.fn(async () => {});
  const original = host.captureProcessGroupKiller.bind(host);
  const cleanup = vi.fn<() => void>();
  vi.spyOn(host, 'captureProcessGroupKiller').mockImplementation(sessionId => {
    const kill = original(sessionId);
    cleanup.mockImplementation(kill);
    return cleanup;
  });
  await launcher.launch({ sessionId: id, toolId: randomUUID(), toolVersion: 1,
    definition: { name: 'retry-probe', description: '', help: '', runtime: 'bash',
      source: 'printf "%s\\n" "$KEY"; exit 7', inputs: [{ name: 'key', type: 'secret' }],
      tm8Access: 'none', timeoutSeconds },
    inputs: { env: { KEY: 'synthetic-retry-secret' }, values: { key: { secret: 'passed' } },
      secretValues: ['synthetic-retry-secret'], secretEnvKeys: ['KEY'] }, cwd: dir, keepOpen: false,
    recordExit, revokeToken });
  return { host, launcher, id, recordExit, revokeToken, cleanup, logger };
}

it('retries a transient exit write without repeating token revocation, cleanup or redaction', async () => {
  const run = await launch(1);
  await vi.waitFor(() => expect(run.recordExit).toHaveBeenCalledTimes(2), { timeout: 5000 });
  await expect(run.recordExit.mock.results[1]!.value).resolves.toBeUndefined();
  const first = run.recordExit.mock.calls[0]![0], second = run.recordExit.mock.calls[1]![0];
  expect(second).toBe(first);
  expect(second).toMatchObject({ exitCode: 7, state: 'exited' });
  expect(second.outputTail).toContain('[credential-redacted]');
  expect(second.outputTail).not.toContain('synthetic-retry-secret');
  expect(run.revokeToken).toHaveBeenCalledTimes(1);
  expect(run.cleanup).toHaveBeenCalledTimes(1);
  expect(run.host.hasSession(run.id)).toBe(false);
});

it('bounds an unavailable exit write to three attempts and releases its watcher', async () => {
  const run = await launch(Infinity);
  await vi.waitFor(() => expect(run.recordExit).toHaveBeenCalledTimes(3), { timeout: 5000 });
  // close/checkExit cannot restart a settled run after the retry budget is exhausted.
  await new Promise(resolve => setTimeout(resolve, 400));
  await run.launcher.checkExit(run.id);
  expect(run.recordExit).toHaveBeenCalledTimes(3);
  expect(run.logger.error).toHaveBeenCalledTimes(1);
  expect(run.revokeToken).toHaveBeenCalledTimes(1);
  expect(run.cleanup).toHaveBeenCalledTimes(1);
});

it('stops persistence retries at the run deadline', async () => {
  let now = 1_000_000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const run = await launch(1, 1, () => { now = 1_002_000; });
  await vi.waitFor(() => expect(run.logger.error).toHaveBeenCalledTimes(1), { timeout: 5000 });
  clock.mockRestore();
  expect(run.recordExit).toHaveBeenCalledTimes(1);
  expect(run.logger.error).toHaveBeenCalledTimes(1);
  expect(run.revokeToken).toHaveBeenCalledTimes(1);
  expect(run.cleanup).toHaveBeenCalledTimes(1);
});
