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
import { fileURLToPath } from 'node:url';
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

/** The v1, non-WS surface. Derived from the catalog, never hand-listed. */
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

  it('sweeps exactly the 136 v1 non-WS operations, derived from the catalog', () => {
    // 98 -> 114 on 2026-07-31: the consolidation wave (serverConnections,
    // artifacts, attention, voice et al) grew the v1 non-WS surface.
    // 118 -> 122 on 2026-08-02: auth.signup/login/logout/session.get (Stage 1).
    // 123 -> 125 on 2026-08-04: projects.files.list and projects.files.attach.
    // 114 -> 118 on 2026-08-01: execution.resume, spaces.counts,
    // execution.journal, identity.profile.update. The first three landed
    // without this pin moving; the fourth reconciled it.
    // 122 -> 123 on 2026-08-02: execution.launch.
    // The 123 literal was ALREADY red at 124 when this lane arrived (the
    // onboarding read landed without moving it); 125 adds execution.transcript,
    // and 126 adds projects.branches.list.
    // Tier 4 adds projects.contention and entities.commands.gate.
    // credentials.* add four mounted operations.
    // 139 -> 141 (2026-08-12): collections.addItem/removeItem.
    // 141 -> 147 (2026-08-12, Git UI landing): the six execution.git* rows.
    // 160 -> 163 (2026-08-16, W4/132): spaces.taskWorkflows list/upsert/delete.
    // 166 -> 169 (148): spaces.workflows list/upsert/delete.
    expect(SURFACE).toHaveLength(169);
    expect(rows).toHaveLength(169);
    expect(new Set(rows.map((r) => r.op)).size).toBe(169);
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
    //
    // DERIVED from this file's own location, never a literal. The scope used to
    // read `/Projects/tm8/packages/`, which is one developer's macOS checkout
    // path: anywhere else it matched zero frames, so `tm8Frames.length` was 0
    // and the assertion below failed for a reason that has nothing to do with
    // src-vs-dist. `node_modules` is excluded explicitly because a checkout
    // could legitimately sit under a path containing the repo name twice.
    const packagesDir = fileURLToPath(new URL('../../../../', import.meta.url));
    const tm8Frames = stack
      .split('\n')
      .filter((line) => line.includes(packagesDir) && !line.includes('/node_modules/'));
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
    // 66 -> 71 on 2026-08-04: the identity composite (072 agent session
    // credentials, 073 shared teammate authority) merged with main's 071,
    // 072 session io routes and 073 session launch prompts.
    // 71 -> 72 on 2026-08-05: 076 (reply delivery targets).
    // 72 -> 73 on 2026-08-05: 077 (anchor-watcher notification fan-out). This
    // lane authored it as 076 in parallel with the reply-delivery lane; both
    // claimed the same free number, so it renumbered to 077 on landing.
    // 73 -> 74 on 2026-08-07: 080 (channel members, `has_member`). The COUNT
    // moves by one while the highest number moves by three, and that gap is
    // deliberate: `public.applied_migrations` keys on FILENAME, so an unused
    // number costs nothing, while renaming an already-applied file makes it
    // re-apply — which is why the gap was taken rather than the next number.
    // WHAT IS ACTUALLY KNOWN about 078/079, since this block is the ledger the
    // next author will read as fact — and note the DATES, because this is the
    // kind of claim that goes stale in hours:
    //   · measured 2026-08-07, when the gap was taken: nothing on :5442 and
    //     nothing on origin/main was past 077. The reservation was an
    //     inherited claim with no evidence either way.
    //   · re-measured 2026-08-09 at review: no longer true. 078 (worktree
    //     provisioning) is applied in seven databases on :5442, and tm8_stable
    //     is at 083 — a number in no branch visible from here.
    // The DECISION still holds, and holds harder: 080 was free then and is free
    // now, and 078 turned out to be genuinely spoken for. What does NOT hold is
    // writing a falsifiable measurement into a ledger in the present tense.
    // Date what you measured, or the next author inherits your claim as fact —
    // which is exactly what cost the previous lanes a number.
    // This assertion is on the LENGTH and not on the maximum, which is why a
    // gap — reserved or merely skipped — cannot make it lie.
    // 74 -> 75 on 2026-08-09: 085 (rename_work_session). This lane branched
    // from a main that was 100 commits stale, where the pin read 69 and this
    // change moved it to 70. NEITHER literal survives the rebase, and the 75
    // here was OBTAINED BY RUNNING THE MERGED TREE, not by adding one to 74 —
    // delta arithmetic across a rebase is exactly how a pin lands on a number
    // no tree ever produced.
    // On the number 085 rather than 081: measured 2026-08-09, origin/main tops
    // out at 080 and 081-084 are claimed by unmerged branches. Same reasoning
    // as the 078/079 gap above, and the same caveat — that is a dated
    // measurement, not a standing fact.
    // 75 -> 77 on 2026-08-09: 078 (derived_from props_schema) and 079
    // (core-draft promptPolicy repair), the two defects the CI gate had hidden
    // while the check job ran without a database.
    // 77 -> 78 on 2026-08-09: 081 (worktree provisioning + tracking observer).
    // Authored as 078, then renumbered on merge because #71 had landed 078/079.
    // 78 -> 79: 082 (git graph events, provenance and completion gate).
    // 79 -> 80: 083 (per-member credential sessions).
    // 80 -> 81: 086 (manifest credential-shape guard), merged via #87.
    // Measured on the consolidated Files tree 2026-08-10: 90 files through
    // 095 — production-lineage 093 credentials + 094 Loops menu (main #145)
    // plus this wave's 095 file upload slot sweep. Measured by
    // `ls db/migrations/*.sql | wc -l`, never previous-plus-one.
    // 90 -> 92 on 2026-08-10, and it is TWO steps for two unrelated reasons.
    // 096 (Files menu view) landed without touching this pin, so a clean tree
    // already measured 91 against a pinned 90 — this line was failing on main
    // before the channel-threads work went near it. 097 (channel_threads_v1
    // feed scope) is the second. Re-measured with the command above rather
    // than incremented, which is how the 096 miss would have been caught.
    // 92 -> 94 on 2026-08-10, resolved AT THE MERGE. Lane B (098, thread_v1 +
    // task_discussion_v1) and Lane C (099, thread spawn derivation) each
    // measured 93 correctly on their own branch and each said so in a comment
    // agreeing that whoever landed second would re-measure the MERGED tree.
    // This is that re-measurement: `ls db/migrations/*.sql | wc -l` = 94.
    // Keeping either branch's 93 would have been the previous-plus-one error
    // the comment above warns against, arrived at by two correct measurements.
    // Re-measured on the TM8 Chat tree: 99 files through 104 (L2 branch).
    // Re-measured AT THE INTEGRATION MERGE 2026-08-13: L3's agent_runtime
    // migration renumbered 104 -> 105 joins L2's 104 (100), then R9's 106
    // requester_auth_kind replay column lands the same day. `ls
    // db/migrations/*.sql | wc -l` = 101 on integrate/tm8-chat — same
    // two-correct-measurements-still-stale class as the 92 -> 94 note above.
    // 101 -> 102 on 2026-08-13, resolved AT THE REBASE onto the merged #188:
    // 107 (session checkout_branch lane fact) joins the chat stack's
    // 104-106 — it was numbered 107 on its own branch precisely because
    // those three were claimed in flight, so the rebase changes the count
    // and nothing else.
    // 102 -> 103 on 2026-08-13, same lane, same day: 108 (entity_counters
    // docs/memories link counters). Re-measured on THIS tree, not
    // incremented: `ls db/migrations/*.sql | wc -l` = 103.
    // 103 -> 104 on 2026-08-13: 111 (a spawn on a task assigns that task).
    // Numbered 111 and not 109 because 109 (agent_bearer_liveness) and 110
    // (node_claim) are claimed on branches that have not landed — so this
    // count moves by one while the highest FILENAME jumps by three, and the
    // two numbers are not each other. Re-measured on THIS tree, not
    // incremented: `ls db/migrations/*.sql | wc -l` = 104.
    // 104 -> 105 on 2026-08-13: 112 adds the human/agent message counters.
    // It follows landed 111 and avoids the already-claimed 109/110 slots.
    // Re-measured on this rebased tree: `ls db/migrations/*.sql | wc -l` = 105.
    // 105 -> 106 on 2026-08-13, the same day again: 115 (chat turns queue for
    // every human member of the Space). Authored as 111, renumbered as main
    // landed 111 and 112 while it was in review, and 113/114 are claimed on
    // branches that have not landed (node_claim, member roles). Re-measured on
    // THIS tree, not incremented: `ls db/migrations/*.sql | wc -l` = 106.
    // 106 -> 107 on 2026-08-13: 116, the first-run node claim. THIRD renumber
    // for this lane (110 -> 112 -> 113 -> 116) as 111, 112 and then 115 landed
    // ahead of it. The number is not decoration: the assertion below requires
    // APPLIED order to equal SORTED order, so a file sorting below an
    // already-applied one breaks the invariant on a live deployment while a
    // fresh test database, which always applies in sorted order, never notices.
    // Taking the next number ABOVE the highest applied file is the whole rule.
    // MEASURED with `ls db/migrations/*.sql | wc -l` = 107. Note the trap: a
    // bare `git ls-tree db/migrations/ | wc -l` returns 107 for main alone,
    // because the directory holds a non-.sql entry — counting that and adding
    // one gives 108 and a red suite. Count the .sql files.
    // 107 -> 108 on 2026-08-13: 117 adds the unified Messages menu view after
    // 116 landed during this PR's green CI run. Re-measured: 108 SQL files.
    // 108 -> 109 on 2026-08-13: 118, the member roles + invite roles writer.
    // FOURTH renumber across these two lanes (114 -> 117 -> 118 here) as 115,
    // 116 and then 117 landed while they were in review. Same rule every time:
    // take the next number ABOVE the highest already-applied file, because the
    // assertion below requires applied order to equal sorted order and only a
    // live deployment can falsify it.
    // 109 -> 110 on 2026-08-14: 119, the work_sessions.agent_config_dir column
    // and the sixth record_session_manifest argument that fills it. Renumbered
    // from 104 (its author's base) because 104 is already claimed by
    // chat_threads_and_message_parts — same rule as every entry above.
    // MEASURED: `ls db/migrations/*.sql | wc -l` = 110.
    // 110 -> 112 on 2026-08-14: TWO files in one lane — 120 removes the agent
    // wake budget's cap, 121 adds the task-anchor fan-out class to
    // w2_record_session_message_routes. Kept as two because they are two
    // concerns with two blast radii and each has to be revertible on its own,
    // not because the lane needed two numbers. Both take numbers ABOVE 119, the
    // highest applied file on main when this was written — the rule every entry
    // above restates, and the one the sorted-order assertion below is the only
    // thing that can catch on a live deployment.
    // 112 -> 113 on 2026-08-15: 122_menu_single_home.sql — the server twin of
    // menu revision 11 (single-home rail, task 01a0027d). Takes a number above
    // 121, the highest applied file on main when it was written.
    // 113 -> 114: 123 persists chat mode and audits chat tool calls; it was
    // renumbered from 122 after the single-home migration landed on main.
    // 114 -> 115: 124 widens that write-once authority to Explain mode.
    // 115 -> 119 on 2026-08-16: the shell-redesign lane carries FOUR menu
    // revisions, each its own migration because each is a separately
    // revertible revision of the same spine row — 125 the tab shell,
    // 126 the conversation axis, 127 the restored Chats tab, 128 the
    // Collab relabel. They are four and not one collapsed file precisely
    // because a menu revision that ships and is disliked has to come back
    // out on its own.
    // 119 -> 120: 129 records the provenance for current task assignments.
    // 120 -> 121 on 2026-08-16: 130_menu_board_tab.sql — the task kanban as
    // its own tab (menu revision 16). Takes 130 rather than 129 because 129
    // was RESERVED by the concurrent assigned-by provenance lane on the same
    // task family; both lanes' files now coexist in this union tree.
    // 121 -> 122 on 2026-08-16, merging main into the shell-redesign lane:
    // 131_spawn_starts_the_task.sql — a session spawned on a task moves that
    // task to `working`, the durable twin of the derived `workingActors`
    // badge, written in the same `execution_spawn` task loop as 111's
    // assignment. Its own note reasoned its way to 131 by treating 129 and
    // 130 as claimed-but-unlanded on branches; this merge IS those branches
    // landing, so the number it reserved is exactly right and the two
    // histories add rather than contradict.
    //
    // Both sides of that merge carried a pin — 121 here, 116 there — and
    // NEITHER is the answer. A count pin is DERIVED, so only the merged tree
    // can be asked. MEASURED, never arithmetic:
    // `ls db/migrations/*.sql | wc -l` = 122.
    // 122 -> 123 (2026-08-16, W4): 132_task_workflows joins the chain — on
    // top of the 121-vs-116 merge union this comment block already records.
    // Same rule again: both sides carried a pin, neither was the answer, the
    // MERGED tree was asked. `ls db/migrations/*.sql | wc -l` = 123.
    // 123 -> 124 (2026-08-16): 133_chat_turns_select — the claimed-turn wire
    // marker's select policy. MEASURED: `ls db/migrations/*.sql | wc -l` = 124.
    // 124 -> 125 (2026-08-16, unified Home merge): 134_menu_home_tab —
    // revision 17's server twin (task 01a00932). The lane took 134 BECAUSE it
    // measured 133 as claimed on an unmerged branch; this merge is that
    // branch landing, so the reservation was exactly right and the histories
    // add. Both sides carried a pin — 124 here, 124 there — and NEITHER was
    // the answer: a count pin is DERIVED, only the merged tree can be asked.
    // MEASURED, never arithmetic: `ls db/migrations/*.sql | wc -l` = 125.
    // 125 -> 128 (2026-08-16, Craft P1): THREE files in one lane — 135 mints
    // the `graph` kind (registry + detail table + doors), 136 widens
    // chat_mode to `craft`, 137 adds the Craft tab (menu revision 18). Three
    // and not one because each is separately revertible: a disliked tab comes
    // out without unminting the kind. Numbers taken ABOVE 134 after measuring
    // ALL remote refs (their max was 134). MEASURED on this tree, never
    // arithmetic: `ls db/migrations/*.sql | wc -l` = 128.
    // 128 -> 129 (2026-08-16, same lane): 138 repairs 132's missing PUBLIC
    // revoke on the task-workflow definer functions — found because the
    // tm8_delivery_worker surface enumeration was red on every PR.
    // MEASURED: `ls db/migrations/*.sql | wc -l` = 129.
    // 129 -> 130 (2026-08-16): 139 restores
    // `session_message_deliveries.pair_budget_version` on nodes that applied an
    // orphan `083_remove_session_wake_budgets.sql` that never reached main.
    // Nothing in THIS chain drops that column, so on a tree built from these
    // files 139 is a no-op — it exists because plpgsql is late-bound, so 120's
    // reserve body CREATES fine against a drifted table and only raises 42703
    // when called, which reads as "PTY injection is dead" with a green deploy.
    // Numbered 139 after measuring every remote ref (max was 138).
    // 130 -> 131 (2026-08-16): 140 returns the WORK tab — the three-panel
    // workspace as its own railless group, menu revision 18 -> 19. Payload
    // half only: `workspace` has been a registered, implemented view ref
    // since 029, so re-adding a retired tab widens no constraint and inserts
    // no registry row. Numbered 140 after measuring every ref, remote and
    // local (max was 139).
    // MEASURED, never arithmetic: `ls db/migrations/*.sql | wc -l` = 131.
    // 131 -> 132 (2026-08-17, multi-mode boot fix): 142_resolve_node_owner —
    // a claim-free SECURITY DEFINER read of the single is_owner account by
    // FLAG, so a claimed node (whose owner username claim_node renamed off
    // `owner`) resolves its loopback owner instead of missing the read and
    // crashing into F1 at boot. MEASURED on THIS branch, never arithmetic:
    // `ls db/migrations/*.sql | wc -l` = 132. WARNING: PR #319 also adds a
    // migration (141); each PR alone measures 132, but MERGED together the
    // count becomes 133 — whoever lands second must RE-MEASURE this pin on the
    // merged tree, not increment.
    // RE-MEASURE ON THE MERGED TREE, not on this branch: this number is the
    // one thing here that another lane can invalidate without touching this
    // file, and delta arithmetic across a merge is how it goes wrong.
    // 141: +1 migration file (141_account_lifecycle_ops.sql) -> 132.
    // 143: +1 migration file (143_signup_requires_claimed_node.sql, the §7.1
    // unclaimed-node guard) -> 133 on THIS branch. RE-MEASURE on merge: #318
    // adds 142, so the six-way merged tree is 134, not 133.
    // 133 -> 137 (2026-08-17): the re-measure the note above asked for never
    // happened, and the pin sat at 133 while four more files landed. It did not
    // go red to say so, because it could not RUN: main carried duplicate
    // prefixes 133/134/135, so `migrationFiles()` aborted on the duplicate guard
    // before any count was reached, and this assertion was unreachable on main.
    // Un-blocking the chain (the 144/145/146 renames) is what let it be observed
    // again, and the first thing it reported was its own four-file drift. The
    // detector was working; nothing had silently shrunk.
    // MEASURED on the merged tree, never arithmetic, and equal on both sides
    // because a rename does not change a count:
    //   ls db/migrations/*.sql | wc -l                                  -> 137
    //   git ls-tree --name-only origin/main db/migrations/ | grep -c sql -> 137
    // CI's own fixture agrees: "chain applied: 137 migrations
    // (001_core_graph.sql … 146_remove_wake_budget_machinery.sql)".
    // 137 -> 138 (2026-08-18): 147_entity_status_category.sql, the phase-1
    // category column. ONE file, and MEASURED on this tree rather than
    // incremented — the note above is the record of what delta-arithmetic cost
    // the last time:
    //   ls db/migrations/*.sql | wc -l                             -> 138
    //   git ls-tree --name-only HEAD db/migrations/ | grep -c sql  -> 138
    //   (origin/main is still 137; this branch is the +1.)
    // 138 -> 140 (2026-08-18): TWO migrations, from two lanes that landed in
    // the same window.
    //   148_pr_owning_session_space_scope.sql — the D2 cross-Space nudge fix,
    //     already on main. Its own note records that it is 148 and not 147
    //     because #353 took 147 first.
    //   149_workflows.sql — the phase-2 workflow tables. It was AUTHORED as
    //     148 and RENUMBERED to 149 on this rebase, because the lane above
    //     merged first and a duplicate prefix aborts `migrationFiles()`.
    // That note's warning ("if a sibling lane's migration merges before this
    // one, this pin is a GUARANTEED conflict — re-MEASURE on the merged tree,
    // never add one") is exactly what happened, and this is the re-measurement:
    //   ls db/migrations/*.sql | wc -l                             -> 140
    //   git ls-tree --name-only HEAD db/migrations/ | grep -c sql  -> 140
    //   (origin/main is 139; this branch is the +1.)
    // 140 -> 141 (2026-08-18): 150_doors_resolve_categories.sql — phase 3, the
    // three doors. MEASURED on a tree freshly rebased onto main, not derived by
    // adding one to the number above:
    //   ls db/migrations/*.sql | wc -l                             -> 141
    //   git ls-tree --name-only HEAD db/migrations/ | grep -c sql  -> 141
    //   (origin/main is 140; this branch is the +1.)
    // The same warning still applies verbatim: a sibling lane merging first
    // makes this line a guaranteed conflict, and the fix is to re-measure the
    // merged tree, never to add one.
    // 141 -> 142 (2026-08-18): 151_completion_gate_on_the_transition.sql —
    // phase 4, the completion gate moves onto the →done transition and
    // `task_workflows_structural_statuses` is dropped. MEASURED on this branch,
    // not derived:
    //   ls db/migrations/*.sql | wc -l                             -> 142
    //   git ls-tree --name-only HEAD db/migrations/ | grep -c sql  -> 142
    //   (origin/main is 141; this branch is the +1.)
    expect(server.appliedMigrations.length).toBe(142);
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
  // Chat is registered even without a provider runtime; the handler validates
  // the requested model/identity before returning its degraded-mode refusal.
  'chat.threads.start',
  // 2026-08-12: collections.addItem validates its body in-handler — the sweep's
  // synthetic path params name no real collection, a handler-reached 400.
  'collections.addItem',
  // 2026-08-07: credentials.delete reads `:provider` off the PATH and checks it
  // against the fixed three-value list BEFORE the value can name a directory.
  // The sweep supplies a synthetic path param, so the refusal is correct and
  // is handler-reached — the body schema (an optional clientMutationId) accepts
  // the sweep's `{}` fine, so this is not a :166 gate rejection.
  // The other three credentials.* operations are absent from this list on
  // purpose: the sweep authenticates as the loopback auto-owner, whose
  // `authKind` is `browser`, so the R2 guard ADMITS it and they answer
  // normally rather than 400.
  'credentials.delete',
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
  // 2026-08-10 (files consolidation): projects.files.read validates its `path`
  // query in-handler, and folderUploads.init validates its manifest in-handler;
  // the sweep's synthetic bodies reach both refusals.
  'projects.files.read',
  'projects.folderUploads.init',
  'savedViews.create',
  'savedViews.update',
  'spaces.create',
  'spaces.defaultChannel.set',
  'spaces.interactionProfile.setDefault',
  // 114: the sweep supplies a SYNTHETIC `:memberId` path param, and the handler
  // checks it is a uuid before it can reach SQL. Handler-reached, not a :166
  // gate rejection — the body (`{role: …}`) satisfies its schema fine.
  'spaces.members.updateRole',
  'spaces.menu.update',
  'spaces.taskAxes.create',
  'spaces.taskAxes.update',
  // W4/132: the synthetic `statuses` array satisfies the zod schema but not
  // the DATABASE's structural {open, working, done} constraint — the refusal
  // is the RPC's, reached through the handler. Handler evidence, not a :166
  // gate rejection.
  'spaces.taskWorkflows.upsert',
  'spaces.update',
  // 148: same shape one table over. The sweep's synthetic body satisfies the
  // zod schema but not the DATABASE's exactly-one-initial-state rule, so the
  // refusal is the RPC's, reached THROUGH the handler. Handler evidence, not
  // a :166 gate rejection.
  'spaces.workflows.upsert',
  'teamMembers.interactionProfile.setDefault',
];
