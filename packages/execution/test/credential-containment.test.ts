// CREDENTIAL CONTAINMENT records the ending of the session it kills.
//
// A space-credential delete, the member Disconnect and SC-6's member removal
// used to call `PtyHostService.kill` directly, which leaves the row `running`
// forever (the late onExit returns at its identity check). They now go
// through `SpawnService.containCredentialSession`, which shares `terminate`'s
// kill-then-transition. This suite pins that method against the real PTY host
// and a fake graph; the pg suite (server, credential-containment-ending)
// pins the three callers end to end.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService, type CredentialContainmentCause } from '../src/spawn/SpawnService.js';
import { FakeGraph } from './fake-graph.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const LAUNCHER = { identityId: 'id-launcher', nodeAdmin: false };

const CAUSES: CredentialContainmentCause[] = ['space_credential_deleted', 'member_credential_disconnected', 'member_removed'];

describe('containCredentialSession', () => {
  let graph: FakeGraph;
  let pty: PtyHostService;
  let service: SpawnService;
  const loud: string[] = [];

  /** A live PTY this service holds the launcher's claims for, as a spawn leaves it. */
  const live = (sessionId: string): void => {
    pty.spawn({ sessionId, command: 'sleep 30', cwd: '/tmp', env: {} });
    (service as unknown as { sessionAuth: Map<string, unknown> }).sessionAuth.set(sessionId, LAUNCHER);
  };

  beforeEach(() => {
    loud.length = 0;
    // `loud` is console.error, so a ghost is visible without a logger.
    vi.spyOn(console, 'error').mockImplementation((message: unknown) => { loud.push(String(message)); });
    graph = new FakeGraph({ workingDir: '/tmp' });
    pty = new PtyHostService({ logger: quiet });
    service = new SpawnService({
      graph, pty, baseUrl: 'http://127.0.0.1:4620', nodeId: '127.0.0.1:4620',
      logger: quiet,
    });
  });
  afterEach(() => { pty.shutdownAll(); vi.restoreAllMocks(); });

  it('kills, then writes ONE ending under the launcher’s claims, naming the cause', async () => {
    const reasons = new Set<string>();
    for (const cause of CAUSES) {
      const id = `s-${cause}`;
      live(id);
      expect(await service.containCredentialSession(id, cause)).toEqual({ outcome: 'killed', recorded: true });
      expect(pty.hasSession(id)).toBe(false);
      const writes = graph.transitions.filter((t) => t.sessionId === id);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ status: 'exited', endedKind: 'stopped_by_operator' });
      reasons.add(writes[0]!.endedReason!);
    }
    // Three causes, three sentences — and none of them is terminate's.
    expect(reasons.size).toBe(3);
    expect(reasons.has('Stopped by request.')).toBe(false);
  });

  it('no live PTY here: writes nothing (nothing was confirmed dead)', async () => {
    expect(await service.containCredentialSession('gone', 'member_removed')).toEqual({ outcome: 'not_found', recorded: false });
    expect(graph.transitions).toHaveLength(0);
  });

  it('claims held but no PTY here (another node, or already gone): writes nothing — unlike terminate', async () => {
    (service as unknown as { sessionAuth: Map<string, unknown> }).sessionAuth.set('elsewhere', LAUNCHER);
    expect(await service.containCredentialSession('elsewhere', 'member_removed')).toEqual({ outcome: 'not_found', recorded: false });
    expect(graph.transitions).toHaveLength(0);
  });

  it('a live PTY with no captured claims is killed, and its unrecorded ending is reported, loudly', async () => {
    pty.spawn({ sessionId: 'orphan', command: 'sleep 30', cwd: '/tmp', env: {} });
    expect(await service.containCredentialSession('orphan', 'space_credential_deleted')).toEqual({
      outcome: 'killed', recorded: false, reason: 'no_captured_claims',
    });
    expect(graph.transitions).toHaveLength(0);
    expect(loud.some((m) => m.includes('orphan'))).toBe(true);
  });

  it('a transition the graph refuses after the kill is returned, never thrown', async () => {
    live('refused');
    graph.failTransitionFor.add('refused');
    const result = await service.containCredentialSession('refused', 'space_credential_deleted');
    expect(result.outcome).toBe('killed');
    expect(result.recorded).toBe(false);
    expect(result.reason).toMatch(/^transition_failed: /);
    expect(pty.hasSession('refused')).toBe(false);
    expect(loud.some((m) => m.includes('refused'))).toBe(true);
  });

  it('drops the claims even when the kill fails, and writes nothing', async () => {
    live('stuck');
    const entry = (pty as unknown as { sessions: Map<string, { proc: { kill: () => void } }> }).sessions.get('stuck')!;
    const realKill = entry.proc.kill.bind(entry.proc);
    entry.proc.kill = () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };
    try {
      expect(await service.containCredentialSession('stuck', 'member_removed')).toEqual({ outcome: 'error', recorded: false });
      expect(graph.transitions).toHaveLength(0);
      expect((service as unknown as { sessionAuth: Map<string, unknown> }).sessionAuth.has('stuck')).toBe(false);
    } finally {
      realKill();
    }
  });
});
