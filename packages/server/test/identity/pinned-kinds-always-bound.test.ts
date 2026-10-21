/**
 * B20 (Q15): `sessionSpacePin` by kind x TM8_SPACE_SESSIONS mode.
 *
 * `TM8_SPACE_SESSIONS=off` is W3's kill switch. It takes back the HUMAN
 * `auth.space.enter` pins W3 added — and, until this file, it also un-pinned
 * the three kinds 226's `auth_sessions_pinned_kinds_have_space` forces a
 * `space_id` onto. On an `off` node that turned every agent and agent_runtime
 * bearer into a cross-Space credential for its whole identity, because
 * `internal.member_space_ids()` stops intersecting (227) once the claim is
 * gone. No operator asked for that by switching W3 off.
 *
 * So the table below is the contract, not an implementation detail: the pin is
 * a property of the CREDENTIAL for agent, agent_runtime and link, and a
 * property of the MODE only for a human row. It is the same argument
 * `viaLinkId` (256, W7p) already carries in this file's source — the pin only
 * ever narrows, so no mode may un-bind it.
 *
 * The SQL-side half of this (what the claim then does to every membership
 * helper) is `test/db/cross-space-token.pg.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { CollabError } from '@tm8/contract';
import { identityFromSession } from '../../src/http/identity-resolver.js';
import type { SpaceSessionsMode } from '../../src/http/types.js';
import type { ResolvedAuthSession } from '../../src/identity/pg-auth.js';

const SPACE = '00000000-0000-4000-8000-0000000000aa';

/** A verified `resolve_auth_session` row of `kind`, carrying `spaceId`. */
function row(kind: string, spaceId: string | null): ResolvedAuthSession {
  return {
    sessionId: '00000000-0000-4000-8000-000000000001',
    accountId: 'account', identityId: 'identity', username: 'h', displayName: null,
    isNodeAdmin: false, isOwner: false, kind: kind as ResolvedAuthSession['kind'],
    actingAsTeamMemberId: null, workSessionId: null, runtimeMemberId: null,
    runtimeThreadRootId: null, runtimeChatId: null, runtimeEpoch: null,
    runtimeNativeGeneration: null,
    spaceId, expiresAt: '2026-12-01T00:00:00.000Z', label: null,
  };
}

const MODES = ['off', 'agents', 'enforce'] as const satisfies readonly SpaceSessionsMode[];

/** 226's CHECK names exactly these: a row of this kind cannot exist unpinned. */
const ALWAYS_PINNED = ['agent', 'agent_runtime', 'link'] as const;

describe('sessionSpacePin — the pinned kinds bind in every spaces mode (B20/Q15)', () => {
  for (const kind of ALWAYS_PINNED) {
    for (const mode of MODES) {
      it(`${kind} under ${mode}: pinned to the row's space`, () => {
        const identity = identityFromSession(row(kind, SPACE), 'bearer', mode);
        expect(identity.sessionSpaceId).toBe(SPACE);
        // K6 (W3): a space-pinned session never carries node-admin power.
        expect(identity.nodeAdmin).toBe(false);
      });
    }

    // Unreachable through SQL while 226's CHECK stands. Asserted anyway,
    // because the fail-OPEN answer here (bind nothing, answer for every Space
    // the identity belongs to) is exactly the leak B20 closes, and a future
    // migration that relaxes the CHECK must break loudly instead.
    it(`${kind} with no space is REFUSED, not bound to the empty pin`, () => {
      // B32: and the operator is told, not just the caller. Spied, not
      // silenced, so the log stays part of the contract.
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        for (const mode of MODES) {
          expect(() => identityFromSession(row(kind, null), 'bearer', mode))
            .toThrow(CollabError);
          expect(() => identityFromSession(row(kind, null), 'bearer', mode))
            .toThrow(/not bound to a space/);
        }
        expect(logged).toHaveBeenCalledTimes(MODES.length * 2);
        const [line] = logged.mock.calls.at(-1)!;
        expect(line).toContain('BROKEN INVARIANT');
        expect(line).toContain(row(kind, null).sessionId);
        expect(line).toContain(kind);
        // The token never reaches the log.
        expect(line).not.toContain('bearer');
      } finally {
        logged.mockRestore();
      }
    });
  }

  // The human half, unchanged: `off` is still the kill switch for W3's own
  // pins, and a GATE session (space_id null, what `issue_auth_session` mints)
  // binds nothing under any mode.
  for (const kind of ['browser', 'cli'] as const) {
    it(`${kind} entered into a space: pinned under agents and enforce, unpinned under off`, () => {
      expect(identityFromSession(row(kind, SPACE), 'bearer', 'off').sessionSpaceId).toBeUndefined();
      expect(identityFromSession(row(kind, SPACE), 'bearer', 'agents').sessionSpaceId).toBe(SPACE);
      expect(identityFromSession(row(kind, SPACE), 'bearer', 'enforce').sessionSpaceId).toBe(SPACE);
    });

    it(`${kind} gate session (no space): unpinned under every mode, and keeps its node-admin power`, () => {
      for (const mode of MODES) {
        const identity = identityFromSession({ ...row(kind, null), isNodeAdmin: true }, 'bearer', mode);
        expect(identity.sessionSpaceId).toBeUndefined();
        expect(identity.nodeAdmin).toBe(true);
      }
    });
  }
});
