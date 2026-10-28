/**
 * 378: boot reconciliation and the lost-session reaper reach ghosts in EVERY
 * space, through the node doors (`listNodeLiveSessions`,
 * `recordNodeSessionEnding`), never the member door.
 *
 * The fake models the prod defect: the node identity is a member of space A
 * only, so the member write (`transition`, which `terminate` uses) refuses B's
 * session with the error prod printed. Reconciliation and the reaper must not
 * touch that door at all; the SQL side of the doors is pinned by
 * packages/server/test/db/node-ghost-sessions-378.pg.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The two process facts these paths read from outside the graph, made
// steerable: the cgroup OOM counter and the agent's transcript.
const witness = vi.hoisted(() => ({ oomKills: 0, transcript: false }));
vi.mock('../src/spawn/oom-witness.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/spawn/oom-witness.js')>()),
  readOomKillCount: async () => witness.oomKills,
}));
vi.mock('../src/transcript/session-usage.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/transcript/session-usage.js')>()),
  readSessionUsage: async () =>
    witness.transcript
      ? { available: true, source: 'codex_rollout', usage: { transcript: { messages: 1 }, transcriptBytes: 1 } }
      : { available: false, reason: 'no transcript', searchedPaths: [] },
}));

import { PtyHostService } from '../src/pty/PtyHostService.js';
import type { GraphAuth, TransitionInput } from '../src/spawn/types.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { FakeGraph } from './fake-graph.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const AUTH = { identityId: 'id-owner', nodeAdmin: true };
const NODE = '127.0.0.1:4620';
const TEN_MIN = 10 * 60_000;

/** The node identity is a member of space A; `ghost-b` sits in space B. */
class TwoSpaceGraph extends FakeGraph {
  override async transition(auth: GraphAuth, input: TransitionInput): Promise<void> {
    if (input.sessionId === 'ghost-b') throw new Error('forbidden: not a member of this space');
    return super.transition(auth, input);
  }
}

describe('node ghost doors (378)', () => {
  let graph: TwoSpaceGraph;
  let pty: PtyHostService;
  let service: SpawnService;

  beforeEach(() => {
    graph = new TwoSpaceGraph({ workingDir: '/tmp' });
    pty = new PtyHostService({ logger: quiet });
    service = new SpawnService({ graph, pty, baseUrl: 'http://127.0.0.1:4620', nodeId: NODE, logger: quiet });
    graph.nodeLiveSessions = [
      { sessionId: 'ghost-a', status: 'running' },
      { sessionId: 'ghost-b', status: 'idle' },
    ];
  });

  afterEach(() => {
    pty.shutdownAll();
    witness.oomKills = 0;
    witness.transcript = false;
  });

  it('boot reconciliation retires the ghost in a space the node identity is not a member of', async () => {
    expect(await service.reconcileNodeGhosts(AUTH)).toEqual({ retired: 2, errors: [] });
    expect(graph.nodeEndings.map((w) => w.sessionId)).toEqual(['ghost-a', 'ghost-b']);
    for (const w of graph.nodeEndings) {
      expect(w.nodeId).toBe(NODE);
      expect(w.endedKind).toBe('server_restart');
      expect(w.error).toMatch(/retired at node startup/);
    }
    // The member door's command row was not asked for; the node door writes its own.
    expect(graph.commands).toEqual([]);
  });

  it('the reaper retires both after the window, as failed / lost', async () => {
    await service.reapLostSessions(AUTH, { staleAfterMs: TEN_MIN, now: 0 });
    expect(graph.nodeEndings).toEqual([]);
    expect(await service.reapLostSessions(AUTH, { staleAfterMs: TEN_MIN, now: TEN_MIN })).toEqual({
      candidates: 2,
      reaped: 2,
      errors: [],
    });
    expect(graph.nodeEndings.map((w) => [w.sessionId, w.endedKind])).toEqual([
      ['ghost-a', 'lost'],
      ['ghost-b', 'lost'],
    ]);
    expect(graph.nodeEndings[0]!.endedReason).toMatch(/gone for 10 minutes/);
  });

  it('does not count a row whose own exit won the race, nor one with a live PTY', async () => {
    pty.spawn({ sessionId: 'ghost-a', command: 'sleep 5', cwd: '/tmp', env: {} });
    graph.recordNodeSessionEnding = async () => ({ recorded: false, usageFacts: null });
    expect(await service.reconcileNodeGhosts(AUTH)).toEqual({ retired: 0, errors: [] });
  });

  it('the panel’s "Mark lost" stays on the member door: a person acts with their own claims', async () => {
    await service.markLost(AUTH, 'ghost-a');
    expect(graph.nodeEndings).toEqual([]);
    expect(graph.commands.map((c) => c.operation)).toEqual(['execution.terminate']);
    await expect(service.markLost(AUTH, 'ghost-b')).rejects.toThrow(/not a member/);
  });

  it('measures usage through the node door from the facts the ending returned', async () => {
    witness.transcript = true;
    graph.nodeUsageFacts = {
      agentTool: 'codex', nativeSessionId: 'n-1', workdirMode: 'scratch', workdirPath: null, agentConfigDir: null,
    };
    await service.reconcileNodeGhosts(AUTH);
    expect(graph.nodeUsageWrites.map((w) => [w.sessionId, w.nodeId, w.source])).toEqual([
      ['ghost-a', NODE, 'codex_rollout'],
      ['ghost-b', NODE, 'codex_rollout'],
    ]);
  });

  it('measures nothing for a row the door did not record', async () => {
    witness.transcript = true;
    graph.nodeUsageFacts = {
      agentTool: 'codex', nativeSessionId: 'n-1', workdirMode: 'scratch', workdirPath: null, agentConfigDir: null,
    };
    graph.recordNodeSessionEnding = async () => ({ recorded: false, usageFacts: null });
    await service.reconcileNodeGhosts(AUTH);
    expect(graph.nodeUsageWrites).toEqual([]);
  });

  it('names out_of_memory for the one ghost, counting ghosts and not PTY-held rows', async () => {
    witness.oomKills = 1;
    // Two live rows, one of them held here: ONE ghost, so the counter points at it.
    pty.spawn({ sessionId: 'ghost-a', command: 'sleep 5', cwd: '/tmp', env: {} });
    await service.reconcileNodeGhosts(AUTH);
    expect(graph.nodeEndings.map((w) => [w.sessionId, w.endedKind])).toEqual([['ghost-b', 'out_of_memory']]);
  });

  it('with several ghosts and a memory kill, names no victim', async () => {
    witness.oomKills = 1;
    await service.reconcileNodeGhosts(AUTH);
    expect(graph.nodeEndings.map((w) => w.endedKind)).toEqual(['unknown', 'unknown']);
  });

  it('the completed auto-close ends the idle process through the node door, as exited / exited_clean', async () => {
    graph.listCompletedSessionsToClose = async () => [
      { sessionId: 'done-a', minutes: 30 },
      { sessionId: 'ghost-b', minutes: 45 },
    ];
    pty.spawn({ sessionId: 'done-a', command: 'sleep 5', cwd: '/tmp', env: {} });
    expect(await service.closeIdleCompletedSessions(AUTH)).toEqual({ closed: 2, errors: [] });
    expect(pty.hasSession('done-a')).toBe(false);
    expect(graph.nodeEndings.map((w) => [w.sessionId, w.status, w.endedKind])).toEqual([
      ['done-a', 'exited', 'exited_clean'],
      ['ghost-b', 'exited', 'exited_clean'],
    ]);
    // The member door, which refuses `ghost-b`'s space, was never asked.
    expect(graph.commands).toEqual([]);
  });
});
