/**
 * W5 · DUO F · TESTER — is the CLI's `observed` availability source SOUND?
 *
 * WHAT IS UNDER TEST IS NOT THIS SERVER. It is a claim the CLI makes ABOUT this
 * server, stated twice in production source and load-bearing for the entire
 * per-operation availability projection:
 *
 *   packages/cli/src/discovery/availability.ts:26-29
 *     "an honest 501 IS the per-operation signal ... Any other outcome —
 *      success or any other refusal — proves a handler exists."
 *   packages/cli/src/discovery/observe.ts:9-12
 *     "Every other outcome — a success, a `forbidden`, a `version_conflict` —
 *      proves a handler exists and is recorded as `handled`."
 *   packages/cli/src/discovery/observe.ts:51
 *     into.record(name, err.code === 'not_implemented' ? 'not_implemented' : 'handled');
 *
 * `handled` resolves to `availability: 'available'` (availability.ts:234-240),
 * which `tm8 help` renders to an agent as `[available]` (commands/help.ts:118).
 *
 * THE CLAIM IS A CLAIM ABOUT PIPELINE ORDER. It is true only if EVERY refusal
 * this server can emit is decided AFTER handler lookup. `http/server.ts:6-17`
 * documents the order and `:108-186` implements it:
 *
 *      step 2  :116  checkTransport            refusal — BEFORE handler lookup
 *      step 5  :156  readJsonBody              refusal — BEFORE handler lookup
 *      step 6  :158  router.match              refusal — BEFORE handler lookup
 *      step 7  :161  resolveIdentity           refusal — BEFORE handler lookup
 *      step 8  :163  registry.get -> 501       <-- handler lookup
 *      step 9  :166  zod validate              refusal — after
 *
 * THIS FILE DOES NOT ASSERT THE CLI'S BEHAVIOUR. It cannot: `@tm8/server` does
 * not depend on `@tm8/cli` (packages/server/package.json), so the CLI half is
 * cited, not measured, and is stated as UNMEASURED HERE in every place it is
 * relied on. What this file measures is the ONE server-side fact the claim
 * rests on: whether a response to an operation WITH NO HANDLER can be
 * indistinguishable from a response to an operation WITH one.
 *
 * WHAT THIS FILE CAN BE SATISFIED BY, stated before what it asserts:
 *   - It can be satisfied by a server that refuses everything for a reason
 *     unrelated to overflow. The two positive controls exist to exclude that
 *     and they run FIRST.
 *   - It is evidence about `payload_too_large` and malformed-JSON ONLY. It is
 *     NOT evidence that any other refusal class is mis-ordered, and it is NOT
 *     evidence that any CLI call site has ever hit this path.
 *   - A green here does NOT mean the projection is sound; it means these two
 *     classes behaved as measured.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OPERATIONS, type OperationName } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HandlerRegistry } from '../../../src/facade/registry.js';
import type { ServerConfig } from '../../../src/http/config.js';
import {
  checkCsrf,
  checkHost,
  checkOrigin,
  checkTransport,
} from '../../../src/http/security.js';
import { createFacadeServer, type FacadeServer } from '../../../src/http/server.js';

const ROUTE_PARAM = '00000000-0000-7000-8000-000000000015';

/**
 * FROZEN LITERALS (§6). These two rows are read from the catalog and compared
 * against the literals below, so a catalog move is a LOUD red here rather than
 * a silent change of what this file measures.
 */
/**
 * MOUNTED must have NO `INPUT_SCHEMAS` entry, or `{}` is refused at step 9 and
 * the control cannot show a handler running. My first fixture used
 * `spaces.create`, which HAS a schema; CONTROL 1 went red on 400 vs the
 * expected 200 and caught my fixture rather than the product. Recorded as a
 * self-caught false red, not a finding.
 *
 * `interactionProfiles.*` are the ONLY v1 POST rows with no schema entry
 * (derived by set-difference over catalog.ts POST rows and input-schemas.ts
 * keys, 2026-07-27). The production handler for this row is irrelevant here —
 * this fixture registers its own trivial handler.
 */
const MOUNTED = {
  name: 'interactionProfiles.validate',
  method: 'POST',
  path: `/v2/interaction-profiles/${ROUTE_PARAM}/validate`,
  catalogPath: '/v2/interaction-profiles/:profileId/validate',
} as const;
/**
 * UNMOUNTED deliberately DOES have a schema (`CreateEntityInputSchema`). That
 * is a second fact for free: if it answers 501 to a body its schema would
 * reject, handler lookup provably precedes validation for a NON-RESERVED v1
 * row. `test/w2/reserved-honesty.test.ts:211-240` proves that ordering only for
 * the two RESERVED rows.
 */
const UNMOUNTED = {
  name: 'entities.create',
  method: 'POST',
  path: '/v2/entities',
  catalogPath: '/v2/entities',
} as const;

/**
 * Small on purpose. The overflow must land BETWEEN the cap and
 * `OVERFLOW_DRAIN_FACTOR * cap` (http/body.ts:33,48-51): past 4x the socket is
 * destroyed and the caller sees a transport failure instead of a 413.
 *
 * THAT BOUND IS PART OF THE FINDING, not an incidental fixture detail. A
 * TransportError teaches the ledger NOTHING by design (observe.ts:53-56), so
 * the DANGEROUS overflow is the MODEST one — the one that is still polite
 * enough to get an answer.
 */
const MAX_BODY_BYTES = 256;
const MODEST_OVERFLOW = 'x'.repeat(600); // 602 bytes as JSON: > 256, < 1024

interface Probe {
  status: number;
  code: string | null;
  requestId: string | null;
}

async function probe(baseUrl: string, path: string, body: string): Promise<Probe> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  let code: string | null = null;
  try {
    const parsed = (await response.json()) as { error?: { code?: unknown } };
    code = typeof parsed.error?.code === 'string' ? parsed.error.code : null;
  } catch {
    code = null;
  }
  return { status: response.status, code, requestId: response.headers.get('x-tm8-request-id') };
}

describe('W5.F observation soundness — a refusal decided before handler lookup', () => {
  let dataDir: string;
  let server: FacadeServer;
  let baseUrl: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-w5f-obs-'));
    const config: ServerConfig = {
      host: '127.0.0.1',
      port: 0,
      uiDir: undefined,
      maxBodyBytes: MAX_BODY_BYTES,
      databaseUrl: undefined,
      dataDir,
      fileMaxSizeBytes: 4096,
    };
    const registry = new HandlerRegistry();
    // EXACTLY ONE handler. The asymmetry IS the instrument: everything below
    // compares a route that has one against a route that does not.
    registry.register(MOUNTED.name as OperationName, () => ({}));

    server = createFacadeServer({
      config,
      registry,
      identityResolver: async () => ({ kind: 'auto-owner', identityId: ROUTE_PARAM }),
    });
    baseUrl = (await server.listen()).url;
  }, 30_000);

  afterAll(async () => {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }, 30_000);

  it('CONTROL 0 — the two catalog rows are still the rows this file was written against', () => {
    for (const expected of [MOUNTED, UNMOUNTED]) {
      const row = OPERATIONS.find((o) => o.name === expected.name);
      expect(row, `${expected.name} left the catalog`).toBeDefined();
      expect({ name: row!.name, method: row!.method, path: row!.path }).toEqual({
        name: expected.name,
        method: expected.method,
        path: expected.catalogPath,
      });
      expect(row!.status, `${expected.name} must be v1`).toBe('v1');
    }
  }, 15_000);

  it('CONTROL 1 — under the cap the two routes are DISTINGUISHABLE: 200 vs 501', async () => {
    const mounted = await probe(baseUrl, MOUNTED.path, '{}');
    const unmounted = await probe(baseUrl, UNMOUNTED.path, '{}');

    // Green-on-known-good half. If this fails the instrument is broken and
    // NOTHING below is evidence about the product.
    expect(mounted.status, 'the registered handler must run').toBe(200);
    expect(unmounted.status, 'DEV-13: an unbuilt operation answers 501').toBe(501);
    expect(unmounted.code).toBe('not_implemented');
    expect(mounted.status).not.toBe(unmounted.status);

    // Free second fact: `{}` fails `CreateEntityInputSchema`, so a 501 here
    // proves handler lookup (server.ts:163) runs BEFORE zod validation
    // (server.ts:166) for a NON-RESERVED v1 row. reserved-honesty.test.ts
    // proves this only for the two reserved rows.
    expect(unmounted.code, 'validation must not pre-empt the honest 501').not.toBe('invalid_input');
  }, 30_000);

  it('CONTROL 2 — the unmounted route really has no handler and the mounted one really does', async () => {
    // A second, independent reading of the same asymmetry through a different
    // observable (the error code rather than the status), so CONTROL 1 is not
    // the only thing standing between a broken fixture and a filed finding.
    const unmounted = await probe(baseUrl, UNMOUNTED.path, '{}');
    expect(unmounted.code).toBe('not_implemented');
    const mounted = await probe(baseUrl, MOUNTED.path, '{}');
    expect(mounted.code, 'a handler that ran emits no error code').toBeNull();
  }, 30_000);

  it('MEASUREMENT — a modest oversized body makes the two routes INDISTINGUISHABLE', async () => {
    const mounted = await probe(baseUrl, MOUNTED.path, JSON.stringify(MODEST_OVERFLOW));
    const unmounted = await probe(baseUrl, UNMOUNTED.path, JSON.stringify(MODEST_OVERFLOW));

    // Both refused before the router and before handler lookup (server.ts:156).
    expect(mounted.status).toBe(413);
    expect(mounted.code).toBe('payload_too_large');
    expect(unmounted.status).toBe(413);
    expect(unmounted.code).toBe('payload_too_large');

    // THE FINDING, in one assertion: the response carries ZERO information
    // about whether a handler exists...
    expect(
      { status: unmounted.status, code: unmounted.code },
      'an operation with NO handler answered identically to one WITH a handler',
    ).toEqual({ status: mounted.status, code: mounted.code });

    // ...and it is NOT `not_implemented`, which is the only outcome the CLI
    // treats as evidence of absence (observe.ts:51). Every other outcome is
    // recorded `handled` and resolves to `available` (availability.ts:234-240).
    //
    // UNMEASURED HERE: that the CLI actually records it. This file cannot
    // import @tm8/cli. The mapping is a citation, not a measurement, and needs
    // a probe under a CLI-owned test path.
    expect(unmounted.code).not.toBe('not_implemented');
  }, 30_000);

  it('MEASUREMENT — malformed JSON is the same shape of blindness at 400', async () => {
    const mounted = await probe(baseUrl, MOUNTED.path, '{not json');
    const unmounted = await probe(baseUrl, UNMOUNTED.path, '{not json');

    expect(mounted.status).toBe(400);
    expect(mounted.code).toBe('invalid_input');
    expect(unmounted.status).toBe(400);
    expect(unmounted.code).toBe('invalid_input');
    expect({ status: unmounted.status, code: unmounted.code }).toEqual({
      status: mounted.status,
      code: mounted.code,
    });
    expect(unmounted.code).not.toBe('not_implemented');
  }, 30_000);

  it('SCOPE — a body UNDER the cap still discriminates, so the blindness is overflow-specific', async () => {
    // The red half must not be reachable by "this server refuses everything".
    // Re-run CONTROL 1's comparison AFTER the overflow probes, so an ordering
    // artefact in the fixture cannot masquerade as the finding.
    const mounted = await probe(baseUrl, MOUNTED.path, '{}');
    const unmounted = await probe(baseUrl, UNMOUNTED.path, '{}');
    expect(mounted.status).toBe(200);
    expect(unmounted.status).toBe(501);
  }, 30_000);

  it('SELF-TEST — remove the registry asymmetry and the discrimination disappears', async () => {
    // Both-halves control on THIS FILE'S instrument, not on the product. If
    // CONTROL 1's 200-vs-501 came from the two PATHS rather than from the
    // registry, it would survive here. It must not.
    const bare = createFacadeServer({
      config: {
        host: '127.0.0.1',
        port: 0,
        uiDir: undefined,
        maxBodyBytes: MAX_BODY_BYTES,
        databaseUrl: undefined,
      },
      registry: new HandlerRegistry(), // nothing registered
      identityResolver: async () => ({ kind: 'auto-owner', identityId: ROUTE_PARAM }),
    });
    const url = (await bare.listen()).url;
    try {
      const mounted = await probe(url, MOUNTED.path, '{}');
      const unmounted = await probe(url, UNMOUNTED.path, '{}');
      expect(mounted.status, 'with no handler, the "mounted" path is 501 too').toBe(501);
      expect(unmounted.status).toBe(501);
      expect(mounted.status).toBe(unmounted.status);
    } finally {
      await bare.close();
    }
  }, 30_000);
});

/**
 * A CAUSATION PIN WITH ITS DISPOSITION WRITTEN AT THE SAME TIME AS THE PIN
 * (standing orders §3d). This one is unusual: it is GREEN today and is
 * DESIGNED TO GO RED when a REQUIRED change lands. It is not asserting a
 * defect; it is asserting the precondition that currently keeps a documented
 * contradiction harmless.
 *
 * THE CONTRADICTION, already written into two shipped files:
 *
 *   src/http/security.ts:48       a transport refusal is `{ code: 'forbidden' }`
 *   src/http/server.ts:116-117    checkTransport runs at STEP 2 — before routing,
 *                                 before identity, before handler lookup (:163)
 *   cli/src/discovery/availability.ts:106-108
 *                                 "`forbidden` means a handler ran and said no"
 *   cli/src/discovery/observe.ts:10-11
 *                                 lists `forbidden` as proof a handler exists
 *
 * Those cannot both be right. They are harmless ONLY because `checkHost`,
 * `checkOrigin` and `checkCsrf` are deferred no-ops (`security.ts:14-40`) and
 * no `forbidden` can currently originate at step 2.
 *
 * `security.ts:34-39` states S2/S3/S4/S6 "must not ship to G1A unclosed". So
 * the precondition is scheduled to expire.
 *
 * DISPOSITION, authored now, for the moment this pin goes red:
 *   The correct repair is NOT to re-pin this test. It is to narrow the CLI's
 *   rule so that only refusals decided AFTER handler lookup are recorded
 *   `handled` — today that is the zod `invalid_input` at server.ts:166 and
 *   anything a handler itself throws. When that lands, convert this test from
 *   asserting the no-ops to asserting the narrowed rule, so the file keeps a
 *   regression guard instead of leaving an unexplained red.
 *
 * WHAT IT CAN BE SATISFIED BY: it is satisfied by the three checks returning an
 * object with no `refusal` key, for the specific inputs below. It is NOT proof
 * that no other code path can emit `forbidden` before step 8, and it is NOT
 * evidence about any CLI behaviour — that half is cited, never measured here.
 */
describe('W5.F scheduled inversion — `forbidden` is a PRE-handler refusal slot', () => {
  it('is inert TODAY: all three transport checks allow everything', () => {
    const config = {
      host: '127.0.0.1',
      port: 0,
      uiDir: undefined,
      maxBodyBytes: MAX_BODY_BYTES,
      databaseUrl: undefined,
    } as ServerConfig;
    const hostile = {
      host: 'evil.example.com',
      origin: 'https://evil.example.com',
      cookie: 'tm8_session=x',
    };

    for (const [label, decision] of [
      ['S2 host', checkHost(hostile, config)],
      ['S3/S4 origin', checkOrigin(hostile, config)],
      ['S6 csrf', checkCsrf('POST', hostile, config)],
      ['composed', checkTransport('POST', hostile, config)],
    ] as const) {
      expect(
        decision.refusal,
        `${label} now REFUSES. Read this file's disposition block before touching it: `
          + 'a step-2 `forbidden` is recorded by the CLI as `handled` '
          + '(cli/src/discovery/observe.ts:51) and resolves to `available` '
          + '(cli/src/discovery/availability.ts:234-240) for operations this node '
          + 'may not implement. Narrow the CLI rule, do not re-pin this test.',
      ).toBeUndefined();
    }
  }, 15_000);
});
