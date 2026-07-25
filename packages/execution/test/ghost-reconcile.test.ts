// Startup ghost reconciliation.
//
// A PTY lives in the server process. When that process dies — a dev restart, a
// crash, a kill — every agent dies with it, but the `work_sessions` rows stay at
// 'running': the exit transition is written by a sink that cannot run for a
// process killed alongside its host. Those rows are GHOSTS. The UI paints them
// as live agents and each one permanently burns a slot against the 8-session
// concurrency cap, so a handful of restarts is enough to make spawning fail with
// `session concurrency cap reached` — which is exactly how this was found, after
// eight dev restarts had consumed every slot.
//
// The inference is sound only at STARTUP and only for THIS node: a fresh process
// has an empty PTY map, so a row this node owns that claims to be running
// provably has no process behind it.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { FakeGraph } from './fake-graph.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const AUTH = { identityId: 'id-owner', nodeAdmin: true };
const NODE = '127.0.0.1:4620';

describe('startup ghost reconciliation', () => {
  let graph: FakeGraph;
  let pty: PtyHostService;
  let service: SpawnService;

  beforeEach(() => {
    graph = new FakeGraph({ workingDir: '/tmp' });
    pty = new PtyHostService({ logger: quiet });
    service = new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4620',
      nodeId: NODE,
      logger: quiet,
    });
  });

  afterEach(() => pty.shutdownAll());

  it('retires a session left at running by a previous process', async () => {
    graph.nodeActiveSessions = [{ sessionId: 'ghost-1', status: 'running' }];

    const retired = await service.reconcileNodeGhosts(AUTH);

    expect(retired).toBe(1);
    expect(graph.statusesFor('ghost-1')).toEqual(['exited']);
    // Retirement goes through the ordinary terminate path, so the ledger records
    // it like any other terminate rather than a status mutating from nowhere.
    expect(graph.commands.map((c) => c.operation)).toEqual(['execution.terminate']);
  });

  it('retires spawning and idle too, not just running', async () => {
    // A process killed mid-spawn leaves 'spawning'; an agent that went quiet
    // leaves 'idle'. Both hold a slot exactly as firmly as 'running'.
    graph.nodeActiveSessions = [
      { sessionId: 'g-spawning', status: 'spawning' },
      { sessionId: 'g-idle', status: 'idle' },
    ];

    expect(await service.reconcileNodeGhosts(AUTH)).toBe(2);
    expect(graph.statusesFor('g-spawning')).toEqual(['exited']);
    expect(graph.statusesFor('g-idle')).toEqual(['exited']);
  });

  it('scopes the query to THIS node', async () => {
    // A non-terminal session owned by another node may be perfectly alive over
    // there. Only the node holding a PTY can say whether it is gone.
    await service.reconcileNodeGhosts(AUTH);
    expect(graph.nodeSessionQueries).toEqual([NODE]);
  });

  it('does NOT retire a session that has a live PTY on this node', async () => {
    // Makes the sweep safe to call at any time, not only at boot — and stops a
    // stray call from killing a running agent.
    pty.spawn({ sessionId: 'alive', command: 'sleep 5', cwd: '/tmp', env: {} });
    graph.nodeActiveSessions = [
      { sessionId: 'alive', status: 'running' },
      { sessionId: 'ghost', status: 'running' },
    ];

    expect(await service.reconcileNodeGhosts(AUTH)).toBe(1);
    expect(graph.statusesFor('alive')).toEqual([]);
    expect(graph.statusesFor('ghost')).toEqual(['exited']);
  });

  it('does nothing, quietly, when there are no ghosts', async () => {
    expect(await service.reconcileNodeGhosts(AUTH)).toBe(0);
    expect(graph.transitions).toHaveLength(0);
  });

  it('NEVER throws when the graph cannot be read — boot must not depend on cleanup', async () => {
    graph.listNodeActiveSessionsError = new Error('graph unreachable');
    await expect(service.reconcileNodeGhosts(AUTH)).resolves.toBe(0);
  });

  it('keeps sweeping when ONE session fails to retire', async () => {
    // One unreadable or un-transitionable row must not strand every other ghost
    // — that would leave the cap consumed by rows we already identified.
    graph.failTerminateFor.add('bad');
    graph.nodeActiveSessions = [
      { sessionId: 'bad', status: 'running' },
      { sessionId: 'good', status: 'running' },
    ];

    expect(await service.reconcileNodeGhosts(AUTH)).toBe(1);
    expect(graph.statusesFor('good')).toEqual(['exited']);
  });

  it('is a no-op on a node with no id, rather than retiring everything', async () => {
    // nodeId null means we cannot tell our rows from another node's. Retiring on
    // that basis would kill live agents belonging to a different server.
    const anonymous = new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4620',
      nodeId: null,
      logger: quiet,
    });
    graph.nodeActiveSessions = [{ sessionId: 'ghost', status: 'running' }];

    expect(await anonymous.reconcileNodeGhosts(AUTH)).toBe(0);
    expect(graph.nodeSessionQueries).toHaveLength(0);
    expect(graph.transitions).toHaveLength(0);
  });
});
