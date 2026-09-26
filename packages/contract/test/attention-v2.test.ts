/**
 * Attention v2 S3-contract: the op shapes wave 3 (S4 server verbs, S5 UI)
 * builds against. Spec: chapter 1 (fields) and chapter 5 (Contract).
 */
import { describe, expect, it } from 'vitest';
import {
  ATTENTION_LEVEL_POINTS,
  AttentionRequestSchema,
  AttentionRequestMutationResultSchema,
  CreateAttentionRequestInputSchema,
  MarkAttentionSeenInputSchema,
  ResolveEntityAttentionInputSchema,
  UnresolveAttentionBatchInputSchema,
  WithdrawAttentionRequestInputSchema,
} from '../src/index.js';

const ID = '01a0de5f-c30f-7bcb-9de9-1950c26757a2';
const BATCH = '5b1d0a4e-3c1f-4f5e-9a51-2f0e8f0c9d11';
const AT = '2026-09-26T00:00:00.000Z';
const actor = { id: ID, kind: 'member', displayName: 'Ada', isAgent: false } as const;

/** A row exactly as today's server emits it: none of the v2 fields. */
const legacyRow = {
  id: BATCH, spaceId: ID, entityId: ID, reason: 'Pick retry policy', points: 40,
  status: 'open', version: 1, requestedBy: actor, acknowledgedBy: null, resolvedBy: null,
  resolutionNote: null, createdAt: AT, updatedAt: AT, acknowledgedAt: null, resolvedAt: null,
};

describe('attentionRequests.list row', () => {
  it('still validates a row from the current server (every v2 field is optional)', () => {
    expect(AttentionRequestSchema.safeParse(legacyRow).success).toBe(true);
  });

  it('carries the chapter 1 fields, with a chat or work session as the source', () => {
    const row = {
      ...legacyRow,
      status: 'cleared',
      seenByMe: false,
      rootId: ID,
      level: 'urgent',
      actionType: 'unblock',
      assigneeId: null,
      sourceWorkSessionId: ID,
      sourceSessionLive: true,
      origin: 'system',
      resolutionBatchId: null,
    };
    expect(AttentionRequestSchema.parse(row)).toEqual(row);
  });

  it('rejects an unknown level', () => {
    expect(AttentionRequestSchema.safeParse({ ...legacyRow, level: 'loud' }).success).toBe(false);
  });
});

describe('attentionRequests.create input', () => {
  it('needs only reason; points is an override, derived from level when omitted', () => {
    expect(CreateAttentionRequestInputSchema.safeParse({ clientMutationId: 'c', reason: 'r' }).success).toBe(true);
    expect(ATTENTION_LEVEL_POINTS).toEqual({ fyi: 10, normal: 40, high: 70, urgent: 95 });
  });

  it('accepts level, actionType and assigneeId', () => {
    const input = { clientMutationId: 'c', reason: 'r', level: 'high', actionType: 'approve', assigneeId: ID, points: 55 };
    expect(CreateAttentionRequestInputSchema.parse(input)).toEqual(input);
  });

  it.each(['sourceSessionId', 'sourceWorkSessionId', 'origin', 'signalKey'])(
    'never takes %s from the client: the server stamps it (F1a)',
    (field) => {
      const result = CreateAttentionRequestInputSchema.safeParse({ clientMutationId: 'c', reason: 'r', [field]: ID });
      expect(result.success).toBe(false);
    },
  );
});

describe('the v2 commands', () => {
  it('resolveEntity takes an optional client batch id, and the result echoes it', () => {
    expect(ResolveEntityAttentionInputSchema.safeParse({ clientMutationId: 'c', resolutionBatchId: BATCH }).success).toBe(true);
    expect(ResolveEntityAttentionInputSchema.safeParse({ clientMutationId: 'c', resolutionBatchId: 'nope' }).success).toBe(false);
    const result = { request: null, entity: {}, affectedCount: 2, resolutionBatchId: BATCH };
    // `entity` is a full summary; only the batch field is under test here.
    const shape = AttentionRequestMutationResultSchema.safeParse(result);
    expect(shape.success ? [] : shape.error.issues.map((issue) => issue.path[0])).not.toContain('resolutionBatchId');
  });

  it('markSeen and unresolve take only the command context', () => {
    expect(MarkAttentionSeenInputSchema.safeParse({ clientMutationId: 'c' }).success).toBe(true);
    expect(UnresolveAttentionBatchInputSchema.safeParse({ clientMutationId: 'c' }).success).toBe(true);
    expect(MarkAttentionSeenInputSchema.safeParse({ clientMutationId: 'c', status: 'open' }).success).toBe(false);
  });

  it('withdraw takes an optional expectedVersion', () => {
    expect(WithdrawAttentionRequestInputSchema.safeParse({ clientMutationId: 'c' }).success).toBe(true);
    expect(WithdrawAttentionRequestInputSchema.safeParse({ clientMutationId: 'c', expectedVersion: 3 }).success).toBe(true);
    expect(WithdrawAttentionRequestInputSchema.safeParse({ clientMutationId: 'c', expectedVersion: 0 }).success).toBe(false);
  });
});
