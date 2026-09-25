// Boot-time auto-resume.
//
// A restart ends every live session with `ended_kind = 'server_restart'` and a
// promise: "it can be resumed to pick up where it left off". Until
// `resumeInterruptedSessions` existed nothing kept that promise — one macOS
// restart on 2026-09-23 left 62 agents dead, each waiting for its own click on
// Resume. These tests pin what the boot does with them.
//
// `resume()` itself is covered by the session-resume suites; here it is spied,
// so this file is about the SWEEP: which rows, in what order, with what key,
// and what happens when one of them refuses.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { FakeGraph } from './fake-graph.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const AUTH = { identityId: 'id-owner', nodeAdmin: true };
const NODE = '127.0.0.1:4620';
const HOUR = 3_600_000;

describe('boot-time auto-resume', () => {
  let graph: FakeGraph;
  let pty: PtyHostService;
  let service: SpawnService;
  let resume: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    graph = new FakeGraph({ workingDir: '/tmp' });
    pty = new PtyHostService({ logger: quiet });
    service = new SpawnService({ graph, pty, baseUrl: 'http://127.0.0.1:4620', nodeId: NODE, logger: quiet });
    resume = vi.spyOn(service, 'resume').mockResolvedValue({} as never);
  });

  afterEach(() => pty.shutdownAll());

  it('resumes every interrupted session, through resume(), as the given identity', async () => {
    const exitedAt = new Date('2026-09-23T15:53:00Z');
    graph.nodeInterruptedSessions = [
      { sessionId: 's-1', exitedAt },
      { sessionId: 's-2', exitedAt },
    ];

    const report = await service.resumeInterruptedSessions(AUTH, { windowMs: 24 * HOUR, staggerMs: 0 });

    expect(report).toEqual({ resumed: ['s-1', 's-2'], errors: [] });
    expect(resume.mock.calls.map(([auth, req]) => [auth, (req as { sessionId: string }).sessionId])).toEqual([
      [AUTH, 's-1'],
      [AUTH, 's-2'],
    ]);
  });

  it('asks only about THIS node, and only as far back as the window', async () => {
    const before = Date.now();
    await service.resumeInterruptedSessions(AUTH, { windowMs: 6 * HOUR, staggerMs: 0 });

    expect(graph.interruptedQueries).toHaveLength(1);
    const [query] = graph.interruptedQueries;
    expect(query!.nodeId).toBe(NODE);
    const since = query!.since.getTime();
    expect(since).toBeGreaterThanOrEqual(before - 6 * HOUR);
    expect(since).toBeLessThanOrEqual(Date.now() - 6 * HOUR);
  });

  it('keys the mutation on the interruption, so a second restart is not swallowed as a replay', async () => {
    graph.nodeInterruptedSessions = [{ sessionId: 's-1', exitedAt: new Date('2026-09-23T15:53:00Z') }];
    await service.resumeInterruptedSessions(AUTH, { windowMs: 24 * HOUR, staggerMs: 0 });

    graph.nodeInterruptedSessions = [{ sessionId: 's-1', exitedAt: new Date('2026-09-24T09:10:00Z') }];
    await service.resumeInterruptedSessions(AUTH, { windowMs: 24 * HOUR, staggerMs: 0 });

    const keys = resume.mock.calls.map(([, req]) => (req as { clientMutationId: string }).clientMutationId);
    expect(keys).toEqual([
      'auto-resume:s-1:2026-09-23T15:53:00.000Z',
      'auto-resume:s-1:2026-09-24T09:10:00.000Z',
    ]);
  });

  it('one refusal does not keep the rest down', async () => {
    const exitedAt = new Date();
    graph.nodeInterruptedSessions = [
      { sessionId: 'capped', exitedAt },
      { sessionId: 'fine', exitedAt },
    ];
    resume.mockImplementation(async (_auth, req) => {
      if ((req as { sessionId: string }).sessionId === 'capped') throw new Error('session concurrency cap reached');
      return {} as never;
    });

    const report = await service.resumeInterruptedSessions(AUTH, { windowMs: HOUR, staggerMs: 0 });

    expect(report.resumed).toEqual(['fine']);
    expect(report.errors).toEqual([{ sessionId: 'capped', message: 'session concurrency cap reached' }]);
  });

  it('never throws when the graph cannot be read — it reports', async () => {
    graph.listNodeInterruptedSessionsError = new Error('connection refused');

    const report = await service.resumeInterruptedSessions(AUTH, { windowMs: HOUR, staggerMs: 0 });

    expect(report.resumed).toEqual([]);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]!.message).toContain('connection refused');
    expect(resume).not.toHaveBeenCalled();
  });

  it('stops bringing sessions back once the node starts shutting down', async () => {
    const exitedAt = new Date();
    graph.nodeInterruptedSessions = [
      { sessionId: 'first', exitedAt },
      { sessionId: 'second', exitedAt },
    ];
    resume.mockImplementation(async () => {
      // The node is told to stop while the first resume is in flight.
      await service.recordShutdown(AUTH, 'SIGTERM');
      return {} as never;
    });

    const report = await service.resumeInterruptedSessions(AUTH, { windowMs: HOUR, staggerMs: 0 });

    expect(report.resumed).toEqual(['first']);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('staggers between resumes', async () => {
    vi.useFakeTimers();
    try {
      const exitedAt = new Date();
      graph.nodeInterruptedSessions = [
        { sessionId: 'a', exitedAt },
        { sessionId: 'b', exitedAt },
      ];
      const run = service.resumeInterruptedSessions(AUTH, { windowMs: HOUR, staggerMs: 2_000 });

      await vi.advanceTimersByTimeAsync(0);
      expect(resume).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(resume).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(resume).toHaveBeenCalledTimes(2);
      expect((await run).resumed).toEqual(['a', 'b']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing on a node with no stable identity', async () => {
    const anonymous = new SpawnService({ graph, pty, baseUrl: 'http://127.0.0.1:4620', logger: quiet });
    graph.nodeInterruptedSessions = [{ sessionId: 's-1', exitedAt: new Date() }];

    expect(await anonymous.resumeInterruptedSessions(AUTH, { windowMs: HOUR, staggerMs: 0 })).toEqual({
      resumed: [],
      errors: [],
    });
    expect(graph.interruptedQueries).toEqual([]);
  });
});
