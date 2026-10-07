import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATIONS, WireErrorBodySchema } from '@tm8/contract';
import { startStubServer, stopStubServer } from '../../src/stub-server.js';

let stub: Server;
let baseUrl: string;

beforeAll(async () => {
  stub = await startStubServer(0);
  const address = stub.address();
  if (!address || typeof address === 'string') throw new Error('stub did not expose a TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await stopStubServer(stub);
});

function fixturePath(path: string): string {
  return path.replace(/:[A-Za-z][A-Za-z0-9]*/g, 'foundation-id');
}

describe('W1 stub route and honesty oracle', () => {
  it('recognizes all 165 HTTP catalog bindings as 501, never 404', async () => {
    const http = OPERATIONS.filter(({ method }) => method !== 'WS');
    // 162 -> 165 (W4/132): the three spaces.taskWorkflows routes.
    // 171 -> 195 (2026-09-03): the 24 HTTP containers.* rows. MEASURED.
    // 195 -> 196 (187): execution.sessions.share mounts one POST route.
    // 195 -> 196 (2026-09-19, Changes surface phase 1): execution.gitStage. MEASURED.
    // 196 -> 197 (2026-09-19, Changes screen Phase 1 INTEGRATED WITH main): main's execution.sessions.share and this
    // branch's execution.gitStage BOTH land, so this moves twice. Git merged
    // the number line silently — only the comment beside it conflicted. MEASURED on the merged tree from this assertion's own failing run.
    // 2026-09-23 (filesystem skills INTEGRATED WITH main): skills.scan/list/show/preview, all v1 HTTP (3 GET/read, 1 POST/command). MEASURED on the merged tree.
    // 2026-09-23 F4 (#648): skills.roots/create/edit/equip/unequip, all mounted v1 HTTP. MEASURED on the merged tree.
    // 206 -> 207 (Jev lane F): launch.suggest. MEASURED.
    expect(http).toHaveLength(356 /* +2 execution.gitCheckouts|gitCheckoutDiff (Changes for every session). MEASURED. */ /* +1 workspace.prompts.resolve (MW W3.1). MEASURED. */ /* +5 workspace.create|update|reorder|delete|switch (MW W2.1). MEASURED. */ /* +1 workspace.list (MW W1.2). MEASURED. */ /* +2 execution.complete, entities.commands.release (Spec D1, 302). MEASURED. */ /* +2 workspace.get|drafts.patch (Spec D). MEASURED. */ /* +3 workspace.instances.list|inspect|command (Spec C bridge). MEASURED. */ /* +1 spaceLinks.inbound.grant (W9c, 301). MEASURED. */ /* +3 credentials.space.share|unshare|shares (992). MEASURED. */ /* +15 styles (284). MEASURED. */ /* +3 entities.refs.list|add|remove (L3 cross-space refs, 279). MEASURED. */ /* +5 path grants (282). MEASURED. */ /* +4 spaceLinks.inbound.* (278, D2). MEASURED. */  /* +1 chat.setModel (276, chat model switch). MEASURED. */ /* +1 credentials.space.readiness (credentials r1 S7; base-relative). MEASURED. */ /* +1 execution.dispatchers (launch v3 C). MEASURED. */); /* +3 spaces.spacePassword.setRequired, spaces.members.spacePassword.reset|lock (W5). MEASURED. */ /* +2 attentionSignals.raise|clear (Attention v2 S6; stacked on tm8/attention-v2-integration). MEASURED. */ /* +6 servers.* (W8, 261). MEASURED. */ /* +2 spaceLinks.invoke/audit (W7, 260). MEASURED. */ /* +1 credentials.space.addMine (W10d). MEASURED. */ /* +7 spaceLinks.* (W6, 250/251). MEASURED. */ /* +1 node.metrics.get (status strip). MEASURED. */ /* W11: +4 (projects.link stays, decision 29) spaces.projects.list|create and gate.folders.list|create. MEASURED. */ /* +1 auth.space.enter (W3-server). MEASURED. */ /* +6 credentials.space.* (W10b). MEASURED. */ /* +3 spaces.leave, spaces.members.remove, accounts.disable (G6, 232). MEASURED. */ /* +2 spaces.chatDefaults.get/set (entity chat G). MEASURED. */ /* +1 launch.defaults (I9b). MEASURED. */ /* +2 forms.responses.redeliver, forms.pendingForSessions (Forms W3), on the merged tree. MEASURED. */ /* +2 entities.header.set/clear (headers I4). MEASURED. */ /* +13 forms.* (Forms W1). MEASURED. */ /* +1 spaces.configs (task 01a0d350). MEASURED. */ /* +1 entities.commands.tick (bug 01a0d2f1). MEASURED. */ /* +1 events.changes (change feed step 3). MEASURED. */ // +10 space/node credentials (SC-3). +3 service keys (Jev lane K). MEASURED. /* +2 auth.sessions.list/revoke (W4). MEASURED. */ /* -1 containers.attention (Attention v2 S7a). MEASURED. */ /* +3 attentionRequests.markSeen|unresolve|withdraw (Attention v2 S4; stacked on tm8/attention-v2-integration). MEASURED. */

    for (const operation of http) {
      const response = await fetch(new URL(fixturePath(operation.path), baseUrl), {
        method: operation.method,
      });
      expect(response.status, `${operation.name} must be route-reachable`).toBe(501);
      const parsed = WireErrorBodySchema.safeParse(await response.json());
      expect(parsed.success, `${operation.name} must use the contract error envelope`).toBe(true);
      if (parsed.success) expect(parsed.data.error.code).toBe('not_implemented');
    }
  });

  it('keeps the two reserved operations honest and unknown routes distinct', async () => {
    for (const operation of OPERATIONS.filter(({ status }) => status === 'reserved')) {
      const response = await fetch(new URL(fixturePath(operation.path), baseUrl), {
        method: operation.method,
      });
      expect(response.status).toBe(501);
    }

    const unknown = await fetch(new URL('/v2/not-a-catalog-route', baseUrl));
    expect(unknown.status).toBe(404);
    const parsed = WireErrorBodySchema.safeParse(await unknown.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.error.code).toBe('not_found');
  });
});
