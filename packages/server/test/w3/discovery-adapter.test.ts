import { describe, expect, it } from 'vitest';

import { queryW3Discovery } from './discovery-adapter.js';

describe('W3 evaluator-owned generated discovery adapter', () => {
  it('validates the live catalog digest and exposes only bounded noun summaries at root', async () => {
    const response = await queryW3Discovery({ kind: 'root' });
    expect(response.catalogDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    // GENERATIONS, kept with cause: {101/99/100/98} (as authored, the
    // A01-A20 catalog) -> {102/100/101/99} (Delta 2 / A21:
    // `execution.liveness` joined `OPERATIONS`, +1 on total, v1, http and
    // registerableV1Http; reserved and ws unmoved).
    expect(response.result).toMatchObject({
      catalog: {
        // -> {121/119/120/118} (2026-08-01: execution.resume, spaces.counts,
        // execution.journal, identity.profile.update).
        // -> {127/124/126/122} (2026-08-02: the four auth.* rows, Stage 1).
        // -> {127/125/126/124} (2026-08-02: execution.launch + onboarding read).
        // -> {128/126/127/125} (2026-08-07: execution.transcript).
        // -> {129/127/128/126} (2026-08-09: projects.branches.list).
        // -> {131/129/130/128} (2026-08-09: projects.contention + entities.commands.gate).
        // -> {135/133/134/132}: the four credentials.* rows.
        // -> {137/135/136/134}: projects.files.list/attach.
        // -> {138/136/137/135} (2026-08-09, merge): execution.dispatch.
        total: 155,
        v1: 153,
        reserved: 2,
        http: 154,
        ws: 1,
        registerableV1Http: 152,
      },
      nouns: expect.arrayContaining([
        { noun: 'edge', operationCount: 4 },
        { noun: 'project', operationCount: 18 },
        { noun: 'space', operationCount: 23 },
      ]),
    });
    expect(JSON.stringify(response.result)).not.toContain('/v2/');
    expect(JSON.stringify(response.result)).not.toContain('packages/server/src');
  });

  it('pages one exact noun and requires a lazy exact-operation lookup for transport details', async () => {
    const noun = await queryW3Discovery({ kind: 'noun', noun: 'edge' });
    expect(noun.result).toEqual({
      noun: 'edge',
      items: [
        expect.objectContaining({ operation: 'edges.create' }),
        expect.objectContaining({ operation: 'edges.delete' }),
        expect.objectContaining({ operation: 'edges.list' }),
        expect.objectContaining({ operation: 'edges.patch' }),
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(noun.result)).not.toContain('/v2/');

    const operation = await queryW3Discovery({ kind: 'operation', operation: 'edges.create' });
    expect(operation.result).toEqual(expect.objectContaining({
      operation: 'edges.create',
      noun: 'edge',
      exposure: 'public',
      inputSchemaRef: 'CreateEdgeInputSchema',
      transport: {
        method: 'POST',
        path: '/v2/edges',
        catalogStatus: 'registered',
      },
    }));
    expect(JSON.stringify(operation.result)).not.toContain('packages/server/src');
  });

  it('refuses unknown nouns, unknown operations, and malformed cursor reuse', async () => {
    await expect(queryW3Discovery({ kind: 'noun', noun: 'not-a-noun' }))
      .rejects.toThrow('unknown discovery noun');
    await expect(queryW3Discovery({ kind: 'operation', operation: 'not.an.operation' }))
      .rejects.toThrow('unknown discovery operation');
    await expect(queryW3Discovery({ kind: 'noun', noun: 'edge', cursor: 'not-a-cursor' }))
      .rejects.toThrow('invalid noun discovery cursor');
  });
});
