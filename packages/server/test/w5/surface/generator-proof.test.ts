/**
 * W5 Duo C — PROBE THE PROBE.
 *
 * The sweep in `sweep.test.ts` reads a 501 as evidence about a HANDLER. That
 * reading holds only if the body reached the handler, and it reaches the handler
 * only if `INPUT_SCHEMAS` accepted it at `server.ts:166`. So the generator is
 * load-bearing for every conclusion the sweep draws, and it is gated here,
 * in-process, before a single request is sent.
 *
 * BOTH HALVES, per the instrument rules. A generator proof that only asserts
 * "every emitted body parses" is satisfiable by a schema table that accepts
 * everything — including an empty object, which is exactly the state the sweep
 * exists to see past. So the negative control asserts the opposite thing: that
 * an EMPTY body is REJECTED by these same schemas. If both halves are green, the
 * schemas discriminate and the generator clears them. If the negative half goes
 * red for an operation, that operation's schema does not actually gate anything
 * and the no-body probe already reached its handler — which is a finding about
 * the sizing, not about the generator.
 */
import { INPUT_SCHEMAS } from '../../../src/facade/input-schemas.js';
import { describe, expect, it, vi } from 'vitest';
import type { ZodTypeAny } from 'zod';

import { bodyFor } from './body-gen.js';

/**
 * ⚠ BOTH DEFAULTS, SET AT ONE POINT. VITEST SHIPS TWO INDEPENDENT TIMEOUTS AND A
 * GENEROUS `beforeAll` ARGUMENT COVERS NEITHER:
 *   testTimeout   5s  -> a NAMED test failure
 *   hookTimeout  10s  -> an UNNAMED file-level abort
 *
 * This file spawns no server, but it REGENERATES ALL 54 SCHEMA BODIES inside
 * single assertions, which is CPU-bound. On a host measured swinging between 2.7x and 6x
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
const ENTRIES = Object.entries(SCHEMAS).filter(
  (entry): entry is [string, ZodTypeAny] => entry[1] !== undefined,
);

describe('W5.C generator proof', () => {
  it('POSITIVE: every generated body is accepted by the schema it was generated from', () => {
    const failures: string[] = [];

    for (const [opName, schema] of ENTRIES) {
      const body = bodyFor(opName, schema);
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        failures.push(
          `${opName}: ${JSON.stringify(body)} -> ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}:${issue.message}`)
            .join(' | ')}`,
        );
      }
    }

    expect(
      failures,
      `generator emitted ${failures.length}/${ENTRIES.length} bodies the schema REJECTS. `
        + 'Every one of these would arrive in the sweep as a 400 at server.ts:166 and read '
        + `as a handler refusal:\n${failures.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * NEGATIVE CONTROL. Without this, the positive half above is satisfied by a
   * table of `z.any()`.
   *
   * A schema that accepts `{}` is not a defect — it means the existing no-body
   * probe ALREADY reached that handler, so the operation belongs in the
   * "already handler-reached" bucket rather than the "needs a generated body"
   * bucket. The assertion is therefore an exact-set assertion against a recorded
   * literal, not an emptiness assertion: it pins WHICH operations are permissive
   * so a future schema loosening shows up as a red rather than as a quietly
   * larger free half.
   */
  it('NEGATIVE: every bound schema rejects the value a NO-BODY request actually produces', () => {
    // `readJsonBody` returns `{ value: undefined }` for a zero-length body
    // (`src/http/body.ts:64`) — NOT `{}`. `undefined` is what the existing
    // no-body probe puts in front of `validate()` at `server.ts:167`, so
    // `undefined` is the value this control must use. Asserting against `{}`
    // instead would measure a request nobody sends.
    const reachedAnyway = ENTRIES
      .filter(([, schema]) => schema.safeParse(undefined).success)
      .map(([opName]) => opName)
      .sort();

    expect(
      reachedAnyway,
      'A bound schema accepting `undefined` would already be handler-reached by the no-body '
        + 'probe, and this duo would not need to generate a body for it.',
    ).toEqual([]);
  });

  /**
   * A SEPARATE, WEAKER FACT, recorded as an exact set rather than folded into
   * the control above.
   *
   * Six bound schemas accept `{}` even though none accepts `undefined`. That
   * does NOT make them handler-reached by the existing probe — the probe sends
   * no body at all — but it does mean the cheapest possible body reaches their
   * handlers, and it is the shape a future schema loosening would take. Pinned
   * as a frozen literal so growth is a red, never a quietly larger free half.
   */
  it('pins the exact set of bound schemas that accept a bare {}', () => {
    const permissive = ENTRIES
      .filter(([, schema]) => schema.safeParse({}).success)
      .map(([opName]) => opName)
      .sort();

    expect(permissive).toEqual([
      // 2026-08-02: auth.logout's only field is an optional sessionId — a bare
      // {} means "revoke the session presented in the Authorization header".
      'auth.logout',
      // 2026-08-07: both credential command bodies carry ONLY an optional
      // clientMutationId. The subject of each rides the PATH — the provider for
      // `delete`, the work session id for `finish` — and neither DTO declares a
      // field naming whose credential to act on, because the account is derived
      // inside the RPC from the bound identity. A bare {} is the normal body.
      // `credentials.loginSessions.start` is deliberately NOT here: it requires
      // spaceId and provider, so {} is correctly refused.
      'credentials.delete',
      'credentials.loginSessions.finish',
      'entityKinds.update',
      // 2026-08-12 (Git UI landing): the two git verbs whose bodies are
      // all-optional — a bare {} checkpoint takes the default label; a bare {}
      // merge pulls the session base forward.
      'execution.gitCheckpoint',
      'execution.gitMerge',
      'execution.terminate',
      'files.uploadAbort',
      'projects.update',
      'spaces.update',
      'tracking.refresh',
      // 2026-07-31: voice.token.create's whole input is the optional command
      // context — the target rides the path, so a bare {} is a valid body.
      'voice.token.create',
    ]);
  });

  /**
   * MUTATION OF THE PROOF ITSELF. A deliberately wrong body must be REJECTED by
   * the same code path that green-lit the real one. Without this, both tests
   * above pass against a `safeParse` that was accidentally inverted or stubbed.
   */
  it('MUTATION: a deliberately invalid body is rejected by the same safeParse path', () => {
    const survivors: string[] = [];

    for (const [opName, schema] of ENTRIES) {
      // `.strict()` DTOs reject unknown keys; every INPUT_SCHEMAS entry the
      // contract names is strict, so this key must fail all of them.
      const poisoned = { ...(bodyFor(opName, schema) as Record<string, unknown>), __w5_not_a_field__: 1 };
      if (schema.safeParse(poisoned).success) survivors.push(opName);
    }

    expect(
      survivors,
      `${survivors.length} schemas accepted an unknown key, so they are not .strict() and `
        + 'this mutation cannot prove those rows discriminate: ' + survivors.join(','),
    ).toEqual([]);
  });

  it('pins the bound-schema count as an exact literal', () => {
    // 54 -> 64 on 2026-07-31: the consolidation wave bound ten more DTOs.
    // 64 -> 65 on 2026-08-01: execution.journal bound its query schema.
    // 65 -> 66 on 2026-08-01: identity.profile.update bound its input DTO.
    // 66 -> 69 on 2026-08-02: auth.signup/login/logout bound their input DTOs.
    // 69 -> 70: entities.commands.gate; 70 -> 73: credentials.* command bodies.
    // 73 -> 74: projects.files.attach.
    // 74 -> 75 (2026-08-09, merge): execution.dispatch.
    // 80 -> 84 (2026-08-12, Git UI landing): the four execution.git* command
    // bodies bind.
    // 84 -> 87 (2026-08-12): the three Tier 2 command bodies bind.
    // +1 (2026-08-13, merge): execution.terminal.start binds its body.
    // +1 (2026-08-13, forge write): tracking.pr.merge binds its body.
    expect(ENTRIES).toHaveLength(93); // + chat.threads.start disposition; +2 (114): spaces.members.updateRole, auth.invite.resolve
  });
});
