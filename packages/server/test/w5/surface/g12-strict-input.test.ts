/**
 * W5 Duo C — `interactionProfiles.propose` / `.updateDraft` STRICT INPUT.
 *
 * ── THE PREMISE, AND WHY IT SURVIVED WHEN OTHERS DID NOT ───────────────────
 * The packet recorded these two as "UNPROVEN, and explicitly not folded into
 * the eight passing verdicts". That is exactly right, and the reason is visible
 * in the code rather than inferred:
 * `test/w3/g12-g14-strict-input-unguarded.test.ts` DOES drive both, against a
 * real Server on the real chain, and then EXCLUDES them from every assertion:
 *
 *     :142  propose      validBody { clientMutationId, spaceId: '', draft: {} }   bodyIsFullyValid: FALSE
 *     :149  updateDraft  validBody { clientMutationId, expectedVersion: 1, draft: {} }  bodyIsFullyValid: FALSE
 *     :217  const provable = results.filter((row) => row.bodyIsFullyValid === true);
 *     :219-230  every assertion runs over `provable` ONLY.
 *
 * ⚠ THIS IS THE **MEASURED-BUT-NOT-ASSERTED** CATEGORY: the operation IS driven,
 * against a REAL server, on the REAL chain, the response IS captured — and then
 * deliberately excluded with a stated reason. EVERY SURFACE MARKER OF COVERAGE
 * IS PRESENT (a w3 public file, real requests, a green suite); only reading the
 * filter at `:217` says otherwise. **THAT FILE DID THE HONEST THING** — its
 * docstring pre-commits to saying so rather than counting it — and the defect
 * would be someone else counting it for them.
 *
 * ── WHY IT IS CHEAP NOW AND WAS NOT THEN ───────────────────────────────────
 * Its stated reason (`:136-138`) is sound: `draft` is a deep nested object
 * (`InteractionProfileDraftSchema`, schemas.ts:1470) and a HALF-BUILT draft
 * would CONFOUND the control — a refusal could be strictness or could be the
 * malformed draft, and the two are indistinguishable from the status code.
 *
 * That confound is now a solved problem: `internal.w2g12_core_draft()`
 * (`027:80-114`) is the canonical valid draft the migration itself ships, and
 * `activate.test.ts` has already proven it readable and end-to-end valid through
 * propose → validate → activate. So this file reads the draft from the DATABASE
 * and sends a FULLY VALID body — turning `bodyIsFullyValid` true and moving both
 * operations from UNPROVEN to proven-or-red.
 *
 * ── WHAT STRICTNESS MEANS HERE, AND WHICH LAYER ENFORCES IT ────────────────
 * Neither operation has an `INPUT_SCHEMAS` entry — they are G12, which
 * `facade/index.ts:155` records as parsing their own request bodies. So the
 * refusal comes from the HANDLER's `parseInput`, NOT from `server.ts:166`, and
 * this file asserts that distinction rather than assuming it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startSurfaceServer, type SurfaceServer } from './harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

/** The `:166` literal — its ABSENCE is what proves the handler refused. */
const GATE_LITERAL = 'request body failed contract validation';

describe('W5.C G12 propose/updateDraft — strict input, with a FULLY VALID body', () => {
  let server: SurfaceServer;
  let spaceId = '';
  let draft: unknown;

  beforeAll(async () => {
    server = await startSurfaceServer('g12strict');

    const sp = await server.request('POST', '/v2/spaces', {
      clientMutationId: 'w5c-g12-space', name: 'W5C G12',
    });
    spaceId = (sp.json as { data?: { space?: { id: string } } }).data?.space?.id ?? '';
    expect(spaceId).toBeTruthy();

    const rows = await server.database.query<{ draft: unknown }>(
      `select internal.w2g12_core_draft() as draft`,
    );
    draft = rows[0]?.draft;
    expect(draft, 'internal.w2g12_core_draft() must exist on the landed chain').toBeTruthy();
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  }, 120_000);

  /**
   * THE POSITIVE HALF — AND IT IS THE HALF THE EXISTING FILE COULD NOT BUILD.
   *
   * Without it, every strictness refusal below is satisfied by a handler that
   * rejects EVERYTHING, which is precisely the ambiguity `bodyIsFullyValid:
   * false` was recording.
   */
  it('POSITIVE: a fully valid propose body is ACCEPTED', async () => {
    const r = await server.request('POST', `/v2/spaces/${spaceId}/interaction-profiles`, {
      clientMutationId: 'w5c-g12-propose-ok', spaceId, draft,
    });
    expect(r.status, `a fully valid draft must be accepted: ${JSON.stringify(r.json)}`)
      .toBeLessThan(300);
  });

  /**
   * STRICTNESS AT `propose`, now DISCRIMINATING because the only difference from
   * the accepted body above is ONE UNKNOWN KEY. That is what makes this evidence
   * about strictness rather than about draft validity.
   */
  it('propose REFUSES an unknown top-level key — from the HANDLER, not :166', async () => {
    const r = await server.request('POST', `/v2/spaces/${spaceId}/interaction-profiles`, {
      clientMutationId: 'w5c-g12-propose-strict', spaceId, draft,
      __w5_unknown_key__: 'must be refused',
    });
    expect(r.status).toBe(400);
    expect(r.errorCode).toBe('invalid_input');
    // The operation has no INPUT_SCHEMAS entry, so this CANNOT be the :166 gate.
    expect(
      r.errorMessage,
      'this operation is unbound; a :166 literal here would mean the schema table now covers it '
        + 'and this test is measuring a different layer than it claims',
    ).not.toBe(GATE_LITERAL);
  });

  /** Strictness must reach INSIDE the nested draft, not only its top level. */
  it('propose REFUSES an unknown key nested INSIDE the draft', async () => {
    const poisoned = { ...(draft as Record<string, unknown>), __w5_nested_unknown__: 1 };
    const r = await server.request('POST', `/v2/spaces/${spaceId}/interaction-profiles`, {
      clientMutationId: 'w5c-g12-propose-nested', spaceId, draft: poisoned,
    });
    expect(r.status, `nested unknown key must be refused: ${JSON.stringify(r.json)}`).toBe(400);
    expect(r.errorCode).toBe('invalid_input');
    expect(r.errorMessage).not.toBe(GATE_LITERAL);
  });

  /**
   * `updateDraft` — the second operation the existing file could not prove.
   * Driven against a REAL proposed profile so the body is fully valid, which is
   * the same unblocking that made `propose` provable.
   */
  it('updateDraft: valid body ACCEPTED, unknown key REFUSED (both halves)', async () => {
    const proposed = await server.request('POST', `/v2/spaces/${spaceId}/interaction-profiles`, {
      clientMutationId: 'w5c-g12-ud-propose', spaceId, draft,
    });
    expect(proposed.status, JSON.stringify(proposed.json)).toBeLessThan(300);
    const profile = (proposed.json as {
      data?: { profileId: string; currentDraftVersion: number };
    }).data!;

    // POSITIVE
    const ok = await server.request(
      'PATCH', `/v2/interaction-profiles/${profile.profileId}/draft`,
      {
        clientMutationId: 'w5c-g12-ud-ok',
        expectedVersion: profile.currentDraftVersion,
        draft,
      },
    );
    expect(ok.status, `a fully valid updateDraft must be accepted: ${JSON.stringify(ok.json)}`)
      .toBeLessThan(300);

    // NEGATIVE — one unknown key, everything else identical.
    const strict = await server.request(
      'PATCH', `/v2/interaction-profiles/${profile.profileId}/draft`,
      {
        clientMutationId: 'w5c-g12-ud-strict',
        expectedVersion: profile.currentDraftVersion,
        draft,
        __w5_unknown_key__: 'must be refused',
      },
    );
    expect(strict.status).toBe(400);
    expect(strict.errorCode).toBe('invalid_input');
    expect(strict.errorMessage).not.toBe(GATE_LITERAL);
  });

  /**
   * WHAT THIS FILE DOES NOT ESTABLISH, named rather than left as an absence:
   * it proves STRICT INPUT for these two operations at the public boundary. It
   * says nothing about the SEMANTICS of a draft update — whether the stored
   * draft matches what was sent, whether versioning is correct, or whether the
   * G12 behavioural branches beyond strict-input are right. Those remain
   * unproven and are NOT folded into this result.
   */
  it('states its own boundary rather than implying a wider verdict', () => {
    expect(true).toBe(true);
  });
});
