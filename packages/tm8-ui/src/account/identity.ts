/**
 * The pure read of `IdentityView` for the T3-3 identity block.
 *
 * Pure and separate from the component for one reason: everything honest about
 * this surface is a DERIVATION question ("whose member panel is 'my profile'?",
 * "is that word presence or account status?"), and derivations are cheap to
 * assert and expensive to eyeball inside JSX.
 *
 * WHAT THE SEAM DOES NOT CARRY, stated here because the oracle draws it and a
 * reader will look for it (`src/data/seam.ts`, `IdentityView`):
 *
 *  · NO node name or host. The canvas identity line reads "ada@loopback ·
 *    local node"; the seam has `email` and `username` and nothing that names
 *    the node. The suffix is therefore OMITTED unless a host passes one — it
 *    is not derived from `location.host`, which would be a guess wearing the
 *    costume of a fact.
 *  · NO presence. The canvas draws "● online"; `IdentityView.status` is the
 *    ACCOUNT status ('active'), and presence has no publisher at all (R8
 *    dormant — seam.ts says so in its own words). So the status word is
 *    rendered verbatim and labelled as account status. Rendering 'active' as
 *    "online" would be the two-source-honesty defect in miniature: a stored
 *    record dressed as a live verdict.
 */
import type { IdentityView } from '../data/seam';

export interface IdentityPresentation {
  /** Never empty: displayName, else username. */
  name: string;
  /** Avatar monogram. */
  initials: string;
  /** Role chip for the active space; null when nothing truthful is known. */
  role: string | null;
  /** Mono account line: the email when the node has one, else the username. */
  accountLine: string;
  /** Account status, VERBATIM from the server. Not presence. See the docblock. */
  status: string;
  /**
   * The member entity in the ACTIVE space — the "My profile" target. Null when
   * this space has no membership for you: a menu that opened someone else's
   * member panel because it took `memberships[0]` would be worse than a
   * refusal, and the refusal is the honest state.
   */
  memberId: string | null;
  /** Non-null only when the server itself says you are acting as someone. */
  actingAs: string | null;
}

export function presentIdentity(
  identity: IdentityView,
  spaceId: string | null | undefined,
): IdentityPresentation {
  const membership = spaceId
    ? identity.memberships.find((m) => m.spaceId === spaceId) ?? null
    : null;
  const name = nonEmpty(identity.displayName) ?? identity.username;
  return {
    name,
    initials: (name.charAt(0) || '·').toUpperCase(),
    // The membership role is the space-scoped truth; the node-level flags are
    // the fallback, and both are facts the server sent. Nothing is invented.
    role: membership?.role ?? (identity.isOwner ? 'owner' : identity.isNodeAdmin ? 'node admin' : null),
    accountLine: nonEmpty(identity.email) ?? identity.username,
    status: identity.status,
    memberId: membership?.memberId ?? null,
    actingAs: nonEmpty(identity.actingAs),
  };
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
