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
 * A BACKEND IS NOT A TOOL, AND COUNTING IT AS ONE WOULD LIE TWICE. Kimi and
 * Groq connect like any other provider and appear in `agents` like any other,
 * but they do not bring a program with them: connecting Kimi redirects
 * `claude-code` at Moonshot's endpoint, and a `claude-code` session still needs
 * the `claude` BINARY to exist on this node in order to run at all. So a member
 * who connects Kimi on a node with no `claude` installed has connected
 * something real and still cannot launch anything. Telling them setup is
 * complete would be the worst outcome this module can produce — a green tick
 * followed by every session failing — so a backend counts toward `hasAgent`
 * only while the provider it displaces is not itself `unavailable`. The
 * relationship is read from the server's `routing` rather than from a
 * kimi/anthropic pair spelled out here; see `CredentialRoutingView`.
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
  /**
   * This provider is an API-key BACKEND whose borrowed binary is missing.
   *
   * Distinct from `unavailable`, which means this provider's OWN probe binary
   * is absent — a backend's own binary is `node` and is never absent, so the
   * two can never both be true and collapsing them would make the card say the
   * wrong thing about which install is missing. See the header.
   */
  borrowsMissingBinary: boolean;
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
    // Filled in by the caller: it depends on ANOTHER provider's standing, which
    // is not knowable while the rows are still being read one at a time.
    borrowsMissingBinary: false,
  };
}

export function credentialSetupState(
  status: CredentialsStatusView,
): CredentialSetupState {
  const measured = status.providers.map((entry) =>
    standingOf(entry, status.gitCredentialStore),
  );

  // See the header. A backend borrows the binary of the provider it displaces,
  // so if that provider is `unavailable` here the backend can launch nothing.
  // Computed in a second pass because it reads the FIRST pass's answer about a
  // different provider.
  const unavailable = new Set(measured.filter((s) => s.unavailable).map((s) => s.provider));
  const standings = measured.map((s, i) => {
    const routing = status.providers[i]?.routing ?? null;
    return routing?.role === 'backend' && unavailable.has(routing.counterpart)
      ? { ...s, borrowsMissingBinary: true }
      : s;
  });

  const agents = standings.filter((s) => s.provider !== GIT_PROVIDER);
  const git = standings.find((s) => s.provider === GIT_PROVIDER) ?? null;
  const hasAgent = agents.some((s) => s.connected && !s.borrowsMissingBinary);
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
 * Is there a missing half the member can actually ACT ON from this flow?
 *
 * A provider whose binary is absent renders an inert row with NO Connect
 * button — correctly, since starting a login for a binary that is not there
 * would fail. But that makes an incomplete account whose ONLY missing half is
 * `unavailable` a dead end: every row inert, `Done` refused, and nothing on
 * the screen that can change it.
 */
function hasActionableGap(state: CredentialSetupState): boolean {
  // A stranded backend is no more actionable than an absent binary: signing in
  // to it would succeed and still leave the member unable to launch anything.
  const agentGap =
    !state.hasAgent && state.agents.some((a) => !a.unavailable && !a.borrowsMissingBinary);
  const gitGap = !state.hasGit && state.git !== null && !state.git.unavailable;
  return agentGap || gitGap;
}

/**
 * Should the setup flow open itself for this status?
 *
 * FOUR refusals, and each prevents a different way of being obnoxious: a
 * complete account is not interrupted, an account whose state we could not
 * read is not blamed for it, a member who said Later is believed, and — the
 * fourth, added 2026-09-05 after review — a member is not handed a flow they
 * cannot finish.
 *
 * THE FOURTH IS THE `unavailable` TWIN OF THE `unknown` RULE ABOVE. This module
 * already refuses to auto-open on an unreadable status because that is asking a
 * member to fix OUR instrumentation. Auto-opening on a node where the only
 * missing half has no binary is the same mistake wearing different clothes: it
 * asks them to fix a missing INSTALL, every boot, through a button this dialog
 * deliberately does not render. Their only exits were Escape (asked again next
 * boot, forever) or "Finish later" — which writes the permanent dismissal, so
 * the escape hatch and the deliberate choice were the same gesture.
 *
 * NOTHING IS HIDDEN BY THIS. The account-menu row still opens the flow on
 * demand, and {@link setupNudgeOf} still names the missing half — a member who
 * wants to know is told, and a member who installs the binary is offered the
 * flow on the next boot. Only the unprompted interruption stops.
 */
export function shouldOfferSetup(
  status: CredentialsStatusView,
  dismissed: boolean,
): boolean {
  if (dismissed) return false;
  const state = credentialSetupState(status);
  if (state.unreadable) return false;
  if (state.complete) return false;
  return hasActionableGap(state);
}

/**
 * The one-line reason the account menu shows beside "Agent tools", or null
 * when there is nothing to say. Never invents urgency out of an unknown.
 */
export function setupNudgeOf(state: CredentialSetupState): string | null {
  if (state.unreadable) return null;
  if (state.complete) return null;
  /* An absent binary is a different sentence from an unconnected account, and
     it must not read as something the member forgot to do. It is the one gap
     this node cannot close from the dialog, so the nudge names the cause. */
  if (!state.hasAgent && state.agents.length > 0 && state.agents.every((a) => a.unavailable)) {
    return 'no agent tool is installed on this node';
  }
  /* The same sentence for the same cause, reached differently: every provider
     that could still be signed in here is an API-key backend, and the binary it
     would borrow is missing. Without this branch the addition of kimi, groq and
     grok would silently retire the message above on every node — `agents.every`
     can no longer be true once providers exist whose measured binary is `node`,
     which is never absent. The count is deliberately not stated: this branch is
     written against the CLASS of API-key backends, so a fourth one needs no
     edit here. */
  if (!state.hasAgent && state.agents.length > 0 && state.agents.every((a) => a.unavailable || a.borrowsMissingBinary)) {
    return 'no agent tool is installed on this node';
  }
  if (!state.hasAgent && !state.hasGit) return 'no agent tools connected yet';
  if (!state.hasAgent) return 'no agent tool connected yet';
  if (state.git?.unavailable) return 'the GitHub CLI is not installed on this node';
  return 'GitHub not connected — agents cannot push or open PRs';
}
