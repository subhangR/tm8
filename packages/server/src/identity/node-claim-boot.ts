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
 *
 * EVERY BOOT SAYS WHICH MODE IT RUNS IN, AND WHY (doc 14 §4.4, doc 15 §3.3).
 * The first line is `node: <mode> (from <source>)`, because the mode decides
 * whether a loopback caller is the owner and an operator should never have to
 * infer that. An UNCLAIMED node advertises the claim box in every mode,
 * Personal included: under decision 34 a local agent is never the owner, so
 * the owner claims it once with the setup token, and after that `tm8 open`
 * mints the launch cookie that makes a loopback browser the owner. The bare
 * origin is never advertised as a way in: with the cookie required it answers
 * anonymous. The first-run chooser runs after the claim.
 */
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { NodeModeSourceView, NodeModeView } from '@tm8/contract';

import type { Db } from '../db/types.js';
import { NODE_MODE_ENV, modeFilePath, readModeFile } from './node-mode.js';
import { claimTokenIsLive, issueNodeClaimToken, nodeIsClaimed } from './pg-auth.js';

export interface ClaimAnnouncementOptions {
  db: Db;
  dataDir: string;
  /** Where the server believes it is reachable — the printed link's origin. */
  url: string;
  /**
   * The server's own loopback URL — where the first-run chooser opens, after
   * the claim. Defaults to `url`. Differs from `url` when
   * `TM8_PUBLIC_ORIGIN` is set: the claim link travels, the chooser does not.
   */
  localUrl?: string;
  nodeMode: NodeModeView;
  nodeModeSource: NodeModeSourceView;
  /** False when neither `TM8_NODE_MODE` nor `<dataDir>/mode` set the mode. */
  nodeModeSet: boolean;
  /** The mode was spelled `single` or `multi`. */
  deprecatedAlias?: boolean;
  /**
   * This node mints launch cookies (`wantsLaunchCookie`), so `tm8 open` is the
   * owner's way in on this machine. False on Server, under the kill switch and
   * with `TM8_AUTO_OWNER_COOKIE=off`.
   */
  launchCookie?: boolean;
  /**
   * Bootstraps the node owner. REQUIRED, and the requirement is a fix rather
   * than ceremony — see the guard in `announceNodeClaim`.
   */
  ensureOwner: () => Promise<unknown>;
  log?: (line: string) => void;
}

/**
 * Say which mode this node runs in, and mint and announce a claim token if it
 * is unclaimed. On a claimed node it is the mode line and nothing else — the
 * overwhelmingly common case, including every node provisioned through
 * `docs/identity/PROVISION-SECOND-ACCOUNT.md`, because "claimed" means any
 * account has a credential rather than "someone ran the claim ceremony".
 *
 * FAILS SOFT, DELIBERATELY. A node that cannot write its setup-token file must
 * still start: the token is already valid and already on stdout, and refusing
 * to boot over a convenience copy would turn a permissions warning into an
 * outage. The refusal is logged with the reason rather than swallowed.
 */
export async function announceNodeClaim(opts: ClaimAnnouncementOptions): Promise<string | undefined> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const localUrl = (opts.localUrl ?? opts.url).replace(/\/$/, '');

  let claimed: boolean;
  try {
    claimed = await nodeIsClaimed(opts.db);
  } catch (err) {
    // A node whose migrations have not been applied yet reaches here. Say so
    // and start anyway — the alternative is a server that will not boot until
    // someone runs a migration it cannot tell them about.
    log(modeLine(opts, null));
    log(`  claim: could not determine whether this node is claimed — ${message(err)}`);
    return undefined;
  }

  if (claimed && opts.deprecatedAlias) {
    // A CLAIMED node still spelled `single` or `multi` is every node deployed
    // before modes, prod included (`TM8_NODE_MODE=single` +
    // `TM8_DISABLE_AUTO_OWNER=1`). It prints exactly the line main printed and
    // nothing more: a deploy of this change must not alter what such a node
    // says. The new mode line would also be WRONG there — "the owner on this
    // machine" is false under the kill switch, which this line never reads.
    log(`  node: claimed · mode ${legacySpelling(opts)}`);
    return undefined;
  }

  log(modeLine(opts, claimed));
  if (opts.deprecatedAlias) log(deprecationLine(opts));
  const overridden = overriddenFileLine(opts);
  if (overridden) log(overridden);

  if (claimed) {
    if (opts.nodeMode === 'personal' && opts.nodeModeSet) {
      // Never the bare origin: with the launch cookie required it answers
      // anonymous, and the owner's way in is the one-time URL `tm8 open` prints.
      // With the cookie off the loopback peer alone is the owner, as before.
      log(opts.launchCookie ? '  to open tm8 as the owner, run: tm8 open' : `  open ${localUrl}`);
      log('  to let other people in, switch mode in Settings or run: tm8 node mode set peer|server');
    }
    return undefined;
  }

  if (!opts.nodeModeSet) {
    log(
      `  First run. Claim this node below first; after the claim, ${
        opts.launchCookie ? 'run tm8 open' : `open ${localUrl}`
      } and choose Personal, Peer or Server.`,
    );
  }

  const minted = await ensureClaimToken(opts, log);
  if (!minted) return undefined;
  const { token, tokenPath, wrote } = minted;

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
  if (opts.launchCookie) log('  │  Claim once with the setup token, then run: tm8 open');
  log('  └──────────────────────────────────────────────────────────────────');
  log('');
  // Returned, not merely printed: a double-clicked `.app` has no terminal, so
  // for the desktop shell this line IS the terminal (`desktop.ts`).
  return claimUrl;
}

/** `node: <mode> (from <source>) · <what it means here>`. `claimed` null = unknown. */
function modeLine(opts: ClaimAnnouncementOptions, claimed: boolean | null): string {
  const from =
    opts.nodeModeSource === 'env'
      ? `from ${NODE_MODE_ENV}`
      : opts.nodeModeSource === 'file'
        ? `from ${modeFilePath(opts.dataDir)}`
        : 'default, no mode chosen yet';
  let meaning: string;
  if (opts.nodeMode === 'personal') {
    meaning = opts.nodeModeSet
      ? 'the owner on this machine, nobody else'
      : claimed === false
        ? 'first run'
        : 'runs as personal: the owner on this machine, nobody else';
  } else if (opts.nodeMode === 'peer') {
    meaning = 'owner on this machine, password for everyone else';
  } else {
    meaning = 'everyone signs in, everywhere';
  }
  const claim = claimed === null ? '' : claimed ? ' · claimed' : ' · unclaimed';
  return `  node: ${opts.nodeMode} (${from}) · ${meaning}${claim}`;
}

/**
 * Env and file disagree (doc 15 R2): the env wins, and the banner says so, so an
 * operator who switched in Settings on a pinned node learns why nothing moved.
 * A file that cannot be read is not reported here: the env pin means it is not
 * the mode, and the boot must not fail over it.
 */
function overriddenFileLine(opts: ClaimAnnouncementOptions): string | null {
  if (opts.nodeModeSource !== 'env') return null;
  let recorded: string | null;
  try {
    recorded = readModeFile(opts.dataDir)?.mode ?? null;
  } catch {
    return null;
  }
  if (recorded === null || recorded === opts.nodeMode) return null;
  return `  ${modeFilePath(opts.dataDir)} says ${recorded}; ${NODE_MODE_ENV} wins`;
}

function legacySpelling(opts: ClaimAnnouncementOptions): 'single' | 'multi' {
  return opts.nodeMode === 'server' ? 'multi' : 'single';
}

function deprecationLine(opts: ClaimAnnouncementOptions): string {
  const legacy = legacySpelling(opts);
  const where = opts.nodeModeSource === 'env' ? `${NODE_MODE_ENV}=${legacy}` : `"${legacy}" in ${modeFilePath(opts.dataDir)}`;
  return `  ${where} is deprecated, use ${opts.nodeMode}`;
}

interface MintedClaimToken {
  token: string;
  tokenPath: string;
  /** False when `setup-token` could not be written; the token is still live. */
  wrote: boolean;
}

/**
 * The live claim token, reused across restarts or minted, and written to
 * `<dataDir>/setup-token`. Null when no token can be had — which is logged.
 */
async function ensureClaimToken(
  opts: ClaimAnnouncementOptions,
  log: (line: string) => void,
): Promise<MintedClaimToken | null> {
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
    return null;
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
      return null;
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

  return { token, tokenPath, wrote };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
