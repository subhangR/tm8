/**
 * Spec D1 §4.4 (301): the ghost reaper. A session this node records as live
 * with no PTY here becomes `failed / lost` — but only after it has been seen
 * that way for the whole stale window, never on one look, and never while a
 * live PTY exists. `markLost` is the panel's "Mark lost": the same write, now.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnError } from '../src/spawn/types.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { FakeGraph } from './fake-graph.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const AUTH = { identityId: 'id-owner', nodeAdmin: true };
const NODE = '127.0.0.1:4620';
const TEN_MIN = 10 * 60_000;

describe('the lost-session reaper (Spec D1 §4.4)', () => {
  let graph: FakeGraph;
  let pty: PtyHostService;
  let service: SpawnService;

  beforeEach(() => {
    graph = new FakeGraph({ workingDir: '/tmp' });
    pty = new PtyHostService({ logger: quiet });
    service = new SpawnService({ graph, pty, baseUrl: 'http://127.0.0.1:4620', nodeId: NODE, logger: quiet });
  });

  afterEach(() => pty.shutdownAll());

  it('never reaps on the first sighting, nor before the window has passed', async () => {
    graph.nodeActiveSessions = [{ sessionId: 'ghost', status: 'running' }];
    expect(await service.reapLostSessions(AUTH, { staleAfterMs: TEN_MIN, now: 0 })).toEqual({ reaped: 0, errors: [] });
    expect(await service.reapLostSessions(AUTH, { staleAfterMs: TEN_MIN, now: TEN_MIN - 1 })).toEqual({ reaped: 0, errors: [] });
    expect(graph.statusesFor('ghost')).toEqual([]);
  });

  it('records failed / lost once the session has had no process for the whole window', async () => {
    graph.nodeActiveSessions = [{ sessionId: 'ghost', status: 'running' }];
    await service.reapLostSessions(AUTH, { staleAfterMs: TEN_MIN, now: 0 });
    expect(await service.reapLostSessions(AUTH, { staleAfterMs: TEN_MIN, now: TEN_MIN })).toEqual({ reaped: 1, errors: [] });
    expect(graph.statusesFor('ghost')).toEqual(['failed']);
    const t = graph.transitions.find((x) => x.sessionId === 'ghost');
    expect(t).toMatchObject({ endedKind: 'lost' });
    expect(String(t?.endedReason)).toMatch(/gone for 10 minutes/);
  });

  it('forgets a session that came back (or ended) between looks — the clock restarts', async () => {
    graph.nodeActiveSessions = [{ sessionId: 'flicker', status: 'spawning' }];
    await service.reapLostSessions(AUTH, { staleAfterMs: TEN_MIN, now: 0 });
    graph.nodeActiveSessions = [];
    await service.reapLostSessions(AUTH, { staleAfterMs: TEN_MIN, now: 1 });
    graph.nodeActiveSessions = [{ sessionId: 'flicker', status: 'running' }];
    expect((await service.reapLostSessions(AUTH, { staleAfterMs: TEN_MIN, now: TEN_MIN })).reaped).toBe(0);
  });

  it('never reaps a session with a live PTY on this node', async () => {
    pty.spawn({ sessionId: 'alive', command: 'sleep 5', cwd: '/tmp', env: {} });
    graph.nodeActiveSessions = [{ sessionId: 'alive', status: 'running' }];
    await service.reapLostSessions(AUTH, { staleAfterMs: TEN_MIN, now: 0 });
    expect((await service.reapLostSessions(AUTH, { staleAfterMs: TEN_MIN, now: 2 * TEN_MIN })).reaped).toBe(0);
    expect(graph.statusesFor('alive')).toEqual([]);
  });

  it('reports, never throws, when the graph cannot be read', async () => {
    graph.listNodeActiveSessionsError = new Error('graph unreachable');
    const r = await service.reapLostSessions(AUTH, { staleAfterMs: TEN_MIN, now: 0 });
    expect(r.reaped).toBe(0);
    expect(r.errors[0]?.message).toMatch(/could not list/);
  });

  it('markLost writes failed / lost now, and is refused while the process is live', async () => {
    await service.markLost(AUTH, 'gone');
    expect(graph.transitions.find((x) => x.sessionId === 'gone')).toMatchObject({ status: 'failed', endedKind: 'lost' });

    pty.spawn({ sessionId: 'here', command: 'sleep 5', cwd: '/tmp', env: {} });
    await expect(service.markLost(AUTH, 'here')).rejects.toBeInstanceOf(SpawnError);
    expect(graph.statusesFor('here')).toEqual([]);
  });
});
