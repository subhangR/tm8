/**
 * W5 Duo C — THE SCHEMA-VALID SWEEP OF ALL 98 v1 NON-WS OPERATIONS.
 *
 * The instrument the program specified and never built. For each operation it
 * sends a body that PASSES that operation's `INPUT_SCHEMAS` entry (or no body
 * where it has none) and records whether the response came from the HANDLER or
 * from the ROUTER.
 *
 * ── WHAT MAKES THE HANDLER/ROUTER ATTRIBUTION SOUND ────────────────────────
 * `src/http/server.ts` runs, in this order:
 *   :163-164  handler = registry.get(opName);  if (!handler) throw notImplemented(opName)
 *   :166-167  schema  = INPUT_SCHEMAS[opName]; input = schema ? validate(...) : body
 *   :182      result  = await handler(ctx)
 *
 * Both a router 501 and a handler 501 arrive on the wire as
 * `not_implemented`. They are told apart WITHOUT parsing the message, by
 * reading the live registry in-process: if `registry.has(op)` is true, the
 * `:164` branch provably cannot have fired, so any 501 observed came from
 * `:182`. The message is recorded as corroboration, never as the discriminator
 * — the router's text (`errors.ts:138`) and a handler's text are similar enough
 * that a string comparison is the wrong instrument.
 *
 * ── WHAT THIS SWEEP CAN BE SATISFIED BY, AND WHAT IT CANNOT ────────────────
 * It establishes HANDLER REACH: that the request got past `:166` and executed
 * handler code. It does NOT establish that the operation is correct, that its
 * happy path works, or that it writes anything. A 404 against a nonexistent
 * entity id is a full pass HERE — the handler ran, reasoned about the input, and
 * answered — and is not evidence about anything else.
 *
 * It also does NOT establish "not a stub" for the whole operation. A handler may
 * be implemented for one input and throw `not_implemented` for another
 * (`entities.create` does exactly this for unsupported kinds, at
 * `handlers/entities.ts:516`). So a 501 here means "this input reaches a
 * not_implemented", not "this operation is unbuilt", and a non-501 means "THIS
 * input reached working code", not "every input does".
 *
 * ── FOUR RECORDED NEGATIVES ON THIS INSTRUMENT ────────────────────────────
 * The three properties above are ALL it establishes. It does NOT establish:
 *   · IMPLEMENTED          — 45 of 98 are 404s on a nonexistent uuid, and a
 *                            registered-but-hollow handler returns that same 404
 *   · CORRECTLY AUTHORIZED — every 038-bound RPC sits BELOW `kindFor`
 *                            (`entities-commands-tracking.ts:757`, call site
 *                            `:959`), which throws on the nonexistent uuids this
 *                            sweep sends, so no probe here reaches a door 038
 *                            binds. Closed separately by
 *                            `entities-patch-038-http.test.ts`.
 *   · CORRECTLY PROVENANCED — `messages.post` answers 200 whether or not
 *                            provenance is recorded; the defect is a FIELD
 *                            VALUE. See `composition-seams.test.ts`.
 *   · ⚠ ACTUALLY DOING WORK — recorded from Duo E's wire-confirmed finding E-2:
 *                            `presence.set` control frames are ACCEPTED AND
 *                            SILENTLY DISCARDED on a `main.ts`-booted node
 *                            (`main.ts:213` passes no `authorize`;
 *                            `control.ts:246` reads the unresolved identity; the
 *                            store skips undefined-identity entries). So
 *                            `presence.get` returns a CONTRACT-SHAPED, EMPTY
 *                            snapshot with `updatedAt` pinned at epoch — and
 *                            THIS SWEEP BOOKS IT AS HANDLER-REACHED AND FINE.
 *                            **A GREEN BADGE OVER AN ABSENCE, INVISIBLE TO
 *                            501-DETECTION BY CONSTRUCTION.** The fix is granted
 *                            in another span; nothing is built here. It is
 *                            recorded because it is the cleanest example of what
 *                            "reached" cannot tell you.
 *
 * A 400 `invalid_input` is an INSTRUMENT FAILURE, not a finding: it means the
 * generated body was rejected at `:166` and the handler never ran.
 * `generator-proof.test.ts` gates every body through its own schema in-process
 * precisely so this count is zero, and the sweep asserts it is zero rather than
 * silently classifying 400s as refusals.
 */
import {
  OPERATIONS,
  bindPath,
  type OperationBinding,
  type OperationName,
} from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ZodTypeAny } from 'zod';

import { INPUT_SCHEMAS } from '../../../src/facade/input-schemas.js';
import { HandlerRegistry } from '../../../src/facade/registry.js';
import { ABSENT_ID, bodyFor } from './body-gen.js';
import { startSurfaceServer, type SurfaceServer } from './harness.js';

/**
 * ⚠ BOTH DEFAULTS, SET AT ONE POINT. VITEST SHIPS TWO INDEPENDENT TIMEOUTS AND A
 * GENEROUS `beforeAll` ARGUMENT COVERS NEITHER:
 *   testTimeout   5s  -> a NAMED test failure
 *   hookTimeout  10s  -> an UNNAMED file-level abort
 *
 * This file drives a real HTTP Server against a real scratch database, and its
 * teardown DROPS that database. On a host measured swinging between 2.7x and 6x
 * oversubscribed — ~92% of it this wave measuring itself — neither default is
 * survivable, and BOTH failure modes are load-sensitive: invisible on a quiet
 * machine, firing precisely inside a landing gate where load is highest and
 * where they would be attributed to the migration rather than to the clock.
 *
 * THE NAMED VARIANT IS THE DANGEROUS ONE. An unnamed abort is loud and cannot be
 * mistaken for an assertion. A `Test timed out in 5000ms` arrives WITH A TEST
 * NAME, so a subset-of-expected-names check matches it, finds it absent, and
 * classifies it as a regression from the landing.
 *
 * Spelling follows the in-tree precedent at
 * `packages/cli/test/integration/inbox.test.ts:39`. Explicit per-hook and
 * per-test arguments still override these, so the values already written at
 * individual call sites stand.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });


const SCHEMAS = INPUT_SCHEMAS as Record<string, ZodTypeAny | undefined>;

/** The 98: v1, non-WS. Derived from the catalog, never hand-listed. */
const SURFACE: readonly OperationBinding[] = OPERATIONS.filter(
  (op) => op.status === 'v1' && op.method !== 'WS',
);

type Verdict =
  /** Past `:166`, handler executed, answered 2xx. */
  | 'HANDLER_OK'
  /** Past `:166`, handler executed, refused on its own grounds (404/403/409/400/500). */
  | 'HANDLER_REFUSED'
  /** Past `:166`, handler executed, threw not_implemented. The finding candidate. */
  | 'HANDLER_501'
  /** `:164` fired — the operation is not mounted at all. */
  | 'ROUTER_501'
  /** Rejected at `:166`. Our body was wrong. Instrument failure, never a finding. */
  | 'SCHEMA_400';

interface Row {
  readonly op: string;
  readonly method: string;
  readonly schemaBound: boolean;
  readonly mounted: boolean;
  /**
   * Whether `INPUT_SCHEMAS[op]` accepts the body we sent, evaluated IN-PROCESS
   * against the very same module object `server.ts:166` reads.
   *
   * This is the discriminator that separates a `:166` rejection from a
   * handler's own `invalid_input`. It is not a heuristic and it is not a string
   * comparison: if this is true, `validate()` provably returned rather than
   * threw, so any 400 observed came from code running at or after `:182`.
   *
   * The first version of this sweep classified EVERY `400 invalid_input` as a
   * `:166` rejection and reported twenty instrument failures that were nothing
   * of the kind — twenty handlers that had run, parsed their own body, and
   * answered. That is this program's own headline defect class (a condition
   * satisfiable by something other than the thing it is checking for) occurring
   * inside the instrument built to look for it, and it is recorded here rather
   * than quietly corrected.
   */
  readonly schemaAccepts: boolean;
  readonly status: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly verdict: Verdict;
}

function pathFor(operation: OperationBinding): string {
  const params = Object.fromEntries(
    [...operation.path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((m) => [m[1]!, ABSENT_ID]),
  );
  return bindPath(operation.name as OperationName, params);
}

describe('W5.C schema-valid stub sweep — all 98 v1 non-WS operations', () => {
  let server: SurfaceServer;
  const rows: Row[] = [];

  beforeAll(async () => {
    server = await startSurfaceServer('sweep');

    const registry = server.production.server.registry;
    const router = server.production.server.router;

    for (const operation of SURFACE) {
      const name = operation.name as OperationName;
      const path = pathFor(operation);

      // In-process preconditions, read from the LIVE composition. `mounted`
      // is what licenses the handler/router attribution below.
      const mounted = registry.has(name);
      const matched = router.match(operation.method, path);
      if (matched?.opName !== name) {
        throw new Error(
          `path binding is not self-consistent for ${name}: ${operation.method} ${path} `
            + `matched ${String(matched?.opName)}. The sweep would be measuring the wrong operation.`,
        );
      }

      const schema = SCHEMAS[name];
      const body = schema ? bodyFor(name, schema) : undefined;
      // Evaluated BEFORE the request, against the same module `:166` reads.
      // An operation with no schema entry has no `:166` gate at all, so the
      // body trivially "passes" it.
      const schemaAccepts = schema ? schema.safeParse(body).success : true;
      const response = await server.request(operation.method, path, body);

      let verdict: Verdict;
      if (response.status === 501 && response.errorCode === 'not_implemented') {
        verdict = mounted ? 'HANDLER_501' : 'ROUTER_501';
      } else if (response.status === 400 && response.errorCode === 'invalid_input' && !schemaAccepts) {
        verdict = 'SCHEMA_400';
      } else if (response.status >= 200 && response.status < 300) {
        verdict = 'HANDLER_OK';
      } else {
        verdict = 'HANDLER_REFUSED';
      }

      rows.push({
        op: name,
        method: operation.method,
        schemaBound: schema !== undefined,
        mounted,
        schemaAccepts,
        status: response.status,
        errorCode: response.errorCode,
        errorMessage: response.errorMessage,
        verdict,
      });
    }

    // The per-operation table, published in full. This is the deliverable;
    // the assertions below are its gates, not its content.
    const tally = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.verdict] = (acc[row.verdict] ?? 0) + 1;
      return acc;
    }, {});
    console.info(
      `\n[W5.C SWEEP] chain applied: ${server.appliedMigrations.length} migrations `
        + `(${server.appliedMigrations[0]} … ${server.appliedMigrations.at(-1)})\n`
        + `[W5.C SWEEP] ${SURFACE.length} operations · ${JSON.stringify(tally)}\n`
        + rows
          .map((r) =>
            [
              r.verdict.padEnd(18),
              String(r.status).padEnd(4),
              (r.errorCode ?? '-').padEnd(22),
              r.schemaBound ? 'schema' : 'nobody',
              r.op,
              r.verdict === 'HANDLER_501' ? `:: ${r.errorMessage ?? ''}` : '',
            ].join(' '))
          .join('\n'),
    );
  }, 180_000);

  /**
   * ⚠ THE EXPLICIT TIMEOUT IS LOAD-BEARING AND `beforeAll`'s DOES NOT COVER IT.
   *
   * Vitest configures `afterAll` INDEPENDENTLY of `beforeAll`, and its default
   * hook timeout is 10s. The 180s above buys this hook nothing.
   *
   * What this teardown actually does: closes a real HTTP Server, ends the
   * production pool, then `database.destroy()` — which ends the scratch pool,
   * opens a NEW admin connection and issues `drop database` — and finally
   * removes the data directory. On a machine swinging to ~6x oversubscribed
   * that does not reliably fit in 10s.
   *
   * THE FAILURE MODE IS WHY THIS MATTERS MORE THAN IT LOOKS: a teardown timeout
   * produces a FILE-LEVEL abort carrying NO FAILING TEST NAME — so it cannot be
   * matched against an expected-failure set — and it is LOAD-SENSITIVE, so it is
   * invisible on an idle machine and fires precisely inside a landing gate,
   * where it would be attributed to the migration rather than to the clock.
   */
  afterAll(async () => {
    await server?.close();
  }, 120_000);

  /**
   * ISOLATION, ASSERTED RATHER THAN INTENDED.
   *
   * A live node listens on 127.0.0.1:4610 — `TM8_PORT`'s default — attached to
   * a database this duo does not own. `bootstrap()` calls
   * `execution.reconcileGhosts()`, which RETIRES work_sessions still at
   * 'running', so booting against a shared database is not read-only even when
   * every request would be. This harness binds port 0 and reads the assigned
   * port back off the socket, and its database is a per-run scratch. Both facts
   * are asserted here so a config drift becomes a red instead of traffic
   * arriving at somebody else's node.
   */
  it('ISOLATION: drives an ephemeral port and a scratch database, never :4610', () => {
    const url = new URL(server.baseUrl);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port, 'the sweep must never address the default node port').not.toBe('4610');
    expect(Number(url.port)).toBeGreaterThan(0);
    expect(server.database.name).toMatch(/^tm8_w1_w5c_/);
  });

  it('sweeps exactly the 98 v1 non-WS operations, derived from the catalog', () => {
    // 98 -> 114 on 2026-07-31: the consolidation wave (serverConnections,
    // artifacts, attention, voice et al) grew the v1 non-WS surface.
    // 118 -> 122 on 2026-08-02: auth.signup/login/logout/session.get (Stage 1).
    // 114 -> 118 on 2026-08-01: execution.resume, spaces.counts,
    // execution.journal, identity.profile.update. The first three landed
    // without this pin moving; the fourth reconciled it.
    expect(SURFACE).toHaveLength(122);
    expect(rows).toHaveLength(122);
    expect(new Set(rows.map((r) => r.op)).size).toBe(122);
  });

  /**
   * "A MEASUREMENT OF A BUILT ARTIFACT IS NOT A MEASUREMENT OF THE SOURCE."
   *
   * Duo C's developer measured `packages/server/dist` STALE — eight `src` files
   * newer than `dist/facade/index.js` — and told this seat to rebuild before
   * measuring. That instruction is correct for anyone reading `dist`, and it
   * does not apply to this sweep. Rather than assert that, prove it: resolve the
   * two modules this file's conclusions rest on and require they are `.ts` under
   * `src/`, which is only true if vite is transpiling source. If a future config
   * change made vitest resolve `dist` instead, this sweep would silently start
   * measuring a stale binary, and this test is what would go red.
   *
   * `@tm8/contract` DOES resolve to `dist` (its package.json `exports` names
   * it), and that build was confirmed current out-of-band via `tsc -b --dry`
   * reporting the project up to date. That limit is stated rather than hidden:
   * the contract half of this measurement is of a built artifact.
   */
  it('INSTRUMENT: measures src/, not the stale dist/ build', () => {
    // Make a production module in the loaded graph throw, and read where the
    // stack says it lives. `HandlerRegistry.register` refuses a reserved
    // operation (`registry.ts:46`), which is a pure, side-effect-free throw on a
    // FRESH registry — the live one the sweep ran against is never touched.
    let stack = '';
    try {
      new HandlerRegistry().register('search.query' as OperationName, () => ({}));
    } catch (error) {
      stack = (error as Error).stack ?? '';
    }

    expect(stack, 'the reserved-op guard did not throw; this control proves nothing').toMatch(/reserved|search\.query/i);
    expect(
      stack,
      `production module resolved to a built artifact, not source:\n${stack}`,
    ).toContain('/packages/server/src/facade/registry.ts');

    // Scoped to tm8's OWN frames. An unscoped `not.toContain('/dist/')` is
    // satisfied by something other than what it checks for: vitest's runner
    // frames live under `node_modules/.bun/@vitest+runner/dist/`, so the
    // unscoped form went red on the test harness while the thing it was
    // actually asserting about was already correct.
    const tm8Frames = stack
      .split('\n')
      .filter((line) => line.includes('/Projects/tm8/packages/'));
    expect(tm8Frames.length).toBeGreaterThan(0);
    expect(tm8Frames.filter((line) => line.includes('/dist/'))).toEqual([]);
  });

  /**
   * FROZEN LITERAL — FULL ROTATION HISTORY, per the instrument rules.
   *
   *   BEFORE  34   chain digest a799b7ef1b20a9b0   (highest 037)
   *   THEN    37   chain digest fff3995e1c2a5dcd   (highest 040)
   *   NOW     39   chain digest 0dff33602fcc6b7c   (highest 042)
   *
   * The history is KEPT rather than overwritten: each row is one landing this
   * detector caught, and a reader who sees only the current pair cannot tell a
   * literal that has been maintained from one that was never exercised.
   *
   * Rotations: 038 (entities.patch resource binding), 039 (delivery principal
   * tightened to session_user) and 040 (019's Teammate exited-target pair
   * shape); then 041 (record_execution_command resource binding) and 042
   * (set_pull_state's clear parameter).
   *
   * EVERY digest above was measured BY THIS SEAT with
   * `cd db/migrations && shasum -a 256 *.sql | shasum -a 256 | cut -c1-16` —
   * the `cd` is load-bearing, because shasum hashes its own output lines and
   * those carry the path as typed — and with the empty-input control
   * `e3b0c44298fc1c14` printed beside each and confirmed DIFFERENT. A digest of
   * nothing looks exactly like a digest. None was adopted from an announcement.
   *
   * THIS TEST WENT RED IN BOTH LANDING GATES — `expected 37 to be 34`, then
   * `expected 39 to be 37` — AND BOTH TIMES THAT WAS THE DETECTOR WORKING, not
   * a regression. It is updated to a NEW EXACT LITERAL each time; never to a
   * range, and never to `migrationFiles().length`, which would be a
   * live-computed value that passes on any chain length and could no longer
   * notice a chain that silently shrank or grew.
   *
   * WHY THE COUNT AND NOT THE DIGEST IS ASSERTED: the fixture applies whatever
   * `migrationFiles()` enumerates, so the count is the property this test can
   * observe. The digests above are the RECORD of which chain each count belonged
   * to — they are not asserted here, and re-deriving one is a `cd` and a
   * `shasum`, never a value copied from a message.
   */
  it('applies the FULL migration chain, enumerated rather than hand-listed', () => {
    // 39 -> 57 on 2026-07-31: migrations 040-060 landed with the wave.
    // 57 -> 63 on 2026-08-01: 061-067 (voice group restore through identity
    // profile). Several landed without this pin moving; 067 reconciled it.
    // 63 -> 65 on 2026-08-01: the pin was ALREADY red at 64 when this lane
    // arrived — 068 (counters watermark) landed from another lane without
    // moving it, the same drift 067 had just reconciled. 069 (channels into
    // Home) is the second of the two.
    // 65 -> 66 on 2026-08-02: 070 (entities_select restricted-projection policy).
    // 66 -> 67 on 2026-08-02: 072 (persona-pinned agent run credentials).
    // 67 -> 68 on 2026-08-02: 073 (shared teammate authority).
    expect(server.appliedMigrations.length).toBe(68);
    expect(server.appliedMigrations).toEqual([...server.appliedMigrations].sort());
    expect(server.appliedMigrations.every((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))).toBe(true);
  });

  /**
   * INSTRUMENT GATE. Until this is green, every other row in the table is
   * uninterpretable: a body the schema rejected produces a 400 at `:166` that
   * looks, from outside, exactly like a handler declining the input.
   */
  it('INSTRUMENT: no generated body was rejected by its own schema', () => {
    const rejected = rows.filter((r) => r.verdict === 'SCHEMA_400');
    expect(
      rejected.map((r) => `${r.op}: ${r.errorMessage ?? ''}`),
      'These are GENERATOR failures, not findings. The sweep cannot speak about these operations.',
    ).toEqual([]);
    expect(rows.every((r) => r.schemaAccepts)).toBe(true);
  });

  /**
   * THE OTHER HALF OF THE DETECTOR — red on known-bad.
   *
   * Everything above rests on `:166` being a LIVE gate: "the schema accepted
   * this body, therefore the 400 came from the handler" is vacuous if
   * `validate()` never rejects anything. A sweep in which every body passes
   * proves the gate is OPEN exactly as well as it proves the bodies are good.
   *
   * So: send a body the schema demonstrably REJECTS to a schema-bound operation
   * and require a 400. Then send the SAME body to an operation with NO schema
   * entry and require it is NOT rejected the same way — which is what shows the
   * 400 is attributable to the TABLE rather than to some blanket body check
   * elsewhere in the frame.
   */
  it('CONTROL: server.ts:166 rejects a schema-invalid body on the very operation it accepted a valid one for', async () => {
    // A WITHIN-OPERATION comparison, deliberately: same operation, same
    // handler, same path, two bodies. Anything that differs between the two
    // responses is attributable to the body alone. (An across-operation
    // comparison would have confounded the gate with the handler, and the
    // first draft of this control also could not send a body to a GET.)
    const op = 'messages.delete' as OperationName;
    const path = bindPath(op, { id: ABSENT_ID });
    const schema = SCHEMAS[op];
    expect(schema, 'control requires messages.delete to stay schema-bound').toBeDefined();

    const poison = { __w5_not_a_field__: 'rejected by every .strict() DTO' };
    const valid = bodyFor(op, schema!);

    // The in-process premise, asserted rather than assumed.
    expect(schema!.safeParse(poison).success).toBe(false);
    expect(schema!.safeParse(valid).success).toBe(true);

    const rejected = await server.request('DELETE', path, poison);
    const accepted = await server.request('DELETE', path, valid);

    // RED ON KNOWN-BAD. `server.ts:224` is the only site in the tree that emits
    // this exact message, and it attaches the zod issues that produced it — so
    // this identifies the `:166` frame itself, not merely "some 400".
    expect(rejected.status).toBe(400);
    expect(rejected.errorCode).toBe('invalid_input');
    expect(rejected.errorMessage).toBe('request body failed contract validation');
    expect(
      (rejected.errorDetails as { issues?: unknown[] } | undefined)?.issues,
      'a :166 rejection carries the zod issues; a handler-authored 400 does not',
    ).toBeInstanceOf(Array);

    // GREEN ON KNOWN-GOOD. The same operation, given a body the same schema
    // accepts, gets PAST `:166` and is answered by the handler.
    expect(accepted.status).not.toBe(400);
    expect(accepted.errorMessage).not.toBe('request body failed contract validation');
  });

  /**
   * The exact-literal discriminator applied to the whole sweep, as an
   * INDEPENDENT check on the in-process `safeParse` attribution.
   *
   * Two instruments, no shared mechanism: `schemaAccepts` reads the zod module
   * in-process; this reads the wire. If either said a body was refused at
   * `:166`, they must agree. They do — which is why the twenty `400`s in the
   * first run are reported as handler-authored rather than as instrument
   * failures. Neither reading alone would have been worth acting on.
   */
  /**
   * CLOSING A DISCRIMINATOR GAP FOUND BY THE NAMED SECOND READER.
   *
   * `readJsonBody` runs at `server.ts:156` — BEFORE the router, the registry and
   * the handler — and can answer on its own:
   *   body.ts:69  invalid_input     'request body is not valid JSON'
   *   body.ts:58  payload_too_large 'request body exceeds the N byte limit'
   * Neither carries the `:224` literal, so both would land in the 400 bucket
   * classified as HANDLER_REFUSED with no handler having run.
   *
   * These were UNREACHABLE in this run — but only because every body is
   * `JSON.stringify`d and therefore well-formed BY CONSTRUCTION. That is a
   * property of the GENERATOR, not of the discriminator, and an instrument
   * whose soundness rests on an unstated property of its inputs hands a silent
   * hole to whoever reuses it with hand-written bodies. So the property is now
   * asserted, and the two pre-handler literals are excluded explicitly.
   */
  it('CROSS-CHECK: no response came from a PRE-HANDLER emission site', () => {
    const preHandlerLiterals = [
      'request body failed contract validation', // server.ts:224  (:166 gate)
      'request body is not valid JSON', // body.ts:69     (:156, pre-router)
      'request body exceeds', // body.ts:58     (:156, pre-router)
    ];
    const preHandler = rows.filter((r) =>
      preHandlerLiterals.some((lit) => r.errorMessage?.startsWith(lit)));
    expect(
      preHandler.map((r) => `${r.op}: ${r.errorMessage}`),
      'these answered before any handler ran; they are not handler evidence',
    ).toEqual([]);

    // The generator property that makes body.ts:69 unreachable, asserted
    // rather than relied upon silently.
    for (const [name, schema] of Object.entries(SCHEMAS)) {
      if (!schema) continue;
      const body = bodyFor(name, schema);
      const roundTripped = JSON.parse(JSON.stringify(body)) as unknown;
      expect(roundTripped, `${name} body does not survive a JSON round-trip`).toEqual(body);
    }
  });

  it('CROSS-CHECK: no response in the sweep carries the :166 rejection literal', () => {
    const gateRejections = rows.filter(
      (r) => r.errorMessage === 'request body failed contract validation',
    );
    expect(gateRejections.map((r) => r.op)).toEqual([]);

    // And the handler-authored 400s, named, so the table's meaning is explicit.
    const handlerAuthored400s = rows
      .filter((r) => r.status === 400)
      .map((r) => r.op)
      .sort();
    expect(handlerAuthored400s).toEqual(HANDLER_AUTHORED_400);
  });

  /**
   * The mounting claim, re-derived at the wire rather than inherited. This is
   * the half the existing no-body probe already established; it is repeated here
   * so the two halves of the sizing come from ONE instrument.
   */
  it('confirms all 98 are MOUNTED — no 501 is attributable to the router', () => {
    const unmounted = rows.filter((r) => !r.mounted).map((r) => r.op);
    const routerRefusals = rows.filter((r) => r.verdict === 'ROUTER_501').map((r) => r.op);
    expect(unmounted, 'operations absent from the live registry').toEqual([]);
    expect(routerRefusals).toEqual([]);
  });

  /**
   * THE DELIVERABLE ASSERTION, and it is an exact-set assertion against a frozen
   * literal rather than an emptiness assertion.
   *
   * An emptiness assertion here would be the wrong instrument twice over: it
   * would go red on operations whose 501 is an HONEST per-input answer (an
   * unsupported entity kind is a 501 about the server's build, not a stub), and
   * it would silently absorb a NEW stub into an existing red. The exact set
   * makes both directions visible: a stub appearing is a red, and a stub being
   * FIXED is also a red, which is what forces the list to be re-derived rather
   * than assumed.
   */
  it('pins the exact set of operations answering 501 FROM THE HANDLER', () => {
    const handlerStubs = rows
      .filter((r) => r.verdict === 'HANDLER_501')
      .map((r) => r.op)
      .sort();
    expect(handlerStubs).toEqual(EXPECTED_HANDLER_501);
  });
});

/**
 * Frozen literal. MEASURED, not assumed: this is empty because a green run of
 * this file found zero operations answering 501 from the handler — not because
 * an empty list was asserted ahead of the measurement.
 *
 * THE DISTINCTION MATTERS AND IS WHY THIS COMMENT EXISTS. An empty expectation
 * written BEFORE the run would be a guess wearing an assertion's clothes, and it
 * would be indistinguishable from this one by inspection.
 *
 * AND AN EMPTY LIST HERE IS NOT SELF-VALIDATING. `conditional-501.test.ts`
 * carries the red-on-known-bad half: it drives two inputs that MUST produce a
 * handler 501 (`execution-handlers.ts:556` and `:559`) through this same harness
 * and classification. Without that file, this empty literal is equally
 * consistent with "no stubs exist" and "this instrument cannot see a stub".
 * DO NOT DELETE THAT FILE WITHOUT REPLACING THE CONTROL.
 *
 * Update ONLY to new exact literals, with before-and-after recorded — never to a
 * range and never to a live-computed value.
 */
const EXPECTED_HANDLER_501: readonly string[] = [
  // 2026-07-31: voice.token.create is MOUNTED and REACHED, and on a node with
  // no TM8_LIVEKIT_* configured its handler answers an honest not_implemented
  // naming the env vars to set (services/voice.ts). A refusal authored by the
  // handler on real configuration grounds, not a stub.
  'voice.token.create',
];

/**
 * The operations that answered `400 invalid_input` from their OWN validation,
 * past `:166`. Every one of these is a HANDLER-REACHED result — the eight
 * `interactionProfiles`/`setDefault` rows and `spaces.menu.update` /
 * `spaces.defaultChannel.set` have no `INPUT_SCHEMAS` entry at all and so have
 * no `:166` gate to fail; the rest passed theirs in-process.
 *
 * Pinned as an exact literal because this list is where a future `:166`
 * regression would first appear as a shift rather than as a failure.
 */
const HANDLER_AUTHORED_400: readonly string[] = [
  // 2026-07-31: artifacts.export refuses its own unimplemented format choice
  // in-handler, and attentionRequests.list validates its query in-handler —
  // both handler-reached 400s, recorded when the wave landed them.
  'artifacts.export',
  'attentionRequests.list',
  // 2026-08-02: auth.logout with a bare {} and no bearer session names nothing
  // to revoke — a handler-reached invalid_input, not a :166 gate rejection.
  'auth.logout',
  'entities.commands.linkCommit',
  'entities.commands.linkPr',
  'entityKinds.create',
  'entityKinds.update',
  'interactionProfiles.activate',
  'interactionProfiles.preview',
  'interactionProfiles.propose',
  'interactionProfiles.retire',
  'interactionProfiles.updateDraft',
  'interactionProfiles.validate',
  'savedViews.create',
  'savedViews.update',
  'spaces.create',
  'spaces.defaultChannel.set',
  'spaces.interactionProfile.setDefault',
  'spaces.menu.update',
  'spaces.taskAxes.create',
  'spaces.taskAxes.update',
  'spaces.update',
  'teamMembers.interactionProfile.setDefault',
];
