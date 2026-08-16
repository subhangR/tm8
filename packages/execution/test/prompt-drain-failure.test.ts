import { afterEach, describe, expect, it, vi } from 'vitest';

import { PromptSettlementWaiter } from '../src/pty/PromptSettlementWaiter.js';
import { PtyHostService } from '../src/pty/PtyHostService.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('prompt-drain failure settlement', () => {
  let host: PtyHostService | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    host?.shutdownAll();
  });

  it('settles a dequeued delivery as unknown when its PTY write throws', async () => {
    const waiter = new PromptSettlementWaiter();
    host = new PtyHostService({ logger: quiet, onPromptSettled: waiter.resolve });
    host.spawn({ sessionId: 'repro', command: 'sleep 5', cwd: '/tmp', env: {} });
    vi.spyOn(host as never, 'writePromptToEntry').mockRejectedValueOnce(
      new Error('injected PTY write failure'),
    );

    const outcome = waiter.awaitOutcome('delivery-repro');
    await expect(host.deliverPrompt('repro', 'hello', 'send', 'delivery-repro')).resolves.toBe(true);

    await expect(outcome).resolves.toEqual({
      outcome: 'unknown',
      reason: 'pty_prompt_write_failed',
    });
  });
});
