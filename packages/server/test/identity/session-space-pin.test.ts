/**
 * Q15 (plan §13) VERIFIED, as a kind × mode table.
 *
 * The question: are `agent` / `agent_runtime` claims narrowed to the session's
 * own Space, or do they list every Space like other bearers?
 *
 * THE ANSWER, pinned below:
 *   * under `agents` (the default) and `enforce` — YES, narrowed. 226's
 *     `auth_sessions_pinned_kinds_have_space` CHECK makes `space_id` non-null
 *     for agent, agent_runtime and link rows, `identityFromSession` binds
 *     `tm8.session_space_id` from that verified row, and every membership
 *     helper intersects with the claim (227).
 *   * under `TM8_SPACE_SESSIONS=off` — NO. The pin is inert for EVERY kind, so
 *     an agent bearer answers for every Space its identity belongs to.
 *
 * That second row is not an oversight. It is the documented contract of the
 * kill switch, asserted for both agent kinds in
 * `test/db/cross-space-token.pg.test.ts:384` — which calls it "the pre-W0a leak,
 * pinned as the documented behaviour of the kill switch" — including that
 * `internal.member_space_ids()` returns both Spaces and that `is_space_member`,
 * `is_space_admin` and `current_member_id` all answer for the other one.
 *
 * Narrowing the three pinned kinds in every mode is ruling B20, and it is
 * deliberately NOT done here: it reverses that documented decision, so it ships
 * as its own reviewed security change with the W3 audit-matrix owner in the
 * loop (ruling B24). This table is what that PR will edit, beside those cells.
 * Exposure meanwhile is limited to a node an operator explicitly set to `off`.
 */
import { describe, expect, it } from 'vitest';
import { identityFromSession } from '../../src/http/identity-resolver.js';
import type { ResolvedAuthSession } from '../../src/identity/pg-auth.js';
import type { SpaceSessionsMode } from '../../src/http/types.js';

const base: ResolvedAuthSession = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  accountId: 'account', identityId: 'member', username: 'member', displayName: null,
  isNodeAdmin: false, isOwner: false, kind: 'agent',
  actingAsTeamMemberId: 'teammate', workSessionId: 'work-session', runtimeMemberId: null,
  runtimeThreadRootId: null, runtimeChatId: null, runtimeEpoch: null, runtimeNativeGeneration: null,
  spaceId: 'space', expiresAt: '2026-10-11T00:00:00.000Z', label: null,
};
const row = (kind: ResolvedAuthSession['kind'], spaceId: string | null): ResolvedAuthSession =>
  ({ ...base, kind, spaceId });

const MODES: readonly SpaceSessionsMode[] = ['off', 'agents', 'enforce'];

/**
 * `pinned` is what `tm8.session_space_id` becomes. `'mode'` means the row's own
 * Space whenever the mode is not `off`; `'never'` means nothing, in any mode.
 */
const MATRIX: ReadonlyArray<{
  kind: ResolvedAuthSession['kind']; spaceId: string | null; pinned: 'mode' | 'never';
}> = [
  // The 226 pinned kinds always CARRY a Space, so they are narrowed in every
  // mode but `off` — which is the Q15 answer, and the Q15 hole, in one row.
  { kind: 'agent', spaceId: 'space', pinned: 'mode' },
  { kind: 'agent_runtime', spaceId: 'space', pinned: 'mode' },
  { kind: 'link', spaceId: 'space', pinned: 'mode' },
  // Human kinds carry one only when `auth.space.enter` (233, W3) minted it.
  { kind: 'browser', spaceId: 'space', pinned: 'mode' },
  { kind: 'cli', spaceId: 'space', pinned: 'mode' },
  // A human GATE session carries no Space and binds nothing in any mode, which
  // is what keeps every pre-W3 human session answering exactly as before.
  { kind: 'browser', spaceId: null, pinned: 'never' },
  { kind: 'cli', spaceId: null, pinned: 'never' },
];

describe('Q15 — tm8.session_space_id across kind x TM8_SPACE_SESSIONS', () => {
  for (const cell of MATRIX) {
    for (const mode of MODES) {
      const want = cell.pinned === 'mode' && mode !== 'off' ? 'space' : undefined;
      it(`${cell.kind} with space=${cell.spaceId ?? 'null'} on '${mode}' pins ${want ?? 'nothing'}`, () => {
        const identity = identityFromSession(row(cell.kind, cell.spaceId), 'opaque', mode);
        expect(identity.sessionSpaceId).toBe(want);
        expect(identity.authKind).toBe(cell.kind);
      });
    }
  }

  it('an agent bearer IS narrowed under the default mode — the Q15 answer', () => {
    // The row this task was asked to verify, stated on its own so it cannot be
    // lost in the table: the default is `agents`, and under it an agent bearer
    // carries its own Space and nothing else.
    for (const kind of ['agent', 'agent_runtime'] as const) {
      expect(identityFromSession(row(kind, 'space'), 'opaque', 'agents').sessionSpaceId).toBe('space');
      expect(identityFromSession(row(kind, 'space'), 'opaque', 'enforce').sessionSpaceId).toBe('space');
    }
  });

  it('and is NOT narrowed under `off` — the Q15 hole, documented, pending B20', () => {
    // Paired with cross-space-token.pg.test.ts:384, which asserts the DB-side
    // consequence of this same row. If B20 lands, both move together.
    for (const kind of ['agent', 'agent_runtime'] as const) {
      expect(identityFromSession(row(kind, 'space'), 'opaque', 'off').sessionSpaceId).toBeUndefined();
    }
  });
});
