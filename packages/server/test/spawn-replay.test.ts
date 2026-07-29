import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/types.js';
import { DbGraphPort } from '../src/facade/execution-handlers.js';

const SESSION_ID = '55555555-5555-4555-8555-555555555555';

function graphReturning(result: Record<string, unknown>) {
  const rpc = vi.fn(async () => result);
  const db = {
    rpc,
    tx: vi.fn(),
    query: vi.fn(),
    end: vi.fn(),
  } as unknown as Db;
  return { graph: new DbGraphPort(db), rpc };
}

const CREATE_INPUT = {
  spaceId: '11111111-1111-4111-8111-111111111111',
  teamMemberId: '22222222-2222-4222-8222-222222222222',
  taskIds: ['33333333-3333-4333-8333-333333333333'],
  projectId: null,
  workdirMode: 'scratch' as const,
  workdirPath: '/tmp/tm8/scratch/session',
  baseRef: null,
  mode: 'worker' as const,
  model: 'gpt-5-codex',
  agentTool: 'codex',
  title: 'Replay safety',
  nodeId: 'node-1',
  confirmUntrusted: false,
  clientMutationId: 'mutation-1',
};

describe('DbGraphPort execution.spawn replay marker', () => {
  it('returns replay metadata internally but never leaks it into CommandResult', async () => {
    const { graph, rpc } = graphReturning({
      entity: { id: SESSION_ID },
      patches: [{ id: SESSION_ID }],
      __tm8_replayed: true,
    });

    const result = await graph.createWorkSession({ identityId: 'identity-1' }, CREATE_INPUT);

    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.replayed).toBe(true);
    expect(result.commandResult).not.toHaveProperty('__tm8_replayed');
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0]?.[1]).toBe('public.execution_spawn');
  });

  it('treats a fresh database result as non-replayed', async () => {
    const { graph } = graphReturning({ entity: { id: SESSION_ID }, patches: [] });
    await expect(
      graph.createWorkSession({ identityId: 'identity-1' }, CREATE_INPUT),
    ).resolves.toMatchObject({ sessionId: SESSION_ID, replayed: false });
  });

  it('carries the immutable profile snapshot from resolution through the recorded pin', async () => {
    const snapshot = { profile: { source: 'spawn_override' }, composerPolicy: { density: 'compact' } };
    const rpc = vi.fn(async (_claims: unknown, fn: string) => {
      if (fn === 'internal.w2_resolve_interaction_profile_for_launch') {
        return {
          profileId: '44444444-4444-4444-8444-444444444444',
          profileVersion: 3,
          templateKey: 'tm8.chat.core',
          templateVersion: 1,
          resolvedHash: 'sha256:profile',
          source: 'spawn_override',
          snapshot,
        };
      }
      if (fn === 'internal.w2_record_interaction_profile_pin') {
        return {
          workSessionId: SESSION_ID,
          pinRevision: 2,
          profileId: '44444444-4444-4444-8444-444444444444',
          profileVersion: 3,
          templateKey: 'tm8.chat.core',
          templateVersion: 1,
          resolvedHash: 'sha256:profile',
          source: 'spawn_override',
          createdAt: '2026-07-29T12:00:00.000Z',
        };
      }
      throw new Error(`unexpected RPC ${fn}`);
    });
    const db = { rpc, tx: vi.fn(), query: vi.fn(), end: vi.fn() } as unknown as Db;
    const graph = new DbGraphPort(db);
    const auth = { identityId: 'identity-1' };
    const resolved = await graph.resolveInteractionProfile(auth, {
      spaceId: CREATE_INPUT.spaceId,
      teamMemberId: CREATE_INPUT.teamMemberId,
      interactionProfileId: '44444444-4444-4444-8444-444444444444',
    });
    const pin = await graph.recordInteractionProfilePin(auth, SESSION_ID, resolved);

    expect(pin).toMatchObject({
      profileId: '44444444-4444-4444-8444-444444444444',
      profileVersion: 3,
      templateKey: 'tm8.chat.core',
      templateVersion: 1,
      resolvedHash: 'sha256:profile',
      source: 'spawn_override',
      pinRevision: 2,
      snapshot,
    });
  });
});
