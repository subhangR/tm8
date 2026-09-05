/**
 * IS THIS ACCOUNT SET UP? — the one derivation, so the welcome, the dialog's
 * step list and the account menu's nudge cannot disagree about it.
 *
 * The gate is ONE AGENT PROVIDER AND GITHUB (Subhang, 2026-09-05). Both halves
 * do different work and neither substitutes for the other: an agent credential
 * is what lets a launched session think at all, and the GitHub credential is
 * what lets the work it does leave the node as a branch, a commit and a PR. A
 * space where only the first is true produces agents that run and strand every
 * result on one machine.
 *
 * WHAT COUNTS AS CONNECTED IS `verdictOf`, NOT `entry.connected`. The port
 * already owns the honest reading of a measurement — an absent binary is
 * `unavailable`, a stale probe is `unknown` — and this module must not re-derive
 * it. In particular NEITHER `unknown` NOR `unavailable` counts as connected
 * here, and that direction is deliberate: counting them would tell a member
 * they are finished on the strength of an answer nobody obtained.
 *
 * The reverse mistake is the one this module must also not make. An `unknown`
 * is not a MISSING step either — it is a step whose state we could not read —
 * so {@link credentialSetupState} reports it separately and the dialog says so
 * rather than marching the member back through a login they may already hold.
 */
import type { CredentialProviderName, CredentialsStatusView } from '@tm8/contract';
import { verdictOf, type ConnectionVerdict } from './port';

/** The GitHub half of the gate. Its own store, its own shape (a token). */
export const GIT_PROVIDER: CredentialProviderName = 'github';

/** How one provider stands, for a surface that has to name it. */
export interface ProviderStanding {
  provider: CredentialProviderName;
  verdict: ConnectionVerdict;
  connected: boolean;
  /** No answer was obtained. Neither connected nor a step to redo blindly. */
  unmeasured: boolean;
  /** The binary is absent here; this provider cannot be signed in on this node. */
  unavailable: boolean;
}

export interface CredentialSetupState {
  /** Every provider the node reported, in the node's order. */
  standings: ProviderStanding[];
  /** The non-GitHub providers — the ones that make an agent able to think. */
  agents: ProviderStanding[];
  /** GitHub's standing, or null when the node listed no GitHub row at all. */
  git: ProviderStanding | null;
  /** At least one agent provider is measured connected. */
  hasAgent: boolean;
  /** GitHub is measured connected. */
  hasGit: boolean;
  /**
   * BOTH halves. The gate the welcome and the account-menu nudge read.
   *
   * A node that listed NO providers is not complete — but it is also not a
   * member who has skipped a step, so `unreadable` below carries that case
   * and hosts are expected to check it before nagging anyone.
   */
  complete: boolean;
  /**
   * The node told us nothing we can act on: it listed no providers at all, or
   * every provider it listed is unmeasured. Auto-opening a setup flow on this
   * would be asking a member to fix our instrumentation.
   */
  unreadable: boolean;
}

function standingOf(
  entry: CredentialsStatusView['providers'][number],
  gitCredentialStore: CredentialsStatusView['gitCredentialStore'],
): ProviderStanding {
  const verdict = verdictOf(entry, gitCredentialStore);
  return {
    provider: entry.provider,
    verdict,
    connected: verdict === 'connected-named' || verdict === 'connected-unnamed',
    unmeasured: verdict === 'unknown',
    unavailable: verdict === 'unavailable',
  };
}

export function credentialSetupState(
  status: CredentialsStatusView,
): CredentialSetupState {
  const standings = status.providers.map((entry) =>
    standingOf(entry, status.gitCredentialStore),
  );
  const agents = standings.filter((s) => s.provider !== GIT_PROVIDER);
  const git = standings.find((s) => s.provider === GIT_PROVIDER) ?? null;
  const hasAgent = agents.some((s) => s.connected);
  const hasGit = git?.connected === true;

  return {
    standings,
    agents,
    git,
    hasAgent,
    hasGit,
    complete: hasAgent && hasGit,
    unreadable:
      standings.length === 0 || standings.every((s) => s.unmeasured),
  };
}

/**
 * Should the setup flow open itself for this status?
 *
 * Three refusals, and each one prevents a different way of being obnoxious:
 * a complete account is not interrupted, an account whose state we could not
 * read is not blamed for it, and a member who said Later is believed.
 */
export function shouldOfferSetup(
  status: CredentialsStatusView,
  dismissed: boolean,
): boolean {
  if (dismissed) return false;
  const state = credentialSetupState(status);
  if (state.unreadable) return false;
  return !state.complete;
}

/**
 * The one-line reason the account menu shows beside "Agent tools", or null
 * when there is nothing to say. Never invents urgency out of an unknown.
 */
export function setupNudgeOf(state: CredentialSetupState): string | null {
  if (state.unreadable) return null;
  if (state.complete) return null;
  if (!state.hasAgent && !state.hasGit) return 'no agent tools connected yet';
  if (!state.hasAgent) return 'no agent tool connected yet';
  return 'GitHub not connected — agents cannot push or open PRs';
}
