import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { observeG15DatabaseOutcome } from '../agentic-observer.js';
import { queryW3Discovery } from '../discovery-adapter.js';
import {
  errorCode,
  startW3PublicServer,
  successData,
  type PublicJsonResponse,
  type W3PublicServer,
} from '../public-harness.js';

/**
 * G15 agentic gate: reserved + residual honesty.
 *
 * An agent that knows nothing but generated discovery must be able to establish
 * that the tm8 Server never fakes success for work it has not implemented, and
 * never partially applies that work before refusing. Every operation exercised
 * here is selected by navigating the discovery adapter (root -> noun -> operation)
 * and then observing the live production HTTP boundary. Nothing is hardcoded from
 * repository source.
 */

const CATALOG_DIGEST = 'sha256:df96ff5a4c2d11e41ec1d7b9c5e460bdcb8ae8d9c2c99b140f59e08305f8d604';
const FILLER_ID = '00000000-0000-4000-8000-000000000001';

interface DiscoveredOperation {
  operation: string;
  noun: string;
  exposure: string;
  reason: string | null;
  method: string;
  path: string;
  catalogStatus: string;
}

let harness: W3PublicServer;
let catalog: DiscoveredOperation[] = [];
let reserved: DiscoveredOperation[] = [];
/** Operations the live server honestly refuses, discovered by probing, not by reading source. */
let residual501: DiscoveredOperation[] = [];

/** Every discovery response must carry the pinned catalog digest. */
function digestChecked(response: unknown): any {
  const typed = response as { catalogDigest?: string; result?: unknown };
  expect(typed.catalogDigest).toBe(CATALOG_DIGEST);
  return typed.result;
}

/** Substitute concrete values for `:param` segments so a route can be reached. */
function concretePath(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment;
      return segment === ':kind' ? 'g15-probe-kind' : FILLER_ID;
    })
    .join('/');
}

/**
 * Assert the standard closed 501 envelope: honest code, joined request ID,
 * the operation named in the message, no `data`, and not retryable.
 */
function expectHonest501(response: PublicJsonResponse, operation: string): void {
  expect(response.status, `${operation} status`).toBe(501);
  // errorCode() itself enforces that the body request ID is present and equals
  // the x-tm8-request-id response header.
  expect(errorCode(response), `${operation} error code`).toBe('not_implemented');
  expect(response.body.data, `${operation} must not carry data`).toBeUndefined();
  expect(response.body.error?.message, `${operation} message names the operation`).toContain(operation);
  expect(response.body.error?.retryable, `${operation} retryable`).toBe(false);
  expect(response.contentType).toContain('application/json');
}

beforeAll(async () => {
  harness = await startW3PublicServer('g15_agentic');
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

describe('G15 reserved and residual honesty, via generated discovery only', () => {
  it('navigates root -> noun -> operation and finds exactly two reserved operations', async () => {
    const root = digestChecked(await queryW3Discovery({ kind: 'root' }));
    expect(root.catalog.total).toBe(101);
    expect(root.catalog.reserved).toBe(2);
    expect(root.nouns.length).toBeGreaterThan(0);

    const summaries: Array<{ noun: string; operation: string; exposure: string }> = [];
    for (const nounEntry of root.nouns) {
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const page = digestChecked(
          await queryW3Discovery({ kind: 'noun', noun: nounEntry.noun, cursor: cursor ?? undefined }),
        );
        expect(page.noun).toBe(nounEntry.noun);
        expect(page.items.length).toBeLessThanOrEqual(12);
        for (const item of page.items) {
          summaries.push({ noun: nounEntry.noun, operation: item.operation, exposure: item.exposure });
        }
        cursor = page.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(20);
      } while (cursor);
      const nounTotal = summaries.filter((entry) => entry.noun === nounEntry.noun).length;
      expect(nounTotal, `${nounEntry.noun} operation count`).toBe(nounEntry.operationCount);
    }
    expect(summaries.length).toBe(root.catalog.total);

    catalog = [];
    for (const summary of summaries) {
      const detail = digestChecked(await queryW3Discovery({ kind: 'operation', operation: summary.operation }));
      expect(detail.operation).toBe(summary.operation);
      expect(detail.noun).toBe(summary.noun);
      catalog.push({
        operation: detail.operation,
        noun: detail.noun,
        exposure: detail.exposure,
        reason: detail.reason,
        method: detail.transport.method,
        path: detail.transport.path,
        catalogStatus: detail.transport.catalogStatus,
      });
    }

    reserved = catalog.filter((entry) => entry.exposure === 'reserved');
    expect(reserved.map((entry) => entry.operation).sort()).toEqual(['bridge.fetchBlob', 'search.query']);
    for (const entry of reserved) {
      // Discovery is itself honest: it advertises the reason rather than hiding it.
      expect(entry.reason, `${entry.operation} reason`).toBe('not_implemented');
      expect(entry.catalogStatus, `${entry.operation} catalog status`).toBe('reserved');
    }
  }, 120_000);

  it('A: both reserved operations answer with a standard closed 501 not_implemented envelope', async () => {
    expect(reserved.length).toBe(2);
    for (const entry of reserved) {
      const response = await harness.request(entry.method, concretePath(entry.path));
      expectHonest501(response, entry.operation);
    }
  }, 120_000);

  it('B: residual v1 HTTP operations refuse pre-validation, across several nouns', async () => {
    // Classify the whole HTTP surface by live behaviour. The catalog claims every
    // v1 operation is "registered"; only the running server can say what is
    // actually wired, so the residual set is discovered, never assumed.
    const httpOperations = catalog.filter((entry) => entry.method !== 'WS');
    const observed: Array<{ entry: DiscoveredOperation; response: PublicJsonResponse }> = [];
    for (const entry of httpOperations) {
      // A deliberately invalid body: if the Server validated before refusing, an
      // unimplemented operation would leak a validation error instead of a 501.
      const invalidBody = entry.method === 'GET' || entry.method === 'DELETE'
        ? undefined
        : { g15DeliberatelyInvalid: true, spaceId: 12345, name: null };
      const response = await harness.request(entry.method, concretePath(entry.path), invalidBody);
      observed.push({ entry, response });
    }

    const refused = observed.filter(({ response }) => response.status === 501);
    for (const { entry, response } of refused) {
      expectHonest501(response, entry.operation);
    }

    residual501 = refused
      .map(({ entry }) => entry)
      .filter((entry) => entry.exposure !== 'reserved');
    expect(residual501.length, 'residual unimplemented HTTP operations').toBeGreaterThanOrEqual(6);
    const residualNouns = new Set(residual501.map((entry) => entry.noun));
    expect(residualNouns.size, 'residual operations span several nouns').toBeGreaterThanOrEqual(3);

    // Pre-validation specifically: the operations that received the invalid body
    // still returned 501 rather than a validation error.
    const refusedWithInvalidBody = refused.filter(
      ({ entry }) => entry.method !== 'GET' && entry.method !== 'DELETE',
    );
    expect(refusedWithInvalidBody.length, 'invalid-body refusals').toBeGreaterThanOrEqual(6);
    for (const { response, entry } of refusedWithInvalidBody) {
      expect(errorCode(response), `${entry.operation} must not leak validation`).toBe('not_implemented');
    }

    // Corroborate the discovered split against the Server's own liveness report.
    // /health is infrastructure and deliberately outside the {data, requestId}
    // envelope, so its bare body is read directly.
    const health = await fetch(new URL('/health', harness.baseUrl));
    expect(health.status).toBe(200);
    const liveness = await health.json() as { operations: number; implemented: number };
    expect(liveness.operations).toBe(httpOperations.length);
    expect(liveness.operations - liveness.implemented).toBe(refused.length);
  }, 180_000);

  it('C0: calibrates the oracle - a real implemented mutation IS observable', async () => {
    // Without this, "no ledger row was written" could pass vacuously because the
    // oracle looks in the wrong place. Prove the oracle can see a write first.
    const clientMutationId = randomUUID();
    const before = await observeG15DatabaseOutcome(harness, [clientMutationId]);
    const created = await harness.request('POST', '/v2/spaces', {
      clientMutationId,
      name: 'g15 oracle calibration',
    });
    expect(created.status, `spaces.create -> ${JSON.stringify(created.body)}`).toBe(201);
    // successData enforces the success envelope and the request ID header join.
    expect(successData(created)).toBeDefined();
    const after = await observeG15DatabaseOutcome(harness, [clientMutationId]);
    expect(after.ledgerEntriesForClientMutationIds).toEqual([
      { clientMutationId, operation: 'spaces.create' },
    ]);
    expect(after.totalCommandLedgerRows).toBe(before.totalCommandLedgerRows + 1);
    expect(after.totalEntityRows).toBeGreaterThan(before.totalEntityRows);
  }, 120_000);

  it('C: a 501 produces zero database effect - no ledger reservation, no rows', async () => {
    expect(residual501.length).toBeGreaterThanOrEqual(6);
    // Send real client mutation IDs so this is a genuine test of whether the
    // Server reserves a mutation ID or writes a ledger row before refusing.
    const commandTargets = residual501.filter((entry) => entry.method !== 'GET').slice(0, 6);
    expect(commandTargets.length).toBeGreaterThanOrEqual(4);
    const attempts: Array<{ operation: string; clientMutationId: string }> = [];
    const plan = [
      ...reserved.map((entry) => ({ entry, viaQuery: true })),
      ...commandTargets.map((entry) => ({ entry, viaQuery: false })),
    ];
    for (const { entry } of plan) {
      attempts.push({ operation: entry.operation, clientMutationId: randomUUID() });
    }

    const before = await observeG15DatabaseOutcome(
      harness,
      attempts.map((attempt) => attempt.clientMutationId),
    );
    expect(before.ledgerEntriesForClientMutationIds).toEqual([]);

    for (const [index, { entry, viaQuery }] of plan.entries()) {
      const clientMutationId = attempts[index]!.clientMutationId;
      const path = concretePath(entry.path);
      const response = viaQuery
        // The reserved operations are GET-bound, so the mutation ID rides the query string.
        ? await harness.request(entry.method, `${path}?clientMutationId=${clientMutationId}`)
        : await harness.request(entry.method, path, {
          clientMutationId,
          spaceId: FILLER_ID,
          entityId: FILLER_ID,
          name: 'g15 honesty probe',
          body: 'g15 honesty probe',
        });
      expectHonest501(response, entry.operation);
    }

    const after = await observeG15DatabaseOutcome(
      harness,
      attempts.map((attempt) => attempt.clientMutationId),
    );

    // The central claim: honest refusal is total. Nothing was reserved and
    // nothing was partially applied.
    expect(after.ledgerEntriesForClientMutationIds, 'no mutation ID may be reserved by a 501').toEqual([]);
    expect(after.totalCommandLedgerRows).toBe(before.totalCommandLedgerRows);
    expect(after.totalEntityRows).toBe(before.totalEntityRows);
    expect(after.totalEdgeRows).toBe(before.totalEdgeRows);
  }, 180_000);

  it('D: events.subscribe is WS-only and never answers over plain HTTP', async () => {
    const detail = digestChecked(await queryW3Discovery({ kind: 'operation', operation: 'events.subscribe' }));
    expect(detail.transport.method).toBe('WS');
    expect(detail.transport.path).toBe('/v2/ws');

    for (const method of ['GET', 'POST']) {
      const response = await fetch(new URL('/v2/ws', harness.baseUrl), { method });
      expect(response.status, `plain HTTP ${method} /v2/ws`).toBe(404);
      const body = await response.json() as { error?: { code?: string }; data?: unknown };
      expect(body.error?.code).toBe('not_found');
      expect(body.data, 'a WS-only operation must never answer with HTTP data').toBeUndefined();
    }
  }, 120_000);

  it('E: an unknown path is 404 not_found, distinct from 501 not_implemented', async () => {
    for (const path of ['/v2/definitely-not-a-real-route', '/v2/spaces/' + FILLER_ID + '/not-a-real-subresource']) {
      const response = await harness.request('GET', path);
      expect(response.status).toBe(404);
      expect(errorCode(response)).toBe('not_found');
    }
    // Honest unavailability and honest nonexistence must not be conflated.
    const reservedResponse = await harness.request('GET', '/v2/search');
    expect(reservedResponse.status).toBe(501);
    expect(errorCode(reservedResponse)).toBe('not_implemented');
  }, 120_000);

  it('F: no workaround makes a reserved operation actually work', async () => {
    const clientMutationIds = [randomUUID(), randomUUID(), randomUUID()];
    const before = await observeG15DatabaseOutcome(harness, clientMutationIds);

    const workarounds: Array<{ label: string; method: string; path: string; body?: unknown }> = [
      { label: 'alternate method on the reserved search path', method: 'POST', path: '/v2/search', body: { q: 'task', clientMutationId: clientMutationIds[0] } },
      { label: 'another alternate method', method: 'PUT', path: '/v2/search', body: { q: 'task', clientMutationId: clientMutationIds[1] } },
      { label: 'trailing-slash near miss', method: 'GET', path: '/v2/search/' },
      { label: 'alternate casing', method: 'GET', path: '/v2/Search' },
      { label: 'query parameters on the reserved route', method: 'GET', path: '/v2/search?q=task&limit=5' },
      { label: 'alternate method on the reserved bridge path', method: 'POST', path: `/v2/bridge/blobs/${FILLER_ID}`, body: { clientMutationId: clientMutationIds[2] } },
      { label: 'bridge trailing-slash near miss', method: 'GET', path: `/v2/bridge/blobs/${FILLER_ID}/` },
      { label: 'bridge without the id segment', method: 'GET', path: '/v2/bridge/blobs' },
    ];

    for (const workaround of workarounds) {
      const response = await harness.request(workaround.method, workaround.path, workaround.body);
      // The only honest answers are "not implemented" or "no such route".
      expect(response.status, workaround.label).toBeGreaterThanOrEqual(400);
      expect([404, 501], workaround.label).toContain(response.status);
      expect(['not_found', 'not_implemented'], workaround.label).toContain(errorCode(response));
      expect(response.body.data, `${workaround.label} must not return results`).toBeUndefined();
    }

    const after = await observeG15DatabaseOutcome(harness, clientMutationIds);
    expect(after.ledgerEntriesForClientMutationIds, 'no workaround may reserve a mutation ID').toEqual([]);
    expect(after.totalCommandLedgerRows).toBe(before.totalCommandLedgerRows);
    expect(after.totalEntityRows).toBe(before.totalEntityRows);
    expect(after.totalEdgeRows).toBe(before.totalEdgeRows);
  }, 120_000);
});
