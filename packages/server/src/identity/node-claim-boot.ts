/**
 * The first-run claim announcement (docs/identity/FIRST-RUN-CLAIM-DESIGN.md).
 *
 * WHY THIS RUNS AT BOOT RATHER THAN ON DEMAND. The person who has just
 * installed tm8 has exactly one channel to the node they cannot already
 * authenticate to: its own output. Printing the claim URL where they are
 * already looking — the terminal, or `journalctl -u tm8-server` — is what makes
 * "installed it, opened it, got in" possible without a shell round trip.
 *
 * WHY THE PLAINTEXT ALSO GOES TO A FILE. A systemd install scrolls its boot log
 * away, and an operator who comes back on Monday has nothing to click.
 * `<dataDir>/setup-token` at 0600 is the durable copy, readable by exactly the
 * account the server already runs as — which is the same access level that
 * could read the database anyway, so it grants nothing new.
 *
 * WHAT IS NEVER STORED: the plaintext reaches the database as a sha256 and
 * nothing else (`issueNodeClaimToken`). A dump of an unclaimed node is not a
 * way to claim it.
 *
 * THE TOKEN RIDES IN A FRAGMENT, NOT A QUERY STRING. `#claim=…` is never sent
 * to the server by any browser, so it cannot reach an access log, an upstream
 * proxy, or a `Referer` header. A query string would: nginx's default
 * `combined` format writes the full request line, and "reached over Tailscale
 * or through a reverse proxy" is the exact deployment this feature exists for,
 * so `?claim=` would write a node-ownership capability into the proxy log
 * BEFORE the ceremony burns it. Same click, same paste, no disclosure.
 */
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Db } from '../db/types.js';
import { claimTokenIsLive, issueNodeClaimToken, nodeIsClaimed } from './pg-auth.js';

export interface ClaimAnnouncementOptions {
  db: Db;
  dataDir: string;
  /** Where the server believes it is reachable — the printed link's origin. */
  url: string;
  nodeMode: 'single' | 'multi';
  /**
   * Bootstraps the node owner. REQUIRED, and the requirement is a fix rather
   * than ceremony — see the guard in `announceNodeClaim`.
   */
  ensureOwner: () => Promise<unknown>;
  log?: (line: string) => void;
}

/**
 * Mint and announce a claim token if this node is unclaimed. A no-op on a
 * claimed node, which is the overwhelmingly common case — including every node
 * already provisioned through `docs/identity/PROVISION-SECOND-ACCOUNT.md`,
 * because "claimed" means any account has a credential rather than "someone ran
 * the claim ceremony".
 *
 * FAILS SOFT, DELIBERATELY. A node that cannot write its setup-token file must
 * still start: the token is already valid and already on stdout, and refusing
 * to boot over a convenience copy would turn a permissions warning into an
 * outage. The refusal is logged with the reason rather than swallowed.
 */
export async function announceNodeClaim(opts: ClaimAnnouncementOptions): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(line));

  let claimed: boolean;
  try {
    claimed = await nodeIsClaimed(opts.db);
  } catch (err) {
    // A node whose migrations have not been applied yet reaches here. Say so
    // and start anyway — the alternative is a server that will not boot until
    // someone runs a migration it cannot tell them about.
    log(`  claim: could not determine whether this node is claimed — ${message(err)}`);
    return;
  }

  if (claimed) {
    log(`  node: claimed · mode ${opts.nodeMode}`);
    return;
  }

  /**
   * THE OWNER ROW MUST EXIST BEFORE THE TOKEN IS ADVERTISED.
   *
   * `claim_node` credentials the existing owner and refuses with `P0002` when
   * there is none. Nothing on the claim path creates it: `auth.claim` and
   * `auth.claim.status` are both claim-free and neither touches `deps.owner()`.
   * The only unconditional bootstrap at boot sits behind `config.launchBootstrap`.
   *
   * So on a virgin database with `TM8_LAUNCH_BOOTSTRAP=0` the node printed
   * "claim it at …" and every claim answered `P0002`. With `TM8_NODE_MODE=multi`
   * it was PERMANENT: the auto-owner arm resolves to anonymous without ever
   * resolving the owner, so no request path bootstrapped the row either — the
   * exact dead end this whole feature removes, reached through the configuration
   * the design tells multiplayer operators to set.
   *
   * Resolving it here is idempotent (`resolveLoopbackOwner` memoises and the
   * single-owner index makes a second owner impossible), and a failure means the
   * ceremony cannot succeed, so advertising it would be a false promise.
   */
  try {
    await opts.ensureOwner();
  } catch (err) {
    log(`  claim: this node has no owner account to claim and one could not be created — ${message(err)}`);
    return;
  }

  const tokenPath = join(opts.dataDir, 'setup-token');

  /**
   * REUSE THE LIVE TOKEN ACROSS AN ORDINARY RESTART.
   *
   * Minting unconditionally burned the previous token on every boot, which
   * broke the design's own promise of a link with no expiry: an operator who
   * saved the first boot's URL and restarted before claiming got a dead link
   * and nothing explaining why. Rotation should be a deliberate act, not a
   * side effect of `systemctl restart`.
   */
  let token: string | undefined;
  try {
    const saved = (await readFile(tokenPath, 'utf8')).trim();
    if (saved && (await claimTokenIsLive(opts.db, saved))) token = saved;
  } catch {
    // No readable file, or nothing live behind it. Mint below.
  }

  let wrote = true;
  if (!token) {
    try {
      token = await issueNodeClaimToken(opts.db);
    } catch (err) {
      log(`  claim: could not mint a claim token — ${message(err)}`);
      return;
    }
    try {
      // Mode on open AND an explicit chmod: the open mode is masked by the
      // process umask, so a permissive umask would otherwise leave the token
      // group- or world-readable. chmod is not subject to umask.
      await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
      await chmod(tokenPath, 0o600);
    } catch (err) {
      wrote = false;
      log(`  claim: could not write ${tokenPath} — ${message(err)}`);
    }
  }

  const claimUrl = `${opts.url.replace(/\/$/, '')}/#claim=${encodeURIComponent(token)}`;
  log('');
  log('  ┌─ THIS NODE IS UNCLAIMED ─────────────────────────────────────────');
  log('  │  No account here has a password yet, so nobody can sign in.');
  log('  │  Claim it — from this machine or any other — at:');
  log('  │');
  log(`  │    ${claimUrl}`);
  log('  │');
  if (wrote) log(`  │  Also written to ${tokenPath} (0600).`);
  log('  │  The token is single-use and is burned the moment it is claimed.');
  log('  └──────────────────────────────────────────────────────────────────');
  log('');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
