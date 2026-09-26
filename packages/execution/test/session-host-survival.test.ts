// Sessions survive a server restart (task 01a0db31, design doc 01a0db5e §4).
//
// Real processes throughout: a real session host (the compiled dist/, exactly
// what the server spawns), real PTYs, real agents. The "server" is a
// PtyHostService + SessionHostPool pair; a restart is that pair going away —
// gracefully (shutdownAll + detachAll) or by SIGKILL of a separate process —
// and a fresh pair adopting what the host kept.
//
// NC1 and NC2 are the negative controls:
//   NC1 — the legacy in-process holder (no session host), SIGKILLed with ONE PTY
//         session and NO chat child, takes its agent down within 2s. With a chat
//         child alive the agent outlives the server by 4-8s on the chat child's
//         leaked copy of the master (measured, doc §5), so the bound would
//         measure the leak instead.
//   NC2 — TM8_NC2=1 (read HERE, by the test, never by library code) opens every
//         server with the pool's `noAdoptForTest`, so the next server sends the
//         host `hangup` instead of reattaching. Every survival assertion below
//         goes red (the closeout carries that output).
//
// Needs `tsc -b` first: the host runs from dist/session-host.

import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { PtyHostService } from '../src/pty/PtyHostService.js';
import type { PtyExitInfo, PtySessionStatus } from '../src/pty/types.js';
import { SessionHostPool } from '../src/session-host/client.js';
import { RemoteChild } from '../src/session-host/remote.js';
import { pipeChildLeaks, running, strictLeaks, wait, waitFor } from './fixtures/session-host/helpers.js';
// Plain .mjs so the fixture server (run by node, not vitest) can share it.
import { fileRegistry } from './fixtures/session-host/registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_DIR = join(HERE, '../dist/session-host');
const FIXTURE_SERVER = join(HERE, 'fixtures/session-host/server.mjs');

const quiet = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
const NC2 = process.env['TM8_NC2'] === '1';

function agentEnv(home: string): Record<string, string> {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, SHELL: '/bin/bash', TERM: 'xterm-256color' };
}

function replayText(pty: PtyHostService, sid: string): string {
  return pty.getReplay(sid, 0)?.data.toString('utf8') ?? '';
}

async function pidFrom(pty: PtyHostService, sid: string, tag: string): Promise<number> {
  let pid = 0;
  await waitFor(
    () => {
      const m = new RegExp(`${tag}-(\\d+)`).exec(replayText(pty, sid));
      if (m) pid = Number(m[1]);
      return pid > 0;
    },
    20_000,
    `${sid} to print ${tag}`,
  );
  return pid;
}

interface Recorded {
  status: PtySessionStatus;
  info: PtyExitInfo;
}

const cleanupPids = new Set<number>();
const cleanupDirs: string[] = [];

afterAll(() => {
  for (const pid of cleanupPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
  if (!existsSync(join(HOST_DIR, 'bin.js'))) {
    throw new Error(`session host is not built (${HOST_DIR}/bin.js missing): run \`npx tsc -b\` in packages/execution first`);
  }
});

function scratch(): { dataDir: string; registryFile: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'tm8-session-host-'));
  cleanupDirs.push(dataDir);
  return { dataDir, registryFile: join(dataDir, 'registry.json') };
}

async function openServer(
  dataDir: string,
  registryFile: string,
  bootId: string,
  onStatus: (sid: string, status: PtySessionStatus, info: PtyExitInfo) => void | Promise<void>,
  statusRetryDelaysMs?: number[],
): Promise<{ pool: SessionHostPool; pty: PtyHostService; fallbacks: string[] }> {
  const pool = await SessionHostPool.open({
    dataDir,
    registry: fileRegistry(registryFile),
    serverBootId: bootId,
    hostDir: HOST_DIR,
    logger: quiet,
    hostIdleExitMs: 1_000,
    ...(NC2 ? { noAdoptForTest: true } : {}),
  });
  if (pool.active) cleanupPids.add(pool.active.hello.hostPid);
  // H7 condition 3: survival must never "pass" through the in-process fallback.
  const fallbacks: string[] = [];
  const pty = new PtyHostService({
    logger: quiet,
    sessionHost: () => pool.hostForSpawn(),
    onInProcessFallback: (sid) => fallbacks.push(sid),
    onSessionStatus: onStatus,
    ...(statusRetryDelaysMs ? { statusRetryDelaysMs } : {}),
  });
  return { pool, pty, fallbacks };
}

function adoptAll(pool: SessionHostPool, pty: PtyHostService, except: string[] = []): string[] {
  const adopted: string[] = [];
  for (const { conn, record } of pool.sessions()) {
    if (except.includes(record.sid)) continue;
    if (pty.adopt(conn, record)) adopted.push(record.sid);
  }
  return adopted.sort();
}

describe('sessions survive a server restart through the session host', () => {
  it('a graceful restart detaches; the next server reattaches I/O, scrollback, epoch, and records gap exits', async () => {
    const { dataDir, registryFile } = scratch();
    const trigger = join(dataDir, 'exit-now');

    // ---- server A
    const seenA = new Map<string, Recorded>();
    const a = await openServer(dataDir, registryFile, 'boot-A', (sid, status, info) => void seenA.set(sid, { status, info }));
    expect(a.pool.active, 'server A started a session host').not.toBeNull();
    const hostPid = a.pool.active!.hello.hostPid;

    a.pty.spawn({
      sessionId: 'gap-exit',
      command: `echo "UP-$$"; while [ ! -e ${trigger} ]; do sleep 0.05; done; exit 7`,
      cwd: dataDir,
      env: agentEnv(dataDir),
    });
    a.pty.spawn({
      sessionId: 'gap-signal',
      command: 'echo "UP-$$"; while :; do sleep 0.05; done',
      cwd: dataDir,
      env: agentEnv(dataDir),
    });
    // Spawned LAST, so every earlier master and the host's socket were open in
    // the host when it forked: the fd hygiene check below sees the worst case.
    a.pty.spawn({
      sessionId: 'survivor',
      command: 'echo "READY-$$"; while IFS= read -r l; do echo "got:$l pid=$$"; done',
      cwd: dataDir,
      env: agentEnv(dataDir),
    });
    const exitPid = await pidFrom(a.pty, 'gap-exit', 'UP');
    const signalPid = await pidFrom(a.pty, 'gap-signal', 'UP');
    const survivorPid = await pidFrom(a.pty, 'survivor', 'READY');
    for (const pid of [exitPid, signalPid, survivorPid]) cleanupPids.add(pid);
    const epoch = a.pty.getEpoch('survivor');
    expect(epoch).toBeTruthy();
    for (const sid of ['gap-exit', 'gap-signal', 'survivor']) {
      expect(a.pty.isHostBacked(sid), `${sid} runs in the session host`).toBe(true);
    }

    // R8 fd hygiene: above stdio, the PTY agent holds no PTY master and no
    // socket (doc §5: pipe: alone would miss the chat child's socketpairs).
    expect(strictLeaks(survivorPid), 'PTY agent inherited a PTY master or socket').toEqual([]);

    // H12: a PIPE child (a chat runtime's shape), spawned after every master
    // above was open in the host. Its stdio is socketpairs, so the doc §5 v6
    // form: its own fd 0/1/2 inodes are dropped first. The negative twin (no
    // exec-clean) is in session-host-review.test.ts.
    const pipe = RemoteChild.spawn(a.pool.active!, {
      sid: 'pipe-1',
      epoch: 'pipe-epoch-1',
      file: 'sh',
      args: ['-c', 'echo "UP-$$"; cat'],
      cwd: dataDir,
      env: agentEnv(dataDir),
    });
    let pipeOut = '';
    pipe.stdout.on('data', (d: Buffer) => (pipeOut += d.toString()));
    await waitFor(() => /UP-\d+/.test(pipeOut), 20_000, 'pipe child to start');
    const pipePid = Number(/UP-(\d+)/.exec(pipeOut)![1]);
    cleanupPids.add(pipePid);
    expect(pipePid, 'pipe child runs through the host (its pid came from spawned)').toBe(pipe.pid);
    expect(pipeChildLeaks(pipePid), 'pipe child inherited a PTY master or a foreign socket').toEqual([]);
    const pipeClosed = new Promise((r) => pipe.once('close', r));
    pipe.kill('SIGKILL');
    await pipeClosed;
    pipe.release();

    // ---- graceful stop of A
    a.pty.shutdownAll();
    a.pool.detachAll();
    await wait(300);
    expect(seenA.size, 'server A wrote no exit status for a detached session').toBe(0);
    expect(running(survivorPid), 'agent alive after its server stopped').toBe(true);
    expect(running(hostPid), 'session host alive after its server stopped').toBe(true);

    // ---- the gap: one agent exits with a code, one dies of a signal
    writeFileSync(trigger, '');
    process.kill(signalPid, 'SIGTERM');
    await waitFor(() => !running(exitPid) && !running(signalPid), 20_000, 'gap exits');

    // ---- server B: its first status write for gap-exit fails, so the host
    // must keep that exit record until a write commits.
    const seenB = new Map<string, Recorded>();
    let failGapExitOnce = true;
    const b = await openServer(
      dataDir,
      registryFile,
      'boot-B',
      async (sid, status, info) => {
        if (sid === 'gap-exit' && failGapExitOnce) {
          failGapExitOnce = false;
          throw new Error('simulated status write failure');
        }
        seenB.set(sid, { status, info });
      },
      [60_000], // not re-tried within this test: server C must see the record
    );
    expect(adoptAll(b.pool, b.pty), 'server B adopted every session the host kept').toEqual([
      'gap-exit',
      'gap-signal',
      'survivor',
    ]);
    expect(running(survivorPid), 'the same agent process, still running').toBe(true);
    expect(b.pool.active?.hello.hostPid, 'server B reattached to the same host').toBe(hostPid);

    // status/liveness + stream identity
    expect(b.pty.hasSession('survivor')).toBe(true);
    expect(b.pty.getEpoch('survivor'), 'epoch unchanged across the restart').toBe(epoch);
    // scrollback reattached into the new server's ring
    await waitFor(() => replayText(b.pty, 'survivor').includes(`READY-${survivorPid}`), 10_000, 'scrollback replay');
    // input reaches the same process, and its output reaches the new server
    // A12: the agent prints its own pid AFTER the restart — identity, not inference.
    b.pty.write('survivor', 'after-restart\r');
    await waitFor(
      () => replayText(b.pty, 'survivor').includes(`got:after-restart pid=${survivorPid}`),
      10_000,
      'post-restart echo from the same pid',
    );

    // gap exits land on the row with their evidence (doc §5: non-null code/signal)
    await waitFor(() => seenB.has('gap-signal'), 10_000, 'gap-signal status');
    expect(seenB.get('gap-signal')).toEqual({ status: 'failed', info: { exitCode: expect.any(Number), signal: 15 } });
    await wait(200);
    expect(seenB.has('gap-exit'), 'the failed write is not recorded as done').toBe(false);

    // negative twin: a NEW sid after the restart gets a different epoch
    b.pty.spawn({ sessionId: 'fresh', command: 'echo "FRESH-$$"; sleep 30', cwd: dataDir, env: agentEnv(dataDir) });
    const freshPid = await pidFrom(b.pty, 'fresh', 'FRESH');
    cleanupPids.add(freshPid);
    expect(b.pty.isHostBacked('fresh'), 'fresh runs in the session host').toBe(true);
    expect(b.pty.getEpoch('fresh')).toBeTruthy();
    expect(b.pty.getEpoch('fresh')).not.toBe(epoch);
    // For H8 below: a sid server C will NOT adopt, and will spawn afresh.
    b.pty.spawn({ sessionId: 'reuse', command: 'echo "OLD-$$"; while :; do sleep 0.05; done', cwd: dataDir, env: agentEnv(dataDir) });
    const oldReusePid = await pidFrom(b.pty, 'reuse', 'OLD');
    cleanupPids.add(oldReusePid);

    // ---- server C: the released record is gone, the unreleased one is back
    b.pty.shutdownAll();
    b.pool.detachAll();
    await wait(300);
    const seenC = new Map<string, Recorded>();
    const c = await openServer(dataDir, registryFile, 'boot-C', (sid, status, info) => void seenC.set(sid, { status, info }));
    expect(c.pool.active?.hello.hostPid).toBe(hostPid);
    // H5: `fresh` and `reuse` exit AFTER C's hello_ok and BEFORE adoption, so
    // their exits arrive for sids nothing is bound to yet.
    process.kill(freshPid, 'SIGTERM');
    process.kill(oldReusePid, 'SIGTERM');
    await waitFor(() => !running(freshPid) && !running(oldReusePid), 10_000, 'exits between hello and adopt');
    await wait(300); // the exit frames reach C unbound
    expect(adoptAll(c.pool, c.pty, ['reuse'])).toEqual(['fresh', 'gap-exit', 'survivor']);
    await waitFor(() => seenC.has('gap-exit'), 10_000, 'gap-exit status re-reported');
    expect(seenC.get('gap-exit')).toEqual({ status: 'failed', info: { exitCode: 7, signal: null } });
    await waitFor(() => seenC.has('fresh'), 10_000, 'H5: an exit between hello and adopt lands its status');
    expect(seenC.get('fresh')).toEqual({ status: 'failed', info: { exitCode: expect.any(Number), signal: 15 } });
    expect(c.pty.getEpoch('survivor')).toBe(epoch);

    // H8: `reuse` is spawned afresh while C holds its predecessor's unbound
    // exit. That exit belongs to the old process and must not end the new one.
    c.pty.spawn({ sessionId: 'reuse', command: 'echo "NEW-$$"; while :; do sleep 0.05; done', cwd: dataDir, env: agentEnv(dataDir) });
    const newReusePid = await pidFrom(c.pty, 'reuse', 'NEW');
    cleanupPids.add(newReusePid);
    await wait(500);
    expect(c.pty.hasSession('reuse'), 'H8: the fresh spawn is still live').toBe(true);
    expect(seenC.has('reuse'), 'H8: no exit was recorded for the fresh spawn').toBe(false);
    expect(running(newReusePid)).toBe(true);
    expect([...a.fallbacks, ...b.fallbacks, ...c.fallbacks], 'no spawn fell back in-process').toEqual([]);

    // ---- teardown: stop the agents through the server, the host idles out
    c.pty.kill('survivor');
    c.pty.kill('reuse');
    await waitFor(() => !running(survivorPid) && !running(newReusePid), 10_000, 'agents to stop');
    // Each exit frame comes back and is answered with a forget; let those land
    // before the controller goes, or the host rightly keeps the records.
    await wait(1_500);
    c.pool.detachAll();
    await waitFor(() => !running(hostPid), 15_000, 'host to idle out');
  }, 120_000);

  let fixture: ChildProcess | null = null;
  afterEach(() => {
    if (fixture?.pid && fixture.exitCode === null) fixture.kill('SIGKILL');
    fixture = null;
  });

  async function startFixtureServer(mode: 'host' | 'legacy', dataDir: string, registryFile: string) {
    const child = spawnProcess(process.execPath, ['--no-warnings', FIXTURE_SERVER, mode, dataDir, registryFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    fixture = child;
    let out = '';
    let err = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    await waitFor(() => out.includes('\n') || child.exitCode !== null, 30_000, 'fixture server to report its agent');
    if (!out.includes('\n')) throw new Error(`fixture server exited: ${err}`);
    const reported = JSON.parse(out.split('\n')[0]!) as { pid: number; epoch: string };
    cleanupPids.add(reported.pid);
    return { child, ...reported };
  }

  it('a server SIGKILL leaves the agent running; the next server reattaches it', async () => {
    const { dataDir, registryFile } = scratch();
    const { child, pid, epoch } = await startFixtureServer('host', dataDir, registryFile);
    const [row] = await fileRegistry(registryFile).list();
    expect(row?.pid, 'the fixture registered its host').toBeTruthy();
    cleanupPids.add(row.pid);

    child.kill('SIGKILL');
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 10_000, 'fixture server to die');
    await wait(2_000); // NC1's bound: the legacy agent is dead by now
    expect(running(pid), 'agent alive 2s after its server was SIGKILLed').toBe(true);

    const seen = new Map<string, Recorded>();
    const b = await openServer(dataDir, registryFile, 'boot-after-crash', (sid, status, info) => void seen.set(sid, { status, info }));
    expect(adoptAll(b.pool, b.pty), 'the next server adopted the agent').toEqual(['crash-1']);
    expect(running(pid), 'the same agent process, still running').toBe(true);
    expect(b.pool.active?.hello.hostPid).toBe(row.pid);
    expect(b.pty.getEpoch('crash-1')).toBe(epoch);
    await waitFor(() => replayText(b.pty, 'crash-1').includes(`READY-${pid}`), 10_000, 'scrollback replay');
    b.pty.write('crash-1', 'still-here\r');
    await waitFor(() => replayText(b.pty, 'crash-1').includes(`got:still-here pid=${pid}`), 10_000, 'post-crash echo from the same pid');
    expect(seen.size).toBe(0);

    b.pty.kill('crash-1');
    await waitFor(() => !running(pid), 10_000, 'agent to stop');
    b.pool.detachAll();
  }, 90_000);

  it('NC1 (one PTY session, no chat child): a SIGKILLed legacy in-process holder takes its agent down within 2s', async () => {
    const { dataDir, registryFile } = scratch();
    const { child, pid } = await startFixtureServer('legacy', dataDir, registryFile);
    expect(running(pid)).toBe(true);
    child.kill('SIGKILL');
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 10_000, 'fixture server to die');
    const killedAt = Date.now();
    await waitFor(() => !running(pid) || Date.now() - killedAt > 2_000, 3_000);
    expect(running(pid), 'legacy agent still alive 2s after its server died').toBe(false);
  }, 60_000);
});
