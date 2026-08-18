/**
 * W5 Duo C — interactionProfiles.activate, driven END-TO-END THROUGH THE
 * COMPOSED PUBLIC HTTP SURFACE.
 *
 * ── WHAT THIS IS AND IS NOT A FIRST OF ─────────────────────────────────────
 * The packet that assigned this said activate had "NEVER BEEN SUCCESSFULLY
 * ACTIVATED BY ANYONE" and that it "needs a validated artifact plus a matching
 * hash no fixture could mint". THAT PREMISE IS DEAD, and it was killed before
 * this file was written rather than by it: `test/db/w2-profiles.pg.test.ts:410-433`
 * activates against real Postgres with a real minted hash asserted to match
 * `/^sha256:[a-f0-9]{64}$/`, and there are further activate call sites in that
 * same file. FIXTURES HAVE MINTED THAT HASH ROUTINELY FOR A WHOLE WAVE.
 *
 * The handler-level test that LOOKS like an activation
 * (`test/w2/entity-kinds-profiles.test.ts:273`) runs against a MOCK db with
 * `validatedHash: 'sha256:validated'` — a fake literal — and a call recorder. It
 * proves the handler calls the right RPC with the right arguments. IT IS NOT AN
 * ACTIVATION.
 *
 * So the honest claim this file establishes is NARROW AND STILL WORTH HAVING:
 * activation has never been driven end-to-end through the COMPOSED PUBLIC
 * SURFACE — propose → validate → activate over HTTP against the real
 * composition root. "First activation ever" would be false and the
 * counter-example is sitting in the tree.
 *
 * ── THE FOUR GATES, IN THE ORDER THEY ACTUALLY FIRE ────────────────────────
 * Read from `db/migrations/027_w2_entity_kinds_profiles.sql` directly:
 *   :1019  internal.require_human_space_admin(space)  → 42501 profile_principal_required
 *   :1020  status = 'retired'                         → 23514 profile_retired
 *   :1022  not confirm                                → 22023 (invalid_input, NO reason)
 *   :1026  version/validation_status/hash mismatch    → 23514 profile_not_validated
 * The FIRST one is the one an input-shaped recipe misses, because it is not
 * about the input at all.
 *
 * ── THE FIXTURE TRAP THIS FILE DEFUSES STRUCTURALLY ────────────────────────
 * `require_human_space_admin` (`015_w1_foundations.sql:1144-1165`) demands
 * `internal.acting_as() IS NULL` — agent delegation is refused outright — plus
 * owner/admin membership of the target space. And `requestEnvelope` takes
 * `actorId` from `ctx.identity.actorId ?? bodyEnvelope.actorId`, SO A
 * SCHEMA-VALID `actorId` IN A GENERATED BODY REACHES THE CLAIMS AND FAILS THAT
 * GATE. The resulting 403 looks exactly like an authorization defect and is
 * entirely the fixture's fault.
 *
 * This file therefore ASSERTS the absence of `actorId` rather than relying on
 * the generator happening to omit an optional field. A 403
 * `profile_principal_required` here is a FIXTURE ERROR with that reason named in
 * the failure text — never a finding.
 *
 * ── THE DRAFT IS READ FROM THE DATABASE, NOT HAND-WRITTEN ──────────────────
 * `internal.w2g12_core_draft()` (`027:80-114`) is the canonical valid draft that
 * migration ships. Using it removes the largest source of false reds — a draft
 * that is merely schema-valid but names a template the validator does not ship
 * (`internal.w2g12_static_chat_template` ships EXACTLY ONE: `tm8.chat.core` v1).
 * A hand-written draft would make every failure ambiguous between "activate is
 * broken" and "my draft was wrong".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ProposeInteractionProfileInputSchema } from '@tm8/contract';

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


interface ProfileView {
  readonly profileId: string;
  readonly spaceId: string;
  readonly status: 'draft' | 'active' | 'retired';
  readonly currentDraftVersion: number;
  readonly validatedVersion: number | null;
  readonly activeVersion?: number | null;
  readonly validatedHash?: string | null;
}

interface ValidationView {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly status: 'valid' | 'invalid';
  readonly validatedHash: string | null;
  readonly issues: ReadonlyArray<{ path: string; code: string; message: string }>;
}

/** Maps a refusal back to the gate that produced it, per 027's own ordering. */
function diagnose(status: number, code: string | null, details: unknown): string {
  const reason = (details as { reason?: string } | undefined)?.reason;
  if (code === 'forbidden' || reason === 'profile_principal_required') {
    return 'GATE :1019 require_human_space_admin — THIS IS A FIXTURE ERROR, NOT A FINDING. '
      + 'Either an actorId reached the claims (agent delegation is refused outright), or the '
      + 'acting identity is not an owner/admin member of the target space.';
  }
  if (reason === 'profile_retired') return 'GATE :1020 — the profile is retired. Lifecycle, not input.';
  if (reason === 'profile_not_validated') {
    return 'GATE :1026 — validation did not yield status=valid, or the '
      + 'validatedVersion/validatedHash pair does not match the stored row.';
  }
  if (code === 'invalid_input' && reason === undefined) {
    return 'GATE :1022 — confirm was not true. Note this fails DIFFERENTLY from the others: '
      + 'invalid_input with no details.reason.';
  }
  if (code === 'not_implemented') {
    return 'UNEXPECTED 501. Nothing in activate_interaction_profile raises not_implemented or '
      + '0A000, so this is router-unmounted or Postgres-origin — NOT a handler stub. '
      + 'Check the registry mount first.';
  }
  return `unmapped refusal: status=${status} code=${String(code)} reason=${String(reason)}`;
}

describe('W5.C interactionProfiles.activate through the composed public surface', () => {
  let server: SurfaceServer;

  beforeAll(async () => {
    server = await startSurfaceServer('activate');
  }, 180_000);

  // Explicit: `afterAll` is configured independently of `beforeAll` and defaults
  // to 10s. This teardown drops a scratch database over a fresh admin
  // connection, which does not fit in 10s under load — and a teardown timeout
  // aborts the FILE with no failing test name, so it cannot be subset-matched
  // against an expected-failure set. See sweep.test.ts for the full note.
  afterAll(async () => {
    await server?.close();
  }, 120_000);

  it('proposes, validates and ACTIVATES an interaction profile over HTTP', async () => {
    // ---- fixture: a space whose creator is its owner member -----------------
    const spaceResponse = await server.request('POST', '/v2/spaces', {
      clientMutationId: 'w5c-activate-space',
      name: 'W5C Activation',
    });
    expect(spaceResponse.status, JSON.stringify(spaceResponse.json)).toBe(201);
    const spaceId = (spaceResponse.json as { data?: { space?: { id?: string } } })
      .data?.space?.id;
    expect(spaceId).toBeTruthy();

    // The gate is about MEMBERSHIP AND ROLE, so assert them rather than assume
    // that "created the space" implies "owner". A red here is the fixture.
    const admins = await server.database.query<{ role: string }>(
      `select role from public.members where space_id = $1`,
      [spaceId],
    );
    expect(
      admins.map((r) => r.role),
      'require_human_space_admin needs an owner/admin member of THIS space',
    ).toContain('owner');

    // ---- the canonical draft, read from the migration that ships it --------
    const draftRows = await server.database.query<{ draft: unknown }>(
      `select internal.w2g12_core_draft() as draft`,
    );
    const draft = draftRows[0]?.draft;
    expect(draft, 'internal.w2g12_core_draft() must exist on the landed chain').toBeTruthy();

    // ---- propose ------------------------------------------------------------
    const proposeBody = {
      clientMutationId: 'w5c-activate-propose',
      spaceId,
      draft,
    };

    // THE STRUCTURAL DEFUSAL. Assert no actorId anywhere in the body, and assert
    // the contract schema accepts what we are about to send, so a 400 can never
    // be confused with a gate refusal.
    expect(Object.keys(proposeBody)).not.toContain('actorId');
    expect(
      ProposeInteractionProfileInputSchema.safeParse(proposeBody).success,
      'propose body must be schema-valid before it can test anything else',
    ).toBe(true);

    const proposed = await server.request(
      'POST', `/v2/spaces/${spaceId}/interaction-profiles`, proposeBody,
    );
    expect(
      proposed.status,
      `propose failed: ${diagnose(proposed.status, proposed.errorCode, proposed.errorDetails)}\n`
        + JSON.stringify(proposed.json),
    ).toBeLessThan(300);

    const profile = (proposed.json as { data?: ProfileView }).data!;
    expect(profile.status).toBe('draft');

    // ---- validate -----------------------------------------------------------
    const validated = await server.request(
      'POST', `/v2/interaction-profiles/${profile.profileId}/validate`,
      {
        clientMutationId: 'w5c-activate-validate',
        expectedVersion: profile.currentDraftVersion,
      },
    );
    expect(
      validated.status,
      `validate failed: ${diagnose(validated.status, validated.errorCode, validated.errorDetails)}\n`
        + JSON.stringify(validated.json),
    ).toBeLessThan(300);

    const validation = (validated.json as { data?: ValidationView }).data!;

    // The issues[] array is the diagnostic the whole recipe hinges on: an
    // INVALID result names the exact draft field that failed, and without it a
    // downstream `profile_not_validated` is uninterpretable.
    expect(
      validation.status,
      `validation returned INVALID. issues[] verbatim:\n${JSON.stringify(validation.issues, null, 2)}`,
    ).toBe('valid');
    expect(validation.validatedHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    // ---- activate -----------------------------------------------------------
    const activated = await server.request(
      'POST', `/v2/interaction-profiles/${profile.profileId}/activate`,
      {
        clientMutationId: 'w5c-activate-activate',
        validatedVersion: validation.profileVersion,
        validatedHash: validation.validatedHash,
        confirm: true, // :1022 — mandatory, and it fails differently from the rest
      },
    );
    expect(
      activated.status,
      `ACTIVATE failed: ${diagnose(activated.status, activated.errorCode, activated.errorDetails)}\n`
        + JSON.stringify(activated.json),
    ).toBeLessThan(300);

    const active = (activated.json as { data?: ProfileView }).data!;
    expect(active.status).toBe('active');
    expect(active.activeVersion ?? active.validatedVersion).toBe(validation.profileVersion);

    // Confirm at the STORAGE layer too, not only in the response envelope — a
    // response is what the handler said, a row is what happened.
    const stored = await server.database.query<{ status: string; active_version: number }>(
      `select status, active_version from public.interaction_profiles where entity_id = $1`,
      [profile.profileId],
    );
    expect(stored[0]?.status).toBe('active');
    expect(stored[0]?.active_version).toBe(validation.profileVersion);
  }, 180_000);

  /**
   * NEGATIVE CONTROL — without it, the test above is satisfied by an activate
   * that activates unconditionally. `confirm` is the cheapest gate to probe and
   * `:1022` is the one that fails DIFFERENTLY (invalid_input with no
   * `details.reason`), so it also proves the diagnostic mapping discriminates
   * rather than reporting one label for everything.
   */
  it('NEGATIVE: a wrong hash and a missing confirm are both refused, and differently', async () => {
    const spaceResponse = await server.request('POST', '/v2/spaces', {
      clientMutationId: 'w5c-activate-neg-space', name: 'W5C Activation Negative',
    });
    const spaceId = (spaceResponse.json as { data?: { space?: { id?: string } } }).data?.space?.id;
    const draftRows = await server.database.query<{ draft: unknown }>(
      `select internal.w2g12_core_draft() as draft`,
    );

    const proposed = await server.request('POST', `/v2/spaces/${spaceId}/interaction-profiles`, {
      clientMutationId: 'w5c-activate-neg-propose', spaceId, draft: draftRows[0]?.draft,
    });
    const profile = (proposed.json as { data?: ProfileView }).data!;

    const validated = await server.request(
      'POST', `/v2/interaction-profiles/${profile.profileId}/validate`,
      { clientMutationId: 'w5c-activate-neg-validate', expectedVersion: profile.currentDraftVersion },
    );
    const validation = (validated.json as { data?: ValidationView }).data!;
    expect(validation.status).toBe('valid');

    // (a) correct shape, WRONG HASH -> :1026 profile_not_validated
    const wrongHash = await server.request(
      'POST', `/v2/interaction-profiles/${profile.profileId}/activate`,
      {
        clientMutationId: 'w5c-activate-neg-hash',
        validatedVersion: validation.profileVersion,
        validatedHash: `sha256:${'0'.repeat(64)}`,
        confirm: true,
      },
    );
    expect(wrongHash.status).toBeGreaterThanOrEqual(400);
    expect((wrongHash.errorDetails as { reason?: string } | undefined)?.reason)
      .toBe('profile_not_validated');

    // (b) correct hash, confirm omitted.
    //
    // I FIRST ASSERTED THIS WOULD CARRY THE `:166` LITERAL. IT DOES NOT, AND THE
    // ASSERTION WAS WRONG AGAINST A FACT MY OWN SWEEP HAD ALREADY MEASURED:
    // `interactionProfiles.activate` HAS NO `INPUT_SCHEMAS` ENTRY — it is one of
    // the 44 unbound operations, recorded as `nobody` in the sweep table — so
    // there is no `:166` gate on this route at all.
    //
    // What refuses it is the HANDLER'S OWN parse:
    // `services/w2/entity-kinds-profiles.ts:283` calls
    // `parseInput(ActivateInteractionProfileInputSchema, ctx.body, …)`, which is
    // exactly what `facade/index.ts:155` says about G12/G13 — "each parses its
    // own request bodies, which is why none of them appear in INPUT_SCHEMAS".
    // The message is zod's own, unwrapped: 'Invalid literal value, expected true'.
    //
    // SO THIS IS A HANDLER-REACHED REFUSAL, not a gate rejection, and it
    // corroborates the sweep's classification of this operation rather than
    // contradicting it. The SQL check at `027:1022` is therefore unreachable for
    // an OMITTED confirm over HTTP — it still guards a non-HTTP caller, and the
    // two are not redundant.
    const noConfirm = await server.request(
      'POST', `/v2/interaction-profiles/${profile.profileId}/activate`,
      {
        clientMutationId: 'w5c-activate-neg-confirm',
        validatedVersion: validation.profileVersion,
        validatedHash: validation.validatedHash,
      },
    );
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.errorCode).toBe('invalid_input');
    expect(noConfirm.errorMessage).toBe('Invalid literal value, expected true');
    // The load-bearing half: it is NOT the :166 literal, which is what proves
    // the refusal came from the handler rather than from the schema table.
    expect(noConfirm.errorMessage).not.toBe('request body failed contract validation');

    // And the profile is STILL a draft after both refusals — a guard that
    // refuses and mutates anyway would pass both assertions above.
    const stored = await server.database.query<{ status: string }>(
      `select status from public.interaction_profiles where entity_id = $1`,
      [profile.profileId],
    );
    expect(stored[0]?.status).toBe('draft');
  }, 180_000);
});
