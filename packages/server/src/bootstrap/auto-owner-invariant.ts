/**
 * The auto-owner boot invariant.
 *
 * WHAT AUTO-OWNER IS. `http/identity-resolver.ts:79-88`: a request that arrives
 * on loopback with no credential and no forwarding header resolves as the NODE
 * OWNER. That is the deliberate single-machine case — one person, their own
 * laptop, no login ceremony — and `http/security.ts:255-274` narrows it hard
 * (real loopback peer, no `Forwarded`/`X-Forwarded-*`/`X-Real-IP`, kill switch
 * unset).
 *
 * WHY IT NEEDS A GUARD. `http/config.ts` defaults `TM8_DISABLE_AUTO_OWNER` to
 * FALSE, so auto-owner is ON unless an operator turned it off. The moment a
 * node has a second account, that default stops being a convenience and starts
 * being a hole: every unauthenticated loopback caller is the owner, and the
 * whole multi-user posture — RLS, per-space membership, capability gates —
 * rests on one environment variable defaulting the unsafe way. A fresh deploy,
 * a container that misses the variable, or an edited systemd drop-in silently
 * reopens it, and nothing in the product would say so.
 *
 * The prod and staging units DO set it (`deploy/utho/systemd/tm8-prod-public-wss.conf`),
 * which is why this is a latent defect rather than a live one. This turns
 * "somebody remembered" into "the node will not run otherwise".
 *
 * WHY A REFUSAL AND NOT A WARNING. Precedent, and the reasoning is already
 * written down: `config.ts` refuses to start on a non-loopback `TM8_BIND`
 * rather than binding wide open, because a warning about an authentication hole
 * is read once and then scrolls away. Same class of hole, same answer.
 *
 * THERE IS NO ESCAPE HATCH, on purpose. The remedy for this refusal is to set
 * the flag that should already have been set. A second variable meaning "yes I
 * really do want unauthenticated owner access on a multi-account node" would be
 * a way to say the dangerous thing in two places instead of one.
 */

import type { Db } from '../db/types.js';

export class AutoOwnerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutoOwnerInvariantError';
  }
}

export interface AutoOwnerInvariantArgs {
  readonly db: Db;
  /** `config.disableAutoOwner === true` — the resolved kill switch. */
  readonly disableAutoOwner: boolean;
}

/**
 * Refuses (throws) when this node has more than one account and the auto-owner
 * arm is still enabled. Resolves silently in every other case.
 *
 * A node that cannot be counted does NOT refuse. This runs at boot, and a
 * database that is briefly unreachable is an outage, not a security decision —
 * refusing to start over it would convert a transient fault into an outage that
 * needs a human. The caller logs and continues; the next boot re-checks.
 */
export async function assertAutoOwnerInvariant(args: AutoOwnerInvariantArgs): Promise<void> {
  if (args.disableAutoOwner) return;

  // Claim-free: nobody has authenticated at boot, and whether authentication is
  // even required is the question. See migration 100 Part C.
  const raw = await args.db.rpc<unknown>({}, 'public.node_account_count', []);
  const accounts = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(accounts) || accounts <= 1) return;

  throw new AutoOwnerInvariantError(
    `refusing to start: this node has ${accounts} accounts and the loopback auto-owner arm is `
      + `still enabled, so any unauthenticated request reaching 127.0.0.1 would resolve as the `
      + `node owner and hold every one of those accounts' access. Set TM8_DISABLE_AUTO_OWNER=1 `
      + `so those accounts have to log in. (Auto-owner is the single-account convenience path; `
      + `a node with more than one account has left that case behind.)`,
  );
}
