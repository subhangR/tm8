/**
 * The can-launch sentence (credentials release 2, S7-refusal; spec 01a0e248
 * §10 decision 4, gate 5).
 *
 * ONE SENTENCE, TWO READERS. The launch picker disables with it when the
 * space's readiness says a provider the launch needs has no usable credential,
 * and the spawn's credential ladder (`my_default → space_default → refuse`,
 * `credential-resolution.ts`) refuses with it when the same thing is true at
 * launch time. Both build it here, so a person who reads the picker and then
 * the refusal reads the same words, and a change to one is a change to both.
 */

/** Where a member connects a credential — the words both readers point at. */
export const CREDENTIAL_CONNECT_WHERE = 'Space settings → Credentials';

/** The providers a space can hold a launch credential for. */
export type LaunchCredentialProvider = 'anthropic' | 'openai' | 'github';

/** Display names, as Space → Credentials shows them. */
export const LAUNCH_CREDENTIAL_PROVIDER_NAME: Readonly<Record<LaunchCredentialProvider, string>> = Object.freeze({
  anthropic: 'Claude (Anthropic)',
  openai: 'Codex (OpenAI)',
  github: 'GitHub',
});

/**
 * Why a provider is not ready, in readiness's own words (272's
 * `canLaunch.providers[p].reason`).
 */
export type LaunchNotReadyReason = 'no_credential' | 'stale' | 'policy_excludes_space';

export interface LaunchNotReady {
  provider: LaunchCredentialProvider;
  reason: LaunchNotReadyReason;
}

function nameList(providers: readonly LaunchCredentialProvider[]): string {
  const names = providers.map((p) => LAUNCH_CREDENTIAL_PROVIDER_NAME[p]);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * "Not ready to launch with X: …". The remedy follows the reason: connect one,
 * log in again, or ask an admin to allow space credentials. Order follows the
 * input; an empty input is a caller bug, since a ready launch has no sentence.
 */
export function launchNotReadySentence(missing: readonly LaunchNotReady[]): string {
  if (missing.length === 0) throw new Error('launchNotReadySentence: nothing is missing');
  const of = (reason: LaunchNotReadyReason) => missing.filter((m) => m.reason === reason).map((m) => m.provider);
  const parts: string[] = [];
  const none = of('no_credential');
  const stale = of('stale');
  const policy = of('policy_excludes_space');
  if (none.length > 0) {
    parts.push(`connect a credential in this space under ${CREDENTIAL_CONNECT_WHERE}`);
  }
  if (stale.length > 0) {
    parts.push(`${nameList(stale)}: its credential has gone stale — log in again or replace the key under ${CREDENTIAL_CONNECT_WHERE}`);
  }
  if (policy.length > 0) {
    parts.push(`${nameList(policy)}: this space’s policy does not allow space credentials — a space admin must allow them`);
  }
  return `Not ready to launch with ${nameList(missing.map((m) => m.provider))}: ${parts.join('; ')}.`;
}
