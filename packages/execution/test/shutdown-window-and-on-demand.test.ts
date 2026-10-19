// Two halves of "a session comes back on its own".
//
// 1. THE SHUTDOWN WINDOW. `systemctl restart` with KillMode=control-group
//    SIGTERMs the server and every agent child at the same instant. On
//    agentdev1 on 2026-10-19 two such children were processed before the
//    server's own handler ran and were filed `crashed` — so boot-time
//    auto-resume, which only takes `server_restart`, left them dead.
// 2. RESUME ON DEMAND. A session the node itself stopped (restart, idle reap,
//    ghost) is brought back when it is prompted, instead of refusing.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import type { WorkSessionResumeInfo } from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const AUTH = { identityId: 'id-owner', nodeAdmin: true };
const NODE = '127.0.0.1:4620';

const last = (graph: FakeGraph, sessionId: string) =>
  graph.transitions.filter((t) => t.sessionId === sessionId).at(-1);

const adopt = (service: SpawnService, sessionId: string): void => {
  (service as unknown as { sessionAuth: Map<string, unknown> }).sessionAuth.set(sessionId, AUTH);
};

const resumeInfo = (over: Partial<WorkSessionResumeInfo>): WorkSessionResumeInfo => ({
  sessionId: 's-1',
  spaceId: 'space-1',
  parentSessionId: null,
  teamMemberId: 'tm-1',
  projectId: null,
  taskIds: [],
  workdirMode: 'project',
  workdirPath: '/tmp',
  mode: null,
  model: null,
  agentTool: 'claude-code',
  title: 'a session',
  status: 'failed',
  nativeSessionId: 'native-1',
  agentConfigDir: null,
  nodeId: NODE,
  endedKind: 'server_restart',
  ...over,
});

describe('an exit inside the shutdown window is a restart', () => {
  let graph: FakeGraph;
  let pty: PtyHostService;
  let service: SpawnService;

  beforeEach(() => {
    graph = new FakeGraph({ workingDir: '/tmp' });
    pty = new PtyHostService({ logger: quiet });
    service = new SpawnService({ graph, pty, baseUrl: 'http://127.0.0.1:4620', nodeId: NODE, logger: quiet });
  });
  afterEach(() => pty.shutdownAll());

  it('files an exit processed after beginShutdown as failed / server_restart, clean exits included', async () => {
    adopt(service, 'sig');
    adopt(service, 'clean');
    service.beginShutdown();
    await service.handlePtyExit('sig', 'failed', { exitCode: null, signal: 15 });
    await service.handlePtyExit('clean', 'completed', { exitCode: 0, signal: null });

    expect(last(graph, 'sig')).toMatchObject({ status: 'failed', endedKind: 'server_restart' });
    expect(last(graph, 'clean')).toMatchObject({ status: 'failed', endedKind: 'server_restart' });
  });

  it('re-files a crash recorded just BEFORE the signal handler ran (the 2026-10-19 race)', async () => {
    adopt(service, 'raced');
    await service.handlePtyExit('raced', 'failed', { exitCode: 143, signal: null });
    expect(last(graph, 'raced')).toMatchObject({ status: 'failed', endedKind: 'crashed' });

    await service.recordShutdown(AUTH, 'SIGTERM');

    expect(last(graph, 'raced')).toMatchObject({ status: 'failed', endedKind: 'server_restart' });
  });

  it('leaves a crash older than the lookback alone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      adopt(service, 'old');
      await service.handlePtyExit('old', 'failed', { exitCode: 1, signal: null });
      vi.setSystemTime(Date.now() + 60_000);
      await service.recordShutdown(AUTH, 'SIGTERM');
      expect(last(graph, 'old')).toMatchObject({ endedKind: 'crashed' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a session exiting cleanly while the node is up stays exited_clean', async () => {
    adopt(service, 'done');
    await service.handlePtyExit('done', 'completed', { exitCode: 0, signal: null });
    expect(last(graph, 'done')).toMatchObject({ status: 'exited', endedKind: 'exited_clean' });
  });
});

describe('resume on demand', () => {
  let graph: FakeGraph;
  let pty: PtyHostService;
  let service: SpawnService;
  let resume: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    graph = new FakeGraph({ workingDir: '/tmp' });
    pty = new PtyHostService({ logger: quiet });
    service = new SpawnService({ graph, pty, baseUrl: 'http://127.0.0.1:4620', nodeId: NODE, logger: quiet });
    resume = vi.spyOn(service, 'resume').mockImplementation(async (_auth, req) => {
      pty.spawn({ sessionId: req.sessionId, command: 'sleep 30', cwd: '/tmp', env: {} });
      return {} as never;
    });
  });
  afterEach(() => pty.shutdownAll());

  for (const endedKind of ['server_restart', 'idle_reaped', 'lost'] as const) {
    it(`brings back a session that ended ${endedKind}`, async () => {
      graph.resumeInfo = resumeInfo({ endedKind });
      expect(await service.ensureLive(AUTH, 's-1')).toBe(true);
      expect(resume).toHaveBeenCalledTimes(1);
    });
  }

  for (const endedKind of ['stopped_by_operator', 'crashed', 'out_of_memory', 'exited_clean'] as const) {
    it(`leaves a session that ended ${endedKind} for a person`, async () => {
      graph.resumeInfo = resumeInfo({ endedKind });
      expect(await service.ensureLive(AUTH, 's-1')).toBe(false);
      expect(resume).not.toHaveBeenCalled();
    });
  }

  it('never takes another node\'s session', async () => {
    graph.resumeInfo = resumeInfo({ nodeId: 'other:4620' });
    expect(await service.ensureLive(AUTH, 's-1')).toBe(false);
    expect(resume).not.toHaveBeenCalled();
  });

  it('shares one resume between concurrent callers', async () => {
    graph.resumeInfo = resumeInfo({});
    const [a, b] = await Promise.all([service.ensureLive(AUTH, 's-1'), service.ensureLive(AUTH, 's-1')]);
    expect([a, b]).toEqual([true, true]);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('resolves false, never throws, when resume refuses', async () => {
    graph.resumeInfo = resumeInfo({});
    resume.mockRejectedValueOnce(new Error('session cap reached'));
    expect(await service.ensureLive(AUTH, 's-1')).toBe(false);
  });

  it('a prompt to an interrupted session resumes it, then delivers', async () => {
    graph.resumeInfo = resumeInfo({});
    const deliver = vi.spyOn(pty, 'deliverPrompt').mockResolvedValue(true);
    await service.prompt(AUTH, 's-1', 'carry on');
    expect(resume).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith('s-1', 'carry on', 'send');
  });

  it('a prompt to an operator-stopped session still refuses', async () => {
    graph.resumeInfo = resumeInfo({ endedKind: 'stopped_by_operator' });
    await expect(service.prompt(AUTH, 's-1', 'carry on')).rejects.toThrow(/no live terminal/);
  });

  it('does nothing once the node is shutting down', async () => {
    graph.resumeInfo = resumeInfo({});
    service.beginShutdown();
    expect(await service.ensureLive(AUTH, 's-1')).toBe(false);
    expect(resume).not.toHaveBeenCalled();
  });
});
