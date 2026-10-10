/** Real Server + production PTY + built CLI coverage for attached tool outcomes. */
import { spawn } from 'node:child_process';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { ToolRun, ToolView } from '@tm8/contract';
import { assertBuilt, cli, REPO_ROOT, startRealServer, type RealServer } from './harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let server: RealServer;
let stub: HttpServer;
let stubUrl = '';
let spaceId = '';
let fixtureDir = '';
let tool: ToolView;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, server.baseUrl), init);
  const body = await response.json() as { data?: T; error?: { message: string } };
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${body.error?.message ?? 'unknown error'}`);
  return body.data as T;
}

function runWithOpenPipedStdin(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const entry = join(REPO_ROOT, 'packages/cli/dist/index.js');
  const child = spawn(process.execPath, [entry, '--space', spaceId, ...argv], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: process.env['HOME'] ?? '/tmp',
      ...server.env,
      TM8_SPACE_ID: spaceId,
      TM8_CREDENTIALS_MODE: 'off',
      TM8_JOURNAL_CLASS: 'harness',
      TM8_NO_CACHE: '1',
    },
    // Leave the pipe open for the command's whole lifetime. It must not keep
    // the CLI alive after the PTY records its outcome.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', killed = false;
  const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, 8_000);
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (killed) reject(new Error(`attached CLI hung with stdin pipe open; output so far: ${stdout}\n${stderr}`));
      else resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function runId(stdout: string, stderr = ''): string {
  const id = stdout.match(/^[0-9a-f-]{36}$/m)?.[0];
  if (!id) throw new Error(`attached tool run did not print its session id first (stderr: ${stderr}): ${stdout}`);
  return id;
}

async function settled(id: string): Promise<ToolRun> {
  let run!: ToolRun;
  await vi.waitFor(async () => {
    run = await call<ToolRun>(`/v2/tool-runs/${id}`);
    expect(run.state).not.toBe('running');
  }, { timeout: 15_000, interval: 50 });
  return run;
}

beforeAll(async () => {
  await assertBuilt();
  server = await startRealServer('tool-run-exit');
  stub = createServer((req, res) => {
    if (req.url === '/fail') { res.writeHead(503); res.end('unavailable'); return; }
    res.end('ok');
  });
  await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', resolve));
  const address = stub.address();
  if (!address || typeof address === 'string') throw new Error('URL stub did not bind');
  stubUrl = `http://127.0.0.1:${address.port}`;
  const createdSpace = await call<{ space: { id: string } }>('/v2/spaces', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Attached tool exit regression', clientMutationId: randomUUID() }),
  });
  spaceId = createdSpace.space.id;
  fixtureDir = await mkdtemp(join(tmpdir(), 'tm8-tool-attached-'));
  const source = join(fixtureDir, 'url-check.py'), spec = join(fixtureDir, 'spec.json');
  await writeFile(source, [
    'import os, sys, urllib.error, urllib.request',
    'url = os.environ["URLS"].split()[0]',
    'try:',
    '    with urllib.request.urlopen(url, timeout=5) as response: status = response.status',
    'except urllib.error.HTTPError as error:',
    '    status = error.code',
    'print(("OK" if 200 <= status < 400 else "FAIL") + f" {status} {url}", flush=True)',
    'sys.exit(0 if status < 400 else 1)',
    '',
  ].join('\n'));
  await writeFile(spec, JSON.stringify({
    help: 'Check an HTTP URL and return nonzero for a failed response.',
    tm8Access: 'none', timeoutSeconds: 15,
    inputs: [{ name: 'urls', type: 'string', required: true }],
  }));
  const created = await cli([
    '--space', spaceId, '--format', 'json', 'tool', 'create', 'url-check', '--runtime', 'python',
    '--source', `@${source}`, '--spec', `@${spec}`, '--when-to-use', 'Open when checking an HTTP URL',
    '--summary', 'Exit-code regression fixture',
  ], server);
  expect(created.code, created.stderr).toBe(0);
  tool = JSON.parse(created.stdout) as ToolView;
}, 180_000);

afterAll(async () => {
  await server?.assertBindCoherent();
  await server?.stop();
  if (stub?.listening) await new Promise<void>(resolve => stub.close(() => resolve()));
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

it('propagates the real PTY exit status, waits for persisted status, and exits with piped stdin open', async () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await runWithOpenPipedStdin([
      'tool', 'run', 'url-check', '--urls', `${stubUrl}/fail`,
    ]);
    const id = runId(result.stdout, result.stderr);
    expect(result.code, `attempt ${attempt + 1}: ${result.stderr}\n${result.stdout}`).toBe(1);
    expect(result.stdout).toContain(`FAIL 503 ${stubUrl}/fail`);
    const run = await settled(id);
    expect(run.state).toBe('exited');
    expect(run.exitCode).toBe(1);
    expect(run.outputTail).toContain(`FAIL 503 ${stubUrl}/fail`);
    await vi.waitFor(async () => {
      const session = await call<{ state: { status: string; endedKind: string } }>(`/v2/entities/${id}`);
      expect(session.state.status).toBe('exited');
      expect(session.state.endedKind).toBe('exited_clean');
    }, { timeout: 5000, interval: 50 });
    // Terminate the completed work session to keep this 20-run cap regression
    // independent of retained PTY/session lifecycle cleanup in other tests.
    const terminated = await cli(['session', 'terminate', '--yes', '--force', id], server);
    expect(terminated.code, terminated.stderr).toBe(0);
  }
});
