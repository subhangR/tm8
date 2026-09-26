// Session host review items (task 01a0db31, advisor review H1–H12, A7).
// One case per defect, each against a real host from dist/. The survival
// flows themselves (and H5, H8, H12's positive case) live in
// session-host-survival.test.ts.
//
// Needs `tsc -b` first: the host runs from dist/session-host.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SessionHostConnection, SessionHostPool, type SessionHostPoolOptions } from '../src/session-host/client.js';
import { encodeFrame, FrameDecoder, SESSION_HOST_PROTOCOL, type HostFrame, type ServerFrame } from '../src/session-host/frames.js';
import { RemoteChild } from '../src/session-host/remote.js';
import { pipeChildLeaks, running, wait, waitFor } from './fixtures/session-host/helpers.js';
import { fileRegistry } from './fixtures/session-host/registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_DIR = join(HERE, '../dist/session-host');

const quiet = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

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
  const dataDir = mkdtempSync(join(tmpdir(), 'tm8-session-host-review-'));
  cleanupDirs.push(dataDir);
  return { dataDir, registryFile: join(dataDir, 'registry.json') };
}

function agentEnv(home: string): Record<string, string> {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, SHELL: '/bin/bash', TERM: 'xterm-256color' };
}

async function openPool(
  dataDir: string,
  registryFile: string,
  bootId: string,
  extra: Partial<SessionHostPoolOptions> = {},
): Promise<SessionHostPool> {
  const pool = await SessionHostPool.open({
    dataDir,
    registry: fileRegistry(registryFile),
    serverBootId: bootId,
    hostDir: HOST_DIR,
    logger: quiet,
    hostIdleExitMs: 1_000,
    ...extra,
  });
  if (pool.active) cleanupPids.add(pool.active.hello.hostPid);
  return pool;
}

interface Row {
  generation: string;
  socketPath: string;
  token: string;
  pid: number | null;
}
const rows = (registryFile: string): Row[] => JSON.parse(readFileSync(registryFile, 'utf8')) as Row[];

/** A controller speaking the wire protocol by hand, so a test can misbehave (pause, flood, lie). */
function rawClient(socketPath: string): {
  socket: Socket;
  frames: HostFrame[];
  send(frame: ServerFrame, payload?: Buffer): void;
  closed: Promise<void>;
} {
  const socket = connect(socketPath);
  const decoder = new FrameDecoder<HostFrame>();
  const frames: HostFrame[] = [];
  socket.on('data', (chunk: Buffer) => {
    for (const { header } of decoder.push(chunk)) frames.push(header);
  });
  socket.on('error', () => {});
  const closed = new Promise<void>((r) => socket.once('close', () => r()));
  return { socket, frames, send: (frame, payload) => socket.write(encodeFrame(frame, payload)), closed };
}

async function rawController(registryFile: string): Promise<ReturnType<typeof rawClient>> {
  const row = rows(registryFile)[0]!;
  const raw = rawClient(row.socketPath);
  raw.send({ t: 'hello', token: row.token, serverBootId: 'raw', protocol: SESSION_HOST_PROTOCOL, role: 'active' });
  await waitFor(() => raw.frames.some((f) => f.t === 'hello_ok'), 10_000, 'hello_ok');
  return raw;
}

describe('session host review items', () => {
  it('H12 negative twin: without exec-clean a pipe child inherits the PTY master the v6 check catches', async () => {
    const { dataDir, registryFile } = scratch();
    const pool = await openPool(dataDir, registryFile, 'boot-twin', { bypassExecCleanForTest: true });
    const pty = new PtyHostService({ logger: quiet, sessionHost: () => pool.hostForSpawn() });
    // A PTY first, so the host holds a master when the pipe child forks.
    pty.spawn({ sessionId: 'pty-1', command: 'echo "UP-$$"; while :; do sleep 0.05; done', cwd: dataDir, env: agentEnv(dataDir) });
    await waitFor(() => (pty.getReplay('pty-1', 0)?.data.toString() ?? '').includes('UP-'), 20_000, 'pty up');
    const ptyPid = Number(/UP-(\d+)/.exec(pty.getReplay('pty-1', 0)!.data.toString())![1]);
    cleanupPids.add(ptyPid);

    const pipe = RemoteChild.spawn(pool.active!, {
      sid: 'pipe-twin',
      epoch: 'e-twin',
      file: 'sh',
      args: ['-c', 'echo "UP-$$"; cat'],
      cwd: dataDir,
      env: agentEnv(dataDir),
    });
    let out = '';
    pipe.stdout.on('data', (d: Buffer) => (out += d.toString()));
    await waitFor(() => /UP-\d+/.test(out), 20_000, 'pipe child up');
    const pipePid = Number(/UP-(\d+)/.exec(out)![1]);
    cleanupPids.add(pipePid);
    const leaks = pipeChildLeaks(pipePid);
    expect(leaks.some((l) => l.includes('/dev/ptmx')), `v6 check must see the leaked master; saw ${JSON.stringify(leaks)}`).toBe(true);

    pipe.kill('SIGKILL');
    pty.kill('pty-1');
    await waitFor(() => !running(pipePid) && !running(ptyPid), 10_000, 'twin agents to stop');
  });

  it('H1: the host ignores SIGHUP; a hangup frame HUPs its agents and SIGKILLs a HUP-ignorer after 5s. H2: the old host leaves its successor socket alone', async () => {
    const { dataDir, registryFile } = scratch();
    const a = await openPool(dataDir, registryFile, 'boot-A');
    const oldHost = a.active!.hello.hostPid;
    const socketPath = a.active!.socketPath;
    const pty = new PtyHostService({ logger: quiet, sessionHost: () => a.hostForSpawn() });
    pty.spawn({
      sessionId: 'stubborn',
      command: `trap '' HUP; echo "UP-$$"; while :; do sleep 0.05; done`,
      cwd: dataDir,
      env: agentEnv(dataDir),
    });
    await waitFor(() => (pty.getReplay('stubborn', 0)?.data.toString() ?? '').includes('UP-'), 20_000, 'agent up');
    const agentPid = Number(/UP-(\d+)/.exec(pty.getReplay('stubborn', 0)!.data.toString())![1]);
    cleanupPids.add(agentPid);

    // H1: an unauthenticated SIGHUP (a terminal closing, a stray kill) does nothing.
    process.kill(oldHost, 'SIGHUP');
    await wait(500);
    expect(running(oldHost), 'host survives SIGHUP').toBe(true);
    expect(await a.active!.request({ t: 'ping' })).toMatchObject({ t: 'ok' });

    pty.shutdownAll();
    a.detachAll();
    await wait(200);

    // The next server hangs the host up (noAdoptForTest) and starts its own at the same path.
    const hungUpAt = Date.now();
    const b = await openPool(dataDir, registryFile, 'boot-B', { noAdoptForTest: true });
    const newHost = b.active!.hello.hostPid;
    expect(newHost).not.toBe(oldHost);
    expect(b.active!.socketPath).toBe(socketPath);
    const successorInode = statSync(socketPath).ino;

    await wait(2_500);
    expect(running(agentPid), 'a HUP-ignoring agent outlives the SIGHUP').toBe(true);
    await waitFor(() => !running(agentPid), 8_000, 'SIGKILL escalation');
    const killedAfter = Date.now() - hungUpAt;
    expect(killedAfter).toBeGreaterThanOrEqual(4_500);
    await waitFor(() => !running(oldHost), 5_000, 'old host to exit once its sessions are gone');

    // H2: the old host's shutdown did not unlink the path its successor now listens on.
    expect(existsSync(socketPath), 'successor socket still on disk').toBe(true);
    expect(statSync(socketPath).ino).toBe(successorInode);
    b.detachAll();
    const c = await openPool(dataDir, registryFile, 'boot-C');
    expect(c.active!.hello.hostPid, 'the next server reattaches to the successor').toBe(newHost);
    c.detachAll();
  }, 30_000);

  it('H1/R6: a host with no registry row is SIGKILLed and the dead reason names its pid', async () => {
    const { dataDir, registryFile } = scratch();
    const a = await openPool(dataDir, registryFile, 'boot-A');
    const oldHost = a.active!.hello.hostPid;
    a.detachAll();
    writeFileSync(registryFile, '[]');
    const b = await openPool(dataDir, registryFile, 'boot-B');
    await waitFor(() => !running(oldHost), 5_000, 'orphan host killed');
    expect(b.dead.map((d) => d.reason)).toContainEqual(expect.stringContaining(`host pid ${oldHost} SIGKILLed`));
    b.detachAll();
  });

  it('H3: a pipe spawn that fails (missing cwd) is an error reply and the host keeps serving', async () => {
    const { dataDir, registryFile } = scratch();
    const pool = await openPool(dataDir, registryFile, 'boot-H3');
    const hostPid = pool.active!.hello.hostPid;
    const child = RemoteChild.spawn(pool.active!, {
      sid: 'bad-cwd',
      epoch: 'e-bad',
      file: 'sh',
      args: ['-c', 'true'],
      cwd: join(dataDir, 'no-such-dir'),
      env: agentEnv(dataDir),
    });
    const error = await new Promise<Error>((resolve) => child.once('error', resolve));
    expect((error as { code?: string }).code).toBe('spawn_failed');
    expect(running(hostPid)).toBe(true);
    expect(await pool.active!.request({ t: 'ping' })).toMatchObject({ t: 'ok' });
    pool.detachAll();
  });

  it('H4: a controller that stops reading is marked lagged and told to resync; input past the cap is dropped loudly', async () => {
    const { dataDir, registryFile } = scratch();
    const pool = await openPool(dataDir, registryFile, 'boot-H4');
    pool.detachAll();
    const raw = await rawController(registryFile);

    raw.socket.pause();
    raw.send({
      t: 'spawn_pipe',
      rid: 1,
      sid: 'flood',
      epoch: 'e-flood',
      file: 'sh',
      // Exits while the controller is paused: its exit must wait behind the resync.
      args: ['-c', 'exec head -c 24000000 /dev/zero'],
      cwd: dataDir,
      env: agentEnv(dataDir),
    });
    await wait(3_000);
    raw.socket.resume();
    const at = (pred: (f: HostFrame) => boolean) => raw.frames.findIndex(pred);
    const resyncAt = () => at((f) => f.t === 'resync' && f.sid === 'flood' && f.stream === 'out');
    const exitAt = () => at((f) => f.t === 'exit' && f.sid === 'flood');
    await waitFor(() => resyncAt() >= 0 && exitAt() >= 0, 15_000, 'resync and exit after the socket drained');
    expect(resyncAt(), 'the exit never overtakes the unsent tail').toBeLessThan(exitAt());
    // The controller resubscribes from 0 and gets every byte the child wrote.
    raw.send({ t: 'subscribe', rid: 3, sid: 'flood', stream: 'out', fromOffset: 0 });
    await waitFor(() => raw.frames.some((f) => f.t === 'ok' && f.rid === 3), 15_000, 'resubscribe ok');
    expect(raw.frames.find((f) => f.t === 'ok' && f.rid === 3)).toMatchObject({ next: 24_000_000 });

    raw.send({ t: 'spawn_pipe', rid: 2, sid: 'deaf', epoch: 'e-deaf', file: 'sleep', args: ['30'], cwd: dataDir, env: agentEnv(dataDir) });
    await waitFor(() => raw.frames.some((f) => f.t === 'spawned' && f.sid === 'deaf'), 10_000, 'deaf spawned');
    const chunk = Buffer.alloc(900 * 1024, 0x61);
    for (let i = 0; i < 4; i++) raw.send({ t: 'write', sid: 'deaf', tag: `turn-${i}` }, chunk);
    await waitFor(() => raw.frames.some((f) => f.t === 'input_dropped' && f.sid === 'deaf'), 10_000, 'input_dropped');
    const dropped = raw.frames.find((f) => f.t === 'input_dropped') as Extract<HostFrame, { t: 'input_dropped' }>;
    expect(dropped.bytes).toBe(chunk.length);
    expect(dropped.tag).toMatch(/^turn-/);

    raw.send({ t: 'signal', rid: 10, sid: 'deaf', signal: 'SIGKILL' });
    await waitFor(() => raw.frames.some((f) => f.t === 'exit' && f.sid === 'deaf'), 10_000, 'deaf exit');
    raw.socket.destroy();
  }, 40_000);

  it('H6: a live host that refuses the handshake (wrong token) is SIGKILLed before its row goes', async () => {
    const { dataDir, registryFile } = scratch();
    const a = await openPool(dataDir, registryFile, 'boot-A');
    const oldHost = a.active!.hello.hostPid;
    a.detachAll();
    writeFileSync(registryFile, JSON.stringify(rows(registryFile).map((r) => ({ ...r, token: 'not-the-token' }))));
    const b = await openPool(dataDir, registryFile, 'boot-B');
    await waitFor(() => !running(oldHost), 5_000, 'refusing host killed');
    expect(b.dead.map((d) => d.reason)).toContainEqual(expect.stringContaining(`host pid ${oldHost} SIGKILLed`));
    expect(b.active!.hello.hostPid).not.toBe(oldHost);
    b.detachAll();
  });

  it('H7: a lost host falls back in-process loudly, per spawn, and is replaced for the next one', async () => {
    const { dataDir, registryFile } = scratch();
    const pool = await openPool(dataDir, registryFile, 'boot-H7');
    const first = pool.active!;
    const fallbacks: string[] = [];
    const pty = new PtyHostService({
      logger: quiet,
      sessionHost: () => pool.hostForSpawn(),
      onInProcessFallback: (sid) => fallbacks.push(sid),
    });
    process.kill(first.hello.hostPid, 'SIGKILL');
    await waitFor(() => first.lost, 10_000, 'connection lost for good');
    expect(pool.dead.map((d) => d.reason)).toContainEqual(expect.stringContaining('connection lost'));

    pty.spawn({ sessionId: 'during', command: 'sleep 30', cwd: dataDir, env: agentEnv(dataDir) });
    expect(fallbacks).toEqual(['during']);
    expect(pty.hasSession('during')).toBe(true);
    expect(pty.isHostBacked('during')).toBe(false);

    await pool.settled();
    expect(pool.active).not.toBe(first);
    expect(pool.active!.connected).toBe(true);
    cleanupPids.add(pool.active!.hello.hostPid);
    pty.spawn({ sessionId: 'after', command: 'sleep 30', cwd: dataDir, env: agentEnv(dataDir) });
    expect(pty.isHostBacked('after')).toBe(true);
    expect(fallbacks).toEqual(['during']);

    pty.kill('during');
    pty.kill('after');
    await wait(300);
    pool.detachAll();
  }, 20_000);

  it('H10: a host that stops answering fails the request and drops the link', async () => {
    const { dataDir } = scratch();
    const socketPath = join(dataDir, 'mute.sock');
    const accepted: Socket[] = [];
    const server = createServer((socket) => {
      accepted.push(socket);
      const decoder = new FrameDecoder<ServerFrame>();
      socket.on('data', (chunk: Buffer) => {
        for (const { header } of decoder.push(chunk)) {
          if (header.t === 'hello') {
            socket.write(
              encodeFrame({ t: 'hello_ok', generation: 'mute', hostPid: process.pid, protocol: SESSION_HOST_PROTOCOL, startedAt: Date.now(), role: 'active', sessions: [] }),
            );
          }
          // everything else: silence
        }
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((r) => server.listen(socketPath, r));
    const conn = await SessionHostConnection.connect({
      socketPath,
      token: 't',
      serverBootId: 'boot-H10',
      role: 'active',
      requestTimeoutMs: 300,
      logger: quiet,
    });
    const error = await conn.request({ t: 'ping' }).then(
      () => null,
      (e: Error) => e,
    );
    expect((error as { code?: string } | null)?.code).toBe('request_timeout');
    await waitFor(() => accepted[0]!.destroyed, 2_000, 'the stalled socket to be dropped');
    conn.detach();
    for (const s of accepted) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('H11: a spawn with no epoch is refused (the host never mints one); A7: a protocol mismatch is refused by name', async () => {
    const { dataDir, registryFile } = scratch();
    const pool = await openPool(dataDir, registryFile, 'boot-H11');
    const noEpoch = { t: 'spawn_pipe', sid: 'x', file: 'true', args: [], cwd: dataDir, env: agentEnv(dataDir) };
    const error = await pool.active!.request(noEpoch as never).then(
      () => null,
      (e: Error) => e,
    );
    expect((error as { code?: string } | null)?.code).toBe('no_epoch');

    const row = rows(registryFile)[0]!;
    const raw = rawClient(row.socketPath);
    raw.send({ t: 'hello', token: row.token, serverBootId: 'future', protocol: SESSION_HOST_PROTOCOL + 1, role: 'active' });
    await raw.closed;
    expect(raw.frames).toEqual([expect.objectContaining({ t: 'err', code: 'protocol' })]);
    expect(await pool.active!.request({ t: 'ping' }), 'the real controller is untouched').toMatchObject({ t: 'ok' });
    pool.detachAll();
  });
});
