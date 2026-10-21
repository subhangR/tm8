/**
 * Q15 (plan §13) and B20: `sessionSpacePin` as a kind × TM8_SPACE_SESSIONS table.
 *
 * THE QUESTION t-provenance was asked to settle: are `agent` / `agent_runtime`
 * claims narrowed to the session's own Space, or do they list every Space like
 * other bearers?
 *
 * THE ANSWER, pinned below: narrowed, in EVERY mode. 226's
 * `auth_sessions_pinned_kinds_have_space` CHECK forces a `space_id` onto the
 * three kinds, `identityFromSession` binds `tm8.session_space_id` from that
 * verified row, and every membership helper intersects with the claim (227).
 *
 * IT WAS NOT ALWAYS SO, and the history is the reason this table is the
 * contract rather than an implementation detail. `TM8_SPACE_SESSIONS=off` is
 * W3's kill switch, and it used to un-pin EVERY kind — so on an `off` node an
 * agent bearer became a cross-Space credential for its whole identity, because
 * `internal.member_space_ids()` stops intersecting once the claim is gone. That
 * was asserted as intended behaviour in `test/db/cross-space-token.pg.test.ts`,
 * whose comment called it "the pre-W0a leak, pinned as the documented behaviour
 * of the kill switch". Reversing a documented decision needed its own reviewed
 * change: B20, split out of this task by B24 and landed as #1320 (bc72f0de6),
 * approved by the W3 audit matrix's owner. The mode now gates only the human
 * `auth.space.enter` pins (233, W3).
 *
 * So: the pin is a property of the CREDENTIAL for agent, agent_runtime and
 * link, and a property of the MODE only for a human row. It is the same
 * argument `viaLinkId` (256, W7p) already carries beside it in the source — the
 * pin only ever narrows, so no mode may un-bind it.
 *
 * This file is the single home for that matrix (B33): it absorbed
 * `pinned-kinds-always-bound.test.ts`, which #1320 added and this change
 * deletes, so one file cannot drift from the other. The SQL-side half — what
 * the claim then does to every membership helper — is
 * `test/db/cross-space-token.pg.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { CollabError } from '@tm8/contract';
import { identityFromSession } from '../../src/http/identity-resolver.js';
import type { ResolvedAuthSession } from '../../src/identity/pg-auth.js';
import type { SpaceSessionsMode } from '../../src/http/types.js';

const SPACE = '00000000-0000-4000-8000-0000000000aa';

/** A verified `resolve_auth_session` row of `kind`, carrying `spaceId`. */
const row = (kind: string, spaceId: string | null): ResolvedAuthSession => ({
  sessionId: '00000000-0000-4000-8000-000000000001',
  accountId: 'account', identityId: 'identity', username: 'h', displayName: null,
  isNodeAdmin: false, isOwner: false, kind: kind as ResolvedAuthSession['kind'],
  actingAsTeamMemberId: null, workSessionId: null, runtimeMemberId: null,
  runtimeThreadRootId: null, runtimeChatId: null, runtimeEpoch: null,
  runtimeNativeGeneration: null,
  spaceId, expiresAt: '2026-12-01T00:00:00.000Z', label: null,
});

const MODES = ['off', 'agents', 'enforce'] as const satisfies readonly SpaceSessionsMode[];

/** 226's CHECK names exactly these: a row of this kind cannot exist unpinned. */
const ALWAYS_PINNED = ['agent', 'agent_runtime', 'link'] as const;

/**
 * What `tm8.session_space_id` must become.
 *   'space' — the row's own Space in EVERY mode (the 226 kinds, post-B20);
 *   'mode'  — the row's own Space only while the mode is not `off` (human pins);
 *   'never' — nothing, in any mode (a human GATE session carries no Space).
 */
const MATRIX: ReadonlyArray<{
  kind: ResolvedAuthSession['kind']; spaceId: string | null; pinned: 'space' | 'mode' | 'never';
}> = [
  { kind: 'agent', spaceId: SPACE, pinned: 'space' },
  { kind: 'agent_runtime', spaceId: SPACE, pinned: 'space' },
  { kind: 'link', spaceId: SPACE, pinned: 'space' },
  { kind: 'browser', spaceId: SPACE, pinned: 'mode' },
  { kind: 'cli', spaceId: SPACE, pinned: 'mode' },
  { kind: 'browser', spaceId: null, pinned: 'never' },
  { kind: 'cli', spaceId: null, pinned: 'never' },
];

describe('Q15 / B20 — tm8.session_space_id across kind x TM8_SPACE_SESSIONS', () => {
  for (const cell of MATRIX) {
    for (const mode of MODES) {
      const want = cell.pinned === 'space' ? SPACE
        : cell.pinned === 'mode' && mode !== 'off' ? SPACE
        : undefined;
      it(`${cell.kind} with space=${cell.spaceId ? 'set' : 'null'} on '${mode}' pins ${want ? 'its space' : 'nothing'}`, () => {
        const identity = identityFromSession(row(cell.kind, cell.spaceId), 'bearer', mode);
        expect(identity.sessionSpaceId).toBe(want);
        expect(identity.authKind).toBe(cell.kind);
      });
    }
  }

  it('an agent bearer is narrowed in EVERY mode — the Q15 answer', () => {
    // Stated on its own so it cannot be lost in the table. `off` included:
    // that row is what B20 changed, and it is the whole point of the fix.
    for (const kind of ['agent', 'agent_runtime'] as const) {
      for (const mode of MODES) {
        const identity = identityFromSession(row(kind, SPACE), 'bearer', mode);
        expect(identity.sessionSpaceId).toBe(SPACE);
        // K6 (W3): a space-pinned session never carries node-admin power, so
        // the two answers can never disagree about whether it is narrowed.
        expect(identity.nodeAdmin).toBe(false);
      }
    }
  });

  it('the kill switch still releases the HUMAN pins, which is all it was for', () => {
    // The paired negative. Without it, "pinned in every mode" could be passing
    // because the mode argument is ignored altogether.
    for (const kind of ['browser', 'cli'] as const) {
      expect(identityFromSession(row(kind, SPACE), 'bearer', 'off').sessionSpaceId).toBeUndefined();
      expect(identityFromSession(row(kind, SPACE), 'bearer', 'agents').sessionSpaceId).toBe(SPACE);
      expect(identityFromSession(row(kind, SPACE), 'bearer', 'enforce').sessionSpaceId).toBe(SPACE);
    }
  });

  it('a human gate session keeps its node-admin power while binding no Space', () => {
    // Folded in from pinned-kinds-always-bound.test.ts: the pin and node-admin
    // move together (K6), so an unpinned gate row must NOT lose the power.
    for (const kind of ['browser', 'cli'] as const) {
      for (const mode of MODES) {
        const identity = identityFromSession({ ...row(kind, null), isNodeAdmin: true }, 'bearer', mode);
        expect(identity.sessionSpaceId).toBeUndefined();
        expect(identity.nodeAdmin).toBe(true);
      }
    }
  });

  for (const kind of ALWAYS_PINNED) {
    it(`${kind} with no space is REFUSED, not bound to the empty pin`, () => {
      /*
       * Folded in from pinned-kinds-always-bound.test.ts, and the only copy of
       * this coverage (B33). Unreachable through SQL while 226's CHECK stands,
       * asserted anyway: the fail-OPEN answer here — bind nothing, answer for
       * every Space the identity belongs to — is exactly the leak B20 closes,
       * so a future migration that relaxes the CHECK must break loudly.
       *
       * B32: the operator is told, not just the caller. The log is SPIED rather
       * than silenced, so it stays part of the contract — a log nobody asserts
       * is a log the next refactor deletes.
       */
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        for (const mode of MODES) {
          expect(() => identityFromSession(row(kind, null), 'bearer', mode)).toThrow(CollabError);
          expect(() => identityFromSession(row(kind, null), 'bearer', mode)).toThrow(/not bound to a space/);
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
});
