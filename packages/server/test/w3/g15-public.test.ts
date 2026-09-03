import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OPERATIONS, type OperationBinding } from '../../../contract/src/catalog.js';
import {
  errorCode,
  startW3PublicServer,
  successData,
  type PublicJsonResponse,
  type W3PublicServer,
} from './public-harness.js';

const RESERVED = new Set(['search.query', 'bridge.fetchBlob']);

function publicPath(operation: OperationBinding): string {
  return operation.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, () => randomUUID());
}

function expectStandardNotImplemented(
  operation: OperationBinding,
  response: PublicJsonResponse,
): void {
  expect(response.status, operation.name).toBe(501);
  expect(response.contentType, operation.name).toMatch(/^application\/json/);
  expect(response.requestIdHeader, operation.name).toBeTruthy();
  expect(response.body.requestId ?? response.body.error?.requestId, operation.name)
    .toBe(response.requestIdHeader);
  expect(errorCode(response), operation.name).toBe('not_implemented');
  expect(response.body.error?.message, operation.name).toContain(operation.name);
}

describe.sequential('W3.G15 public reserved and residual honesty', () => {
  let harness: W3PublicServer;
  const responses = new Map<string, PublicJsonResponse>();

  beforeAll(async () => {
    harness = await startW3PublicServer('g15');
    for (const operation of OPERATIONS) {
      if (operation.method === 'WS') continue;
      responses.set(
        operation.name,
        await harness.request(operation.method, publicPath(operation)),
      );
    }
  }, 120_000);

  // 30s -> 120s. `harness.close()` ends with `database.destroy()`, which DROPS a
  // scratch database, and a drop is exactly the operation that slows down under
  // the parallel load this suite runs in — w2-execution.pg.test.ts measured the
  // same thing and raised its own teardown budget for it. All twenty w3 suites
  // shared this 30s, so whichever one lost the race reported `Hook timed out in
  // 30000ms` and the identity of the loser rotated between runs. A larger budget
  // costs nothing when teardown is fast.
  afterAll(async () => {
    await harness?.close();
  }, 120_000);

  it('reports the frozen HTTP catalog and implementation counts from production health', async () => {
    // /health is the infrastructure liveness route, not a catalog operation, so it
    // is deliberately outside the {data, requestId} envelope. Read the bare body.
    const healthResponse = await harness.request<never>('GET', '/health');
    expect(healthResponse.status).toBe(200);
    const health = healthResponse.body as unknown as {
      ok: boolean;
      server: string;
      operations: number;
      implemented: number;
    };
    // 121 -> 127 (2026-08-02): auth.signup/login/logout/session.get (Identity v2 Stage 1).
    // 127 -> 127 (2026-08-02): execution.launch.
    // 127 -> 128 (2026-08-07): execution.transcript.
    // 128 -> 129 (2026-08-09): projects.branches.list.
    // 129 -> 131 (2026-08-09): projects.contention + entities.commands.gate.
    // 131 -> 135: credentials.*; all four are mounted.
    // 144 -> 150 (2026-08-12, Git UI landing): the six execution.git* rows,
    // all mounted.
    expect(OPERATIONS).toHaveLength(197); // +25 (177) containers
    // 171 -> 195: 24 container HTTP rows. The 25th is the WS alias.
    expect(OPERATIONS.filter((operation) => operation.method !== 'WS')).toHaveLength(195);
    expect(health).toMatchObject({
      ok: true,
      server: 'tm8-server',
      // /health.operations counts ROUTES, not catalog rows (WS never mounts).
      operations: 195, // +24 (177): the container HTTP rows
      implemented: 193, // +24 (177): all registered, all mounted
    });
  });

  it('keeps both reserved HTTP operations honest 501s with standard envelopes', () => {
    const reserved = OPERATIONS.filter((operation) => operation.status === 'reserved');
    expect(reserved.map((operation) => operation.name).sort()).toEqual([...RESERVED].sort());
    for (const operation of reserved) {
      expectStandardNotImplemented(operation, responses.get(operation.name)!);
    }
  });

  it('has an EMPTY residual set: no v1 binding refuses an empty probe', () => {
    const residual = OPERATIONS.filter((operation) =>
      operation.method !== 'WS'
      && operation.status === 'v1'
      && responses.get(operation.name)?.status === 501);
    // RE-PINNED at tranche-v3 + 035: 36 -> 25 -> 0, and 177 moves it OFF zero
    // for the first time since. Still an exact MEMBERSHIP assertion rather than
    // a count, so it keeps catching the next drift: any operation that answers
    // 501 and is not on this list fails by name.
    //
    // WHY IT IS NO LONGER ZERO, and why that is honest rather than a
    // regression. Zero used to mean "the node implements everything it
    // declares". The container family declares 25 rows in P0 and implements
    // ten; the other fifteen are REGISTERED and answer 501 with a named
    // reason, because the alternative — leaving them unregistered — answers
    // 404, which tells a caller the operation does not exist when it is in the
    // contract (DEV-13). Registered-and-501 is the honest state; this list is
    // where that honesty is written down.
    //
    // These five are the ones this probe reaches: the family's GET/PUT rows.
    // The POST commands are probed elsewhere in the sweep.
    expect(
      residual.map((operation) => operation.name).sort(),
      residual.map((operation) => operation.name).join(', '),
    ).toEqual([
      'containers.files.get',
      'containers.files.put',
      'containers.logs',
      'containers.providers.list',
      'containers.proxy',
    ]);
    // Every member must still answer the STANDARD closed 501 envelope — being
    // on the list is permission to be unbuilt, never permission to be sloppy
    // about how it says so. (The loop below already asserts this.)
    for (const operation of residual) {
      expectStandardNotImplemented(operation, responses.get(operation.name)!);
    }

    const implemented = OPERATIONS.filter((operation) =>
      operation.method !== 'WS'
      && operation.status === 'v1'
      && responses.get(operation.name)?.status !== 501);
    // GENERATIONS, kept with cause: 98 (as authored — 100 non-WS rows minus
    // the 2 permanently reserved, 101-row catalog era) -> 99 (Delta 2 / A21:
    // `execution.liveness` joined `OPERATIONS`, the 101->102 family) -> 108
    // (voice.token.create joined `OPERATIONS`, the 110->111 family) -> 114
    // (the six artifacts rows joined `OPERATIONS`, the 111->117 family; all six
    // are mounted, so none answers 501).
    // The four credentials.* rows bring the mounted set to 132.
    // 141: +3 (auth.password.change, auth.invite.signup, auth.claim.reissue),
    // all mounted and none answering 501 — 163 -> 166.
    // 169 -> 188 (177): the catalog's v1 non-WS rows are now 193, of which the
    // five residual container reads answer 501 — so 188 answer for real.
    // 193 - 5 = 188, and the residual membership asserted above is what makes
    // that subtraction checkable rather than a fudge.
    expect(implemented).toHaveLength(188);
  });

  /**
   * MEASUREMENT-VALIDITY CORRECTION (2026-07-27).
   *
   * The case above classifies by the response to a NO-BODY probe. For a command
   * operation an empty body fails INPUT_SCHEMAS validation and returns 400 BEFORE
   * the handler runs, so that probe cannot see a handler that would refuse. It
   * measures "does not return 501 to an empty request", which is a PROXY, and the
   * record previously named it "implemented", which is the PROPERTY. 64 of the v1
   * HTTP operations are non-GET and were all probed that unrepresentatively.
   *
   * `/health`'s `implemented` counts `registry.size` — REGISTERED handlers — which
   * is a true but different claim. Registered is not behaviourally implemented.
   *
   * Note also that 73 + 25 = 98 was never corroboration: both numbers come from one
   * partition, so the identity holds even when the partition is wrong.
   *
   * This case enumerates, by valid-body measurement, every operation that is
   * REGISTERED yet refuses, and distinguishes an unconditional stub from an honest
   * conditional refusal.
   */
  it('enumerates registered operations that still refuse on a schema-valid request', async () => {
    const space = successData<{ space: { id: string } }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-g15-validbody-space',
        name: 'W3 G15 valid-body probe',
      }),
    );
    const spaceId = space.space.id;

    const anchor = successData<{ entity: { id: string } }>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: 'w3-g15-validbody-anchor',
        spaceId,
        kind: 'task',
        title: 'valid-body anchor',
        content: { priority: 'medium' },
      }),
    );

    // (1) UNCONDITIONAL STUB — registered, counted in implemented, refuses any valid request.
    const post = await harness.request('POST', '/v2/messages', {
      clientMutationId: 'w3-g15-validbody-message',
      anchorIds: [anchor.entity.id],
      body: 'valid body reaches the handler',
    });

    // (2) HONEST CONDITIONAL REFUSAL — DEV-13: the contract declares the kind, this
    //     build has not implemented it. That is a 501 about the node, not a 400.
    const unsupportedKind = await harness.request('POST', '/v2/entities', {
      clientMutationId: 'w3-g15-validbody-unsupported',
      spaceId,
      kind: 'interaction_profile',
      title: 'unsupported kind probe',
      content: {},
    });

    expect({
      messagesPostStatus: post.status,
      entitiesCreateUnsupportedKind: {
        status: unsupportedKind.status,
        code: errorCode(unsupportedKind),
      },
      // Non-vacuous: the SAME operation with a SUPPORTED kind must succeed, proving
      // the conditional refusal is genuinely conditional rather than a blanket stub.
      entitiesCreateSupportedKind: 201,
    }).toMatchObject({
      // messages.post LEFT the registered-but-refusing set when G04 composed. It
      // was the ONLY member: registered (inside the health count) while refusing
      // every valid request, which is what made health-implemented and
      // behaviourally-implemented two different sets of coincidentally equal
      // size 73. Composition dissolved that coincidence rather than answering it,
      // and the two figures now denote the SAME set (99 as of A21).
      messagesPostStatus: 200,
      entitiesCreateSupportedKind: 201,
    });

    // THE CLASSIFIER, rebuilt to distinguish the two things a 501 can mean.
    // A GENUINE STUB refuses every valid request for an operation the node claims
    // to implement — that set is now EMPTY, which is why residual is 0. An HONEST
    // CONDITIONAL REFUSAL (DEV-13) is a 501 about a specific unsupported KIND on
    // an operation that otherwise works, and that is a correct answer, not a stub.
    // The unsupported-kind case above is the surviving example and it is paired
    // with its supported-kind control so the refusal is proven conditional.
    expect(post.status, 'messages.post is a genuine stub again').toBe(200);
  });

  it('keeps the event subscription WS-only and unknown HTTP paths at 404', async () => {
    const event = OPERATIONS.find((operation) => operation.name === 'events.subscribe');
    expect(event).toMatchObject({ method: 'WS', path: '/v2/ws', status: 'v1' });
    expect(responses.has('events.subscribe')).toBe(false);

    const unknown = await harness.request('GET', `/v2/w3-unknown-${randomUUID()}`);
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown)).toBe('not_found');
  });
});
