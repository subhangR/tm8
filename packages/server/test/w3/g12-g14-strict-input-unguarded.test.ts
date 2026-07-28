import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startW3PublicServer, successData, type W3PublicServer } from './public-harness.js';

/**
 * W3 — STRICT-INPUT PROOF for the operations that OPT OUT of the shared guard.
 *
 * WHY THESE TEN AND NOT OTHERS. `server.ts:166` reads `INPUT_SCHEMAS[opName]`
 * and applies the shared strict guard ONLY where an entry exists; where it is
 * `undefined` the router does nothing. Composing tranche-v3 took two OPPOSITE
 * resolutions to that one fact:
 *   - G04's service casts `ctx.body` straight to its contract DTO, so its five
 *     remaining commands were BOUND into `INPUT_SCHEMAS` (`:130`-`:140`);
 *   - G12/G13/G14 were left UNBOUND on the stated ground that "each parses its
 *     own request bodies".
 * §4 of the evidence law requires every accepted operation to reject unknown
 * keys with the closed error envelope. For these ten that property rests
 * entirely on per-handler ad-hoc parsing, and the only evidence for it is a code
 * comment. §7.6 already recorded one case where five groups were safe for five
 * different ad-hoc reasons and the sixth was wrong until an audit found it — the
 * reassuring claim being the one nobody checked. So this file MEASURES it.
 *
 * THE DISCRIMINATOR, AND WHY THE CONTROL IS NOT OPTIONAL. A 400 alone proves
 * nothing: almost any malformed request produces one. Each operation is
 * therefore probed TWICE:
 *   - CONTROL: an otherwise schema-valid body. This must NOT be refused as
 *     `invalid_input` — it must get PAST the parse and fail (or succeed) on
 *     something else, which is what proves the body shape is acceptable.
 *   - PROBE: the identical body plus ONE unknown key. This must be refused as
 *     `invalid_input`, and the refusal must NAME the offending key.
 * If both probes return the same thing, strictness is UNPROVEN for that
 * operation and this file says so rather than counting it as covered.
 *
 * Route resources are deliberately mostly FAKE uuids. Every handler runs its
 * parse immediately after `requireUuidParam` and BEFORE any database call
 * (entity-kinds-profiles.ts:186/209/229/243/257/270/283/295/307/320,
 * menu-default-channel.ts:144/165), so a rejected body never depends on the
 * resource existing — and the control failing with `not_found` rather than
 * `invalid_input` is itself the evidence that the parse was passed.
 *
 * MIGRATIONS: full official chain via `migrationFiles()`, applied by
 * `startW3PublicServer`.
 */

const PROBE_KEY = 'w3UnknownProbeKey';

interface Probe {
  readonly operation: string;
  readonly method: string;
  /** Built once `spaceId` exists. */
  readonly path: (spaceId: string) => string;
  readonly validBody: Record<string, unknown>;
  /**
   * False where a fully valid body needs a deep nested fixture this file
   * deliberately does not build. Recorded, never silently downgraded.
   */
  readonly bodyIsFullyValid: boolean;
}

const FAKE_PROFILE = randomUUID();
const FAKE_TEAM_MEMBER = randomUUID();

const PROBES: readonly Probe[] = [
  {
    operation: 'spaces.defaultChannel.set',
    method: 'PUT',
    path: (s) => `/v2/spaces/${s}/default-channel`,
    validBody: { clientMutationId: 'w3-strict-dc', expectedSettingsRevision: 1, channelId: null },
    bodyIsFullyValid: true,
  },
  {
    operation: 'spaces.menu.update',
    method: 'PUT',
    path: (s) => `/v2/spaces/${s}/menu`,
    validBody: {
      clientMutationId: 'w3-strict-menu',
      expectedRevision: 1,
      payload: { schemaVersion: 1, groups: [] },
    },
    bodyIsFullyValid: true,
  },
  {
    operation: 'spaces.interactionProfile.setDefault',
    method: 'PUT',
    path: (s) => `/v2/spaces/${s}/interaction-profile-default`,
    validBody: {
      clientMutationId: 'w3-strict-space-prof',
      expectedSettingsRevision: 1,
      profileId: null,
    },
    bodyIsFullyValid: true,
  },
  {
    operation: 'teamMembers.interactionProfile.setDefault',
    method: 'PUT',
    path: () => `/v2/team-members/${FAKE_TEAM_MEMBER}/interaction-profile-default`,
    validBody: { clientMutationId: 'w3-strict-tm-prof', expectedVersion: 1, profileId: null },
    bodyIsFullyValid: true,
  },
  {
    operation: 'interactionProfiles.validate',
    method: 'POST',
    path: () => `/v2/interaction-profiles/${FAKE_PROFILE}/validate`,
    validBody: { clientMutationId: 'w3-strict-validate', expectedVersion: 1 },
    bodyIsFullyValid: true,
  },
  {
    operation: 'interactionProfiles.preview',
    method: 'POST',
    path: () => `/v2/interaction-profiles/${FAKE_PROFILE}/preview`,
    validBody: { profileVersion: 1 },
    bodyIsFullyValid: true,
  },
  {
    operation: 'interactionProfiles.activate',
    method: 'POST',
    path: () => `/v2/interaction-profiles/${FAKE_PROFILE}/activate`,
    validBody: {
      clientMutationId: 'w3-strict-activate',
      validatedVersion: 1,
      validatedHash: 'deadbeef',
      confirm: true,
    },
    bodyIsFullyValid: true,
  },
  {
    operation: 'interactionProfiles.retire',
    method: 'POST',
    path: () => `/v2/interaction-profiles/${FAKE_PROFILE}/retire`,
    validBody: { clientMutationId: 'w3-strict-retire', expectedVersion: 1, confirm: true },
    bodyIsFullyValid: true,
  },
  {
    // `draft` is a deep nested policy object (InteractionProfileDraftSchema,
    // schemas.ts:1425). Not built here: the top-level strict check is what is
    // under test, and a half-built draft would confound the control.
    operation: 'interactionProfiles.propose',
    method: 'POST',
    path: (s) => `/v2/spaces/${s}/interaction-profiles`,
    validBody: { clientMutationId: 'w3-strict-propose', spaceId: '', draft: {} },
    bodyIsFullyValid: false,
  },
  {
    operation: 'interactionProfiles.updateDraft',
    method: 'PATCH',
    path: () => `/v2/interaction-profiles/${FAKE_PROFILE}/draft`,
    validBody: { clientMutationId: 'w3-strict-draft', expectedVersion: 1, draft: {} },
    bodyIsFullyValid: false,
  },
];

describe.sequential('W3 strict-input on the ten operations outside INPUT_SCHEMAS', () => {
  let harness: W3PublicServer;
  let spaceId = '';

  const results: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    harness = await startW3PublicServer('strictinput');
    const space = successData<{ space: { id: string } }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-strict-space',
        name: 'W3 strict-input Space',
      }),
    );
    spaceId = space.space.id;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  it('refuses an unknown key on every one of the ten, and names it', async () => {
    for (const probe of PROBES) {
      const path = probe.path(spaceId);
      const body = { ...probe.validBody };
      if (probe.operation === 'interactionProfiles.propose') body['spaceId'] = spaceId;
      if (probe.operation === 'spaces.menu.update') {
        // A menu payload cannot be synthesised: `validateMenu` (schemas.ts:1026)
        // requires a `settings` ref to be present, so `groups: []` is never
        // valid. Read the Space's CURRENT menu and echo it back — which is what
        // a real client does, and which guarantees the control body is valid
        // without this file hand-rolling a menu it would have to keep in sync.
        const current = successData<{ schemaVersion: number; revision: number; groups: unknown[] }>(
          await harness.request('GET', `/v2/spaces/${spaceId}/menu`),
        );
        body['expectedRevision'] = current.revision;
        body['payload'] = { schemaVersion: current.schemaVersion, groups: current.groups };
      }

      const control = await harness.request(probe.method, path, body);
      const probed = await harness.request(probe.method, path, { ...body, [PROBE_KEY]: 'x' });

      const controlCode = control.body.error?.code ?? null;
      const probedCode = probed.body.error?.code ?? null;
      const probedMessage = JSON.stringify(probed.body);

      results.push({
        operation: probe.operation,
        bodyIsFullyValid: probe.bodyIsFullyValid,
        controlStatus: control.status,
        controlCode,
        probedStatus: probed.status,
        probedCode,
        namesTheKey: probedMessage.includes(PROBE_KEY),
      });
    }

    // eslint-disable-next-line no-console
    console.log('[W3 strict-input probe]', JSON.stringify(results, null, 2));

    // THE LAW, for every operation whose control body is genuinely valid: the
    // unknown key must be refused as invalid_input AND named, while the control
    // must get past the parse. An operation that merely CASTS its body would
    // accept the unknown key and fail this.
    const provable = results.filter((row) => row.bodyIsFullyValid === true);
    expect(provable.length, 'no operation had a constructible valid body').toBeGreaterThan(0);
    for (const row of provable) {
      expect(row, `${String(row.operation)}: unknown key was not refused`).toMatchObject({
        probedCode: 'invalid_input',
        namesTheKey: true,
      });
      expect(
        row.controlCode,
        `${String(row.operation)}: the CONTROL body was also refused as invalid_input, so the ` +
          'probe proves nothing — the parse was never passed',
      ).not.toBe('invalid_input');
    }
  }, 120_000);

  /**
   * The two draft-carrying operations, reported rather than asserted. Their
   * control bodies are deliberately incomplete, so a matching refusal is
   * ambiguous between "strict rejected the unknown key" and "the draft was
   * invalid anyway". Recorded as measured coverage, not claimed as proof.
   */
  it('records the two operations whose strictness this probe cannot isolate', () => {
    const unprovable = results.filter((row) => row.bodyIsFullyValid === false);
    expect(unprovable).toHaveLength(2);
    for (const row of unprovable) {
      // Whatever else is true, an unknown key must never be ACCEPTED.
      expect(row.probedStatus, `${String(row.operation)} accepted an unknown key`).toBeGreaterThanOrEqual(400);
    }
  });
});
