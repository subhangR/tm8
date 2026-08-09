import { describe, expect, it } from 'vitest';
import { BudgetExceededError } from '@tm8/prompt';
import { CollabError } from '@tm8/contract';
import { toCollabError } from '../src/facade/execution-handlers.js';

describe('execution error mapping', () => {
  it('returns an actionable non-retryable 413 for a prompt budget refusal', () => {
    const mapped = toCollabError(
      new BudgetExceededError('combinedInitialInjection', 67_316, 32_768),
    );

    expect(mapped).toBeInstanceOf(CollabError);
    expect(mapped).toMatchObject({
      code: 'payload_too_large',
      status: 413,
      retryable: false,
      message: 'combinedInitialInjection is 67316 UTF-8 bytes, over its 32768-byte hard cap',
      details: {
        material: 'combinedInitialInjection',
        bytes: 67_316,
        cap: 32_768,
      },
    });
  });
});
