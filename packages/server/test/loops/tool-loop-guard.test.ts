/**
 * Until the tool action exists (loops PR3), the executor port refuses a tool
 * loop instead of running it as a spawn (its persona) or a dispatch. The port is
 * the one place both the scheduled job and Run now fire through, so this pins
 * both paths: the refusal comes before any read, spawn or dispatch.
 */
import { describe, expect, it } from 'vitest';

import { createLoopExecutorPort } from '../../src/facade/execution-handlers.js';
import { TOOL_LOOP_NOT_RUNNABLE, type DueLoop } from '../../src/scheduler/jobs/loops.js';

/** Any use of a dependency fails the test: the guard must touch nothing. */
const untouched = new Proxy({}, {
  get: (_target, key) => { throw new Error(`the port touched ${String(key)}`); },
});

describe('the loop executor port and a tool loop', () => {
  it('refuses to fire it, before any read, spawn or dispatch', async () => {
    const port = createLoopExecutorPort({
      db: untouched as never,
      pty: untouched as never,
      spawnService: untouched as never,
      resolveOwner: async () => { throw new Error('the port resolved the owner'); },
    });
    const loop = {
      entityId: 'loop-1', spaceId: 'space-1', title: 'Probe hourly', schedule: 'every 1h', timezone: 'UTC',
      action: 'tool', teamMemberId: 'persona-1', subjectId: null, toolId: 'tool-1', toolInputs: {},
      prompt: '', config: null, version: 1, actAsIdentity: 'owner',
    } as unknown as DueLoop;
    await expect(port.fire(loop, { identityId: 'owner', nodeAdmin: false, requestId: 'test' }, new Date(), 'run-1'))
      .rejects.toMatchObject({ code: 'not_implemented', message: TOOL_LOOP_NOT_RUNNABLE });
  });
});
