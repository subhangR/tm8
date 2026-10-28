/**
 * 378: boot reconciliation and the lost-session reaper reach ghosts in EVERY
 * space, through the node doors (`listNodeLiveSessions`,
 * `recordNodeSessionLost`), never the member door.
 *
 * The fake models the prod defect: the node identity is a member of space A
 * only, so the member write (`transition`, which `terminate` uses) refuses B's
 * session with the error prod printed. Reconciliation and the reaper must not
 * touch that door at all; the SQL side of the doors is pinned by
 * packages/server/test/db/node-ghost-sessions-378.pg.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  afterEach(() => pty.shutdownAll());

  it('boot reconciliation retires the ghost in a space the node identity is not a member of', async () => {
    expect(await service.reconcileNodeGhosts(AUTH)).toEqual({ retired: 2, errors: [] });
    expect(graph.nodeLostWrites.map((w) => w.sessionId)).toEqual(['ghost-a', 'ghost-b']);
    for (const w of graph.nodeLostWrites) {
      expect(w.nodeId).toBe(NODE);
      expect(w.endedKind).toBe('server_restart');
      expect(w.error).toMatch(/retired at node startup/);
    }
    // The node observed an absence; nobody gave a command.
    expect(graph.commands).toEqual([]);
  });

  it('the reaper retires both after the window, as failed / lost', async () => {
    await service.reapLostSessions(AUTH, { staleAfterMs: TEN_MIN, now: 0 });
    expect(graph.nodeLostWrites).toEqual([]);
    expect(await service.reapLostSessions(AUTH, { staleAfterMs: TEN_MIN, now: TEN_MIN })).toEqual({
      candidates: 2,
      reaped: 2,
      errors: [],
    });
    expect(graph.nodeLostWrites.map((w) => [w.sessionId, w.endedKind])).toEqual([
      ['ghost-a', 'lost'],
      ['ghost-b', 'lost'],
    ]);
    expect(graph.nodeLostWrites[0]!.endedReason).toMatch(/gone for 10 minutes/);
  });

  it('does not count a row whose own exit won the race, nor one with a live PTY', async () => {
    pty.spawn({ sessionId: 'ghost-a', command: 'sleep 5', cwd: '/tmp', env: {} });
    graph.recordNodeSessionLost = async () => false;
    expect(await service.reconcileNodeGhosts(AUTH)).toEqual({ retired: 0, errors: [] });
  });

  it('the panel’s "Mark lost" stays on the member door: a person acts with their own claims', async () => {
    await service.markLost(AUTH, 'ghost-a');
    expect(graph.nodeLostWrites).toEqual([]);
    expect(graph.commands.map((c) => c.operation)).toEqual(['execution.terminate']);
    await expect(service.markLost(AUTH, 'ghost-b')).rejects.toThrow(/not a member/);
  });
});
