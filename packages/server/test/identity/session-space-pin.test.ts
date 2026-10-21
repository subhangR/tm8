/**
 * Q15 (plan §13), answered and pinned: is an `agent` / `agent_runtime` bearer
 * narrowed to its own Space, or does it list every Space like other bearers?
 *
 * It is narrowed. 226's `auth_sessions_pinned_kinds_have_space` CHECK makes
 * `space_id` non-null for agent, agent_runtime and link rows, `identityFromSession`
 * binds `tm8.session_space_id` from that row, and every membership helper
 * intersects with the claim (227).
 *
 * THE HOLE THIS TABLE EXISTS FOR: `TM8_SPACE_SESSIONS=off` used to drop the pin
 * for EVERY kind, so on such a node an agent bearer reverted to answering for
 * every Space its identity belongs to — exactly Q15's worry. `viaLinkId` beside
 * it was already exempt from the mode ("it only narrows, and `off` must not
 * un-bind a link"); B20 gives the three pinned kinds the same treatment, and
 * leaves the mode gating only the human `auth.space.enter` pins.
 */
import { describe, expect, it } from 'vitest';
import { CollabError } from '@tm8/contract';
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
 * `pinned` is what `tm8.session_space_id` must become. `'space'` means the row's
 * own space in EVERY mode; `'mode'` means only when the mode is not `off`.
 */
const MATRIX: ReadonlyArray<{
  kind: ResolvedAuthSession['kind']; spaceId: string | null; pinned: 'space' | 'mode' | 'never';
}> = [
  // The 226 pinned kinds: never un-pinned, whatever the operator set.
  { kind: 'agent', spaceId: 'space', pinned: 'space' },
  { kind: 'agent_runtime', spaceId: 'space', pinned: 'space' },
  { kind: 'link', spaceId: 'space', pinned: 'space' },
  // Human kinds: a space only when `auth.space.enter` (233, W3) minted one, and
  // then only while the feature is on.
  { kind: 'browser', spaceId: 'space', pinned: 'mode' },
  { kind: 'cli', spaceId: 'space', pinned: 'mode' },
  // A human GATE session carries no space and binds nothing in any mode, which
  // is what keeps every pre-W3 human session answering exactly as before.
  { kind: 'browser', spaceId: null, pinned: 'never' },
  { kind: 'cli', spaceId: null, pinned: 'never' },
];

describe('Q15 — tm8.session_space_id across kind x TM8_SPACE_SESSIONS', () => {
  for (const cell of MATRIX) {
    for (const mode of MODES) {
      const want = cell.pinned === 'space' ? 'space'
        : cell.pinned === 'mode' && mode !== 'off' ? 'space' : undefined;
      it(`${cell.kind} with space=${cell.spaceId ?? 'null'} on '${mode}' pins ${want ?? 'nothing'}`, () => {
        const identity = identityFromSession(row(cell.kind, cell.spaceId), 'opaque', mode);
        expect(identity.sessionSpaceId).toBe(want);
        // K6: a pinned session never carries node admin, so the two answers can
        // never disagree about whether this session is narrowed.
        expect(identity.authKind).toBe(cell.kind);
      });
    }
  }

  it('refuses a pinned kind that carries no space instead of binding the empty pin', () => {
    // Unreachable through SQL — 226's CHECK forbids the row — so this is the
    // assertion B20 asked for rather than a live path. An empty pin would read
    // as "unpinned" and answer for every Space the identity belongs to, which
    // is the one outcome this function exists to prevent, so it must not be
    // producible by a future writer that forgets the CHECK.
    for (const kind of ['agent', 'agent_runtime', 'link'] as const) {
      for (const mode of MODES) {
        expect(() => identityFromSession(row(kind, null), 'opaque', mode))
          .toThrow(CollabError);
      }
    }
  });
});
