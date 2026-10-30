/**
 * The executor port picks its branch by ACTION (§3.4). A tool loop runs its tool
 * through `tools.runScheduled` (loops PR3) and nothing else: no read, no spawn,
 * no dispatch, never as its persona's session. The port is the one place both
 * the scheduled job and Run now fire through, so this pins both paths.
 */
import { describe, expect, it } from 'vitest';

import { createLoopExecutorPort } from '../../src/facade/execution-handlers.js';
import type { DueLoop } from '../../src/scheduler/jobs/loops.js';

/** Any use of a dependency fails the test: the guard must touch nothing. */
const untouched = new Proxy({}, {
  get: (_target, key) => { throw new Error(`the port touched ${String(key)}`); },
});

describe('the loop executor port picks its branch by action', () => {
  it('fires a tool loop through tools.runScheduled alone: no read, spawn or dispatch', async () => {
    const calls: unknown[] = [];
    const port = createLoopExecutorPort({
      db: untouched as never,
      pty: untouched as never,
      spawnService: untouched as never,
      resolveOwner: async () => { throw new Error('the port resolved the owner'); },
      // As main.ts builds it: the port is handed the tool runtime.
      tools: { runScheduled: async (_claims: unknown, request: unknown) => { calls.push(request); return { sessionId: 'session-1', toolVersion: 3, sourceSha256: 'sha' }; } } as never,
    });
    const loop = {
      entityId: 'loop-1', spaceId: 'space-1', title: 'Probe hourly', schedule: 'every 1h', timezone: 'UTC',
      action: 'tool', teamMemberId: 'persona-1', subjectId: null, toolId: 'tool-1', toolInputs: { url: 'https://example.test' },
      prompt: '', config: null, version: 1, actAsIdentity: 'owner',
    } as unknown as DueLoop;
    await expect(port.fire(loop, { identityId: 'owner', nodeAdmin: false, requestId: 'test' }, new Date(), 'run-1'))
      .resolves.toEqual({ taskId: null, sessionId: 'session-1' });
    expect(calls).toEqual([{
      toolId: 'tool-1', inputs: { url: 'https://example.test' }, firingKey: 'run-1',
      triggeredByLoopId: 'loop-1', runAsTeamMemberId: 'persona-1', title: 'Probe hourly',
    }]);
  });

  it('branches on the action, never the runner: a spawn loop with no runner is refused, not routed to the dispatcher', async () => {
    const port = createLoopExecutorPort({
      db: untouched as never,
      pty: untouched as never,
      spawnService: untouched as never,
      resolveOwner: async () => { throw new Error('the port resolved the owner'); },
    });
    const loop = {
      entityId: 'loop-2', spaceId: 'space-1', title: 'Orphaned spawn', schedule: 'every 1h', timezone: 'UTC',
      action: 'spawn', teamMemberId: null, subjectId: null, toolId: null, toolInputs: {},
      prompt: 'sweep', config: null, version: 1, actAsIdentity: 'owner',
    } as unknown as DueLoop;
    await expect(port.fire(loop, { identityId: 'owner', nodeAdmin: false, requestId: 'test' }, new Date(), 'run-2'))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });
});
