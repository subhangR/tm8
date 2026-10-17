import { describe, expect, it } from 'vitest';
import { linkedCountsOf } from '../src/facade/linked-counts.js';
import { recordAuthoredFrom } from '../src/facade/services/w2/authored-from.js';
import type { Querier } from '../src/db/types.js';
import type { RequestContext } from '../src/http/types.js';

describe('linkedCountsOf (327)', () => {
  it('omits `linked` for a row or event captured before 327', () => {
    expect(linkedCountsOf({ docs: 2, memories: 1 })).toEqual({});
  });

  it('projects the five columns, numeric, nulls as zero', () => {
    expect(linkedCountsOf({
      linked_docs: '2', linked_pull_requests: 1, linked_artifacts: null,
      linked_drawings: 0, linked_memories: 4,
    })).toEqual({ linked: { docs: 2, pullRequests: 1, artifacts: 0, drawings: 0, memories: 4 } });
  });
});

describe('recordAuthoredFrom (308, 327)', () => {
  const calls: unknown[][] = [];
  const q = { rpc: async (name: string, args: unknown[]) => { calls.push([name, ...args]); return null; } } as unknown as Querier;
  const ctx = (identity: Record<string, unknown>) => ({ identity } as unknown as RequestContext);

  it('records toward the bearer\'s work session first, then its chat', async () => {
    calls.length = 0;
    await recordAuthoredFrom(q, ctx({ kind: 'bearer', workSessionId: 'ws-1', runtimeChatId: 'chat-1' }), 'e-1');
    await recordAuthoredFrom(q, ctx({ kind: 'bearer', runtimeChatId: 'chat-2' }), 'e-2');
    expect(calls).toEqual([
      ['record_authored_from', 'e-1', 'ws-1'],
      ['record_authored_from', 'e-2', 'chat-2'],
    ]);
  });

  it('is a no-op for a human caller, a bearer with neither, or no entity', async () => {
    calls.length = 0;
    await recordAuthoredFrom(q, ctx({ kind: 'auto-owner' }), 'e-1');
    await recordAuthoredFrom(q, ctx({ kind: 'bearer' }), 'e-1');
    await recordAuthoredFrom(q, ctx({ kind: 'bearer', workSessionId: 'ws-1' }), undefined);
    expect(calls).toEqual([]);
  });
});
