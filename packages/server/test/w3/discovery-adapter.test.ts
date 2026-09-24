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
        // -> {166/164/165/163} (2026-08-16, W4/132): spaces.taskWorkflows.*.
        // -> {169/167/168/166} (141): the three account-lifecycle ops.
        // -> {172/170/171/169} (148): spaces.workflows.*.
        // -> {197/195/195/193} (177): the 25 containers.* rows.
        // -> {198/196/196/194} (187): execution.sessions.share, one v1 POST.
        // `ws` is UNMOVED: sharing decides who may open the PTY socket, it
        // does not declare a second one.
        // NOTE `http` and `ws` are MOUNT counts: 24 of the 25 are HTTP, and
        // the 25th (`containers.stream`) re-declares `events.subscribe`'s
        // socket, so it adds a discoverable NAME and no mount — `ws` stays 1.
        // -> {198/196/196/194} (2026-09-19, Changes screen Phase 1):
        // `execution.gitStage`. One public v1 POST, mounted over HTTP with a
        // real facade handler, so ALL FOUR move together — it is a catalog row
        // (total), non-reserved (v1), a route (http) and registered (last).
        // `reserved` and `ws` are unmoved: it reserves nothing and opens no
        // socket. MEASURED from this assertion's own failing run, which printed
        // all four live values on `Received`; never hand-derived.
        // 198/196/196/194 -> 199/197/197/195 (2026-09-19, Changes screen Phase 1 INTEGRATED WITH main): main's execution.sessions.share and this
        // branch's execution.gitStage BOTH land, so this moves twice. Git merged
        // the number line silently — only the comment beside it conflicted. MEASURED on the merged tree from this assertion's own failing run.
        // reserved (2) and ws (1) are UNMOVED: neither new row is reserved,
        // and neither mounts a socket.
        // +9 skills.* rows (2026-09-23, #647 + #649). MEASURED.
        // +1 launch.suggest (Jev lane F, 2026-09-23): one mounted v1 POST, so all four move. MEASURED.
        // Jev lane K: +3 credentials.serviceKeys.* rows. MEASURED.
        // SC-3: +10 credentials.space.* / node.credentials.* rows, all mounted v1 HTTP. MEASURED.
        total: 240, /* +2 SC-8 share ops. MEASURED. */ /* +13 forms.* (Forms W1). MEASURED. */ // +1 spaces.configs (task 01a0d350). /* +1 entities.commands.tick (bug 01a0d2f1). MEASURED. */ /* +1 events.changes (change feed step 3). MEASURED. */
        v1: 238, /* +2 SC-8. MEASURED. */ /* +13 forms.* (Forms W1). MEASURED. */ // +1 spaces.configs (task 01a0d350). /* +1 entities.commands.tick (bug 01a0d2f1). MEASURED. */ /* +1 events.changes (change feed step 3). MEASURED. */
        reserved: 2,
        http: 238, /* +2 SC-8. MEASURED. */ /* +13 forms.* (Forms W1). MEASURED. */ // +1 spaces.configs (task 01a0d350). /* +1 entities.commands.tick (bug 01a0d2f1). MEASURED. */ /* +1 events.changes (change feed step 3). MEASURED. */
        ws: 1,
        registerableV1Http: 236, /* +2 SC-8. MEASURED. */ /* +13 forms.* (Forms W1). MEASURED. */ // +1 spaces.configs (task 01a0d350). /* +1 entities.commands.tick (bug 01a0d2f1). MEASURED. */ /* +1 events.changes (change feed step 3). MEASURED. */
      },
      nouns: expect.arrayContaining([
        { noun: 'edge', operationCount: 4 },
        { noun: 'project', operationCount: 19 },
        { noun: 'space', operationCount: 31 }, // +1 spaces.configs (task 01a0d350). +3 (148): spaces.workflows.*
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
