// SpawnService.onSessionLive — the drain-on-live signal (Forms W2, migration 214).
//
// A server-side outbox (form_deliveries) holds answers for a session that was
// not live; it drains when this fires. What is pinned: it fires AFTER the
// running/idle write lands, never for a write that failed, never for a refused
// resume, and a listener can neither delay nor fail the lifecycle write.
import { describe, expect, it, vi } from 'vitest';

import type { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { FakeGraph } from './fake-graph.js';

const SESSION = '44444444-4444-4444-8444-444444444444';
const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };

function service(graph: FakeGraph, live = true): SpawnService {
  const pty = { hasSession: () => live } as unknown as PtyHostService;
  const svc = new SpawnService({ graph, pty, baseUrl: 'http://127.0.0.1:4614', dataDir: '/tmp/unused' });
  // The claims a spawn captures; the activity path writes with them.
  (svc as unknown as { sessionAuth: Map<string, unknown> }).sessionAuth.set(SESSION, AUTH);
  return svc;
}

describe('SpawnService.onSessionLive', () => {
  it('fires after an idle or running activity transition is written', async () => {
    const graph = new FakeGraph({ workingDir: '/tmp', withProject: false });
    const svc = service(graph);
    const seen: Array<[string, string]> = [];
    svc.onSessionLive((id, cause) => { seen.push([id, cause]); });
    await svc.handlePtyActivity(SESSION, 'idle');
    await svc.handlePtyActivity(SESSION, 'busy' as never);
    expect(seen).toEqual([[SESSION, 'idle'], [SESSION, 'running']]);
  });

  it('does not fire when the transition write fails, or the PTY is gone', async () => {
    const graph = new FakeGraph({ workingDir: '/tmp', withProject: false });
    vi.spyOn(graph, 'transition').mockRejectedValue(new Error('23514'));
    const listener = vi.fn();
    const svc = service(graph);
    svc.onSessionLive(listener);
    await svc.handlePtyActivity(SESSION, 'idle');
    const gone = service(new FakeGraph({ workingDir: '/tmp', withProject: false }), false);
    gone.onSessionLive(listener);
    await gone.handlePtyActivity(SESSION, 'idle');
    expect(listener).not.toHaveBeenCalled();
  });

  it('a throwing or rejecting listener never fails the write; unsubscribe stops delivery', async () => {
    const graph = new FakeGraph({ workingDir: '/tmp', withProject: false });
    const svc = service(graph);
    svc.onSessionLive(() => { throw new Error('sync'); });
    svc.onSessionLive(async () => { throw new Error('async'); });
    const kept = vi.fn();
    const off = svc.onSessionLive(kept);
    await expect(svc.handlePtyActivity(SESSION, 'idle')).resolves.toBeUndefined();
    off();
    await svc.handlePtyActivity(SESSION, 'idle');
    expect(kept).toHaveBeenCalledTimes(1);
  });
});
