/**
 * The launch picker's credential SOURCE options (SC-5; design 01a0cfa8 D4, D5,
 * D6a, D10). Pure, so every greyed-out option and every reason is testable
 * without a DOM.
 *
 * Per provider the picker offers: Auto · Yours · Space default · Space ▸ each
 * credential · Node. An option the policy excludes is still DRAWN, disabled,
 * with the reason in its own text: a hidden option reads as "does not exist",
 * which is a different and false statement.
 *
 * A space option's value encodes the credential it pins: `space` is "the
 * space's default for this provider", `space:<id>` pins one credential. The
 * value never carries an account (I1).
 */
import type {
  CredentialPolicySource,
  CredentialProviderName,
  CredentialsSpacePolicyView,
  SpaceCredentialProviderName,
  SpaceCredentialView,
} from '@tm8/contract';

/** '' is Auto (no key sent). */
export type LaunchSourceChoice = '' | 'member' | 'node' | 'space' | `space:${string}`;

export interface LaunchSourceOption {
  value: LaunchSourceChoice;
  text: string;
  disabled: boolean;
  /** Why it is disabled; null when it is not. Also drawn inside `text`. */
  reason: string | null;
}

const SPACE_PROVIDERS: readonly SpaceCredentialProviderName[] = ['anthropic', 'openai', 'github'];

export function isSpaceCredentialProvider(p: CredentialProviderName | string): p is SpaceCredentialProviderName {
  return (SPACE_PROVIDERS as readonly string[]).includes(p);
}

/** Decode a choice into what the spawn input carries. */
export function parseLaunchSourceChoice(
  choice: LaunchSourceChoice,
): { source: 'member' | 'space' | 'node'; spaceCredentialId: string | null } | null {
  if (choice === '') return null;
  if (choice === 'member' || choice === 'node' || choice === 'space') return { source: choice, spaceCredentialId: null };
  return { source: 'space', spaceCredentialId: choice.slice('space:'.length) };
}

const SOURCE_NAME: Record<CredentialPolicySource, string> = { member: 'Yours', space: 'Space', node: 'Node' };

/**
 * Space credentials the picker may offer for one provider: usable rows only.
 * A pending row is a login that has not finished; a revoked one is gone.
 */
export function launchableSpaceCredentials(
  provider: SpaceCredentialProviderName,
  credentials: readonly SpaceCredentialView[] | null,
): SpaceCredentialView[] {
  return (credentials ?? [])
    .filter((c) => c.provider === provider && (c.status === 'active' || c.status === 'stale'))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.label.localeCompare(b.label));
}

/** The reason a source is off under policy, or null when it is allowed. */
export function sourcePolicyReason(
  provider: CredentialProviderName,
  source: CredentialPolicySource,
  policy: CredentialsSpacePolicyView | null,
): string | null {
  if (!policy || !isSpaceCredentialProvider(provider)) return null;
  const allowed = policy.providers.find((p) => p.provider === provider)?.allowedSources ?? null;
  if (allowed && !allowed.includes(source)) {
    return `off: this space allows only ${allowed.map((s) => SOURCE_NAME[s]).join(' and ')}`;
  }
  if (source === 'node' && policy.node.find((n) => n.provider === provider)?.allowNode === false) {
    return 'off: the node admin has turned node fallback off';
  }
  return null;
}

export interface LaunchSourceOptionsInput {
  provider: CredentialProviderName;
  /** The member option's words (they carry the viewer's connected identity). */
  memberText: string;
  nodeText: string;
  autoText: string;
  /** The space's credentials; null when they could not be read or no reader is wired. */
  spaceCredentials: readonly SpaceCredentialView[] | null;
  /** Why `spaceCredentials` is null, when it is. */
  spaceUnavailable?: string | null;
  policy: CredentialsSpacePolicyView | null;
}

export function launchSourceOptions(input: LaunchSourceOptionsInput): LaunchSourceOption[] {
  const { provider, policy } = input;
  const option = (value: LaunchSourceChoice, text: string, reason: string | null): LaunchSourceOption => ({
    value,
    text: reason ? `${text} · ${reason}` : text,
    disabled: reason !== null,
    reason,
  });
  const options: LaunchSourceOption[] = [
    option('', input.autoText, null),
    option('member', input.memberText, sourcePolicyReason(provider, 'member', policy)),
  ];
  if (isSpaceCredentialProvider(provider)) {
    const spaceOff = sourcePolicyReason(provider, 'space', policy);
    if (input.spaceCredentials === null) {
      options.push(option('space', 'Space credential', spaceOff ?? input.spaceUnavailable ?? 'space credentials could not be read'));
    } else {
      const rows = launchableSpaceCredentials(provider, input.spaceCredentials);
      if (rows.length === 0) {
        options.push(option('space', 'Space credential', spaceOff ?? 'this space holds none for this provider'));
      } else {
        const fallback = rows.find((r) => r.isDefault);
        // D6a: deleting the default promotes nothing, so "Space default" can
        // be absent while credentials exist. Say so; the rows stay pickable.
        options.push(option(
          'space',
          fallback ? `Space default · ${fallback.label}` : 'Space default',
          spaceOff ?? (fallback ? null : 'this space has no default: pick one below'),
        ));
        for (const row of rows) {
          const stale = row.status === 'stale' ? ' (stale: the last check failed)' : '';
          options.push(option(`space:${row.id}`, `Space ▸ ${row.label}${stale}`, spaceOff));
        }
      }
    }
  }
  options.push(option('node', input.nodeText, sourcePolicyReason(provider, 'node', policy)));
  return options;
}

/**
 * D10: who a session's commits and pull requests are authored as. Auto is
 * answered along D4 — yours, then the space default, then the node — skipping
 * what policy turns off, so the line predicts what the server will resolve.
 */
export function githubAuthorshipLine(input: {
  choice: LaunchSourceChoice;
  memberHandle: string | null;
  spaceCredentials: readonly SpaceCredentialView[] | null;
  policy: CredentialsSpacePolicyView | null;
}): string {
  const rows = launchableSpaceCredentials('github', input.spaceCredentials);
  const asSpace = (row: SpaceCredentialView | undefined): string => {
    if (!row) return 'Commits and pull requests: no space GitHub token is chosen, so this launch will be refused';
    return row.displayLogin
      ? `Commits and pull requests are authored as @${row.displayLogin.replace(/^@/, '')} (space token “${row.label}”)`
      : `Commits and pull requests are authored by the account behind the space token “${row.label}” (its login was not recorded)`;
  };
  const asNode = 'Commits and pull requests are authored by this server’s GitHub account';
  const asMember = input.memberHandle
    ? `Commits and pull requests are authored as ${input.memberHandle} (your GitHub)`
    : 'Commits and pull requests: your GitHub is not connected, so pushes will not authenticate';
  const parsed = parseLaunchSourceChoice(input.choice);
  if (parsed?.source === 'member') return asMember;
  if (parsed?.source === 'node') return asNode;
  if (parsed?.source === 'space') {
    return asSpace(parsed.spaceCredentialId ? rows.find((r) => r.id === parsed.spaceCredentialId) : rows.find((r) => r.isDefault));
  }
  // Auto, along D4.
  const allows = (s: CredentialPolicySource) => sourcePolicyReason('github', s, input.policy) === null;
  if (input.memberHandle && allows('member')) return `${asMember} · Auto`;
  const fallback = rows.find((r) => r.isDefault);
  if (fallback && allows('space')) return `${asSpace(fallback)} · Auto`;
  if (allows('node')) return `${asNode} · Auto`;
  return 'Commits and pull requests: no GitHub source this space allows is available, so this launch will be refused';
}

/**
 * One line naming every disabled option and why. A native option's text is
 * clipped at the sheet's width, so the reason is also drawn in full here —
 * "greyed out with the reason shown" must not depend on a hover.
 */
export function disabledSourcesNote(options: readonly LaunchSourceOption[]): string | null {
  const seen = new Map<string, string>();
  for (const o of options) {
    if (!o.disabled || !o.reason) continue;
    const word = o.value === 'member' ? 'Yours'
      : o.value === 'node' ? 'Node'
      : o.value === 'space' ? 'Space default'
      : 'Space';
    // Every pinned space row shares the space policy's reason: say it once.
    if (o.value.startsWith('space:') && [...seen.values()].includes(o.reason.replace(/^off: /, ''))) continue;
    if (!seen.has(word)) seen.set(word, o.reason.replace(/^off: /, ''));
  }
  if (seen.size === 0) return null;
  return `Unavailable: ${[...seen].map(([word, why]) => `${word} (${why})`).join(' · ')}`;
}
