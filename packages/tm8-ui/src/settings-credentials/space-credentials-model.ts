/**
 * The pure half of Settings → Space credentials (SC-5): every sentence and
 * every "may this viewer see this control" decision, kept out of the
 * component so each is testable without a DOM.
 *
 * NOTHING HERE EVER SEES A SECRET (I5). `validateSecret` is handed the draft
 * and answers a reason that never quotes it.
 */
import type {
  CredentialPolicySource,
  CredentialsLoginSessionFinishResult,
  CredentialsSpacePolicyView,
  SpaceCredentialProviderName,
  SpaceCredentialView,
} from '@tm8/contract';
import type { SpaceCredentialsViewer } from './space-port';

export const SPACE_CREDENTIAL_PROVIDERS: readonly SpaceCredentialProviderName[] = ['anthropic', 'openai', 'github'];

export const SPACE_PROVIDER_NAME: Record<SpaceCredentialProviderName, string> = {
  anthropic: 'Claude (Anthropic)',
  openai: 'Codex (OpenAI)',
  github: 'GitHub',
};

/** What a pasted secret is called for each provider. */
export const SPACE_SECRET_NOUN: Record<SpaceCredentialProviderName, string> = {
  anthropic: 'API key',
  openai: 'API key',
  github: 'token',
};

export const SOURCE_WORD: Record<CredentialPolicySource, string> = {
  member: 'Yours',
  space: 'Space',
  node: 'Node',
};

/** github takes a token; the model vendors take an API key (the contract's rule). */
export function pasteShapeOf(provider: SpaceCredentialProviderName): 'api_key' | 'token' {
  return provider === 'github' ? 'token' : 'api_key';
}

/** Rows the list draws, by provider. Revoked rows are gone for good; they never draw. */
export function groupByProvider(
  rows: readonly SpaceCredentialView[],
): Record<SpaceCredentialProviderName, SpaceCredentialView[]> {
  const groups: Record<SpaceCredentialProviderName, SpaceCredentialView[]> = { anthropic: [], openai: [], github: [] };
  for (const row of rows) {
    if (row.status === 'revoked') continue;
    groups[row.provider]?.push(row);
  }
  for (const provider of SPACE_CREDENTIAL_PROVIDERS) {
    groups[provider].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.label.localeCompare(b.label));
  }
  return groups;
}

/** D11: the creator and space admins edit, rotate and delete. Everyone else uses. */
export function canManage(row: SpaceCredentialView, viewer: SpaceCredentialsViewer | null): boolean {
  if (!viewer) return false;
  if (viewer.isSpaceAdmin) return true;
  return row.createdByAccountId !== null && viewer.accountId !== null && row.createdByAccountId === viewer.accountId;
}

/**
 * The creator line. The view carries an account id, not a name, and a member
 * summary carries no account id, so "who" is answered only as far as it is
 * known: you, someone else, or — creator gone (D12) — the space itself.
 */
export function creatorLabel(row: SpaceCredentialView, viewer: SpaceCredentialsViewer | null): string {
  if (row.createdByAccountId === null) return 'the space (its creator has left; admins manage it)';
  if (viewer?.accountId && row.createdByAccountId === viewer.accountId) return 'you';
  return 'another member';
}

/**
 * D6a: a provider with usable credentials and no default. Said wherever it is
 * true, not only right after the delete that caused it.
 */
export function noDefaultNotice(
  provider: SpaceCredentialProviderName,
  rows: readonly SpaceCredentialView[],
): string | null {
  const usable = rows.filter((r) => r.status === 'active' || r.status === 'stale');
  if (usable.length === 0) return null;
  if (usable.some((r) => r.isDefault)) return null;
  return `${SPACE_PROVIDER_NAME[provider]} has no space default. A launch on the space credential must name one until a default is set.`;
}

/** What to say right after a delete. Deleting the default promotes nothing (D6a). */
export function afterDeleteNotice(deleted: SpaceCredentialView, sessionsEnded: number): string {
  const ended = sessionsEnded > 0
    ? ` ${sessionsEnded} live session${sessionsEnded === 1 ? '' : 's'} using it ${sessionsEnded === 1 ? 'was' : 'were'} ended.`
    : '';
  if (deleted.isDefault) {
    return `Deleted “${deleted.label}”. It was the default, so ${SPACE_PROVIDER_NAME[deleted.provider]} now has NO default: nothing was promoted in its place.${ended}`;
  }
  return `Deleted “${deleted.label}”.${ended}`;
}

/**
 * A7: labels are unique per (space, provider), and a PENDING login row holds
 * its label until that login finishes or expires. Explains the clash, or null.
 */
export function labelTakenReason(
  provider: SpaceCredentialProviderName,
  label: string,
  rows: readonly SpaceCredentialView[],
  exceptId?: string,
): string | null {
  const wanted = label.trim();
  if (!wanted) return null;
  const clash = rows.find((r) => r.provider === provider && r.label === wanted && r.status !== 'revoked' && r.id !== exceptId);
  if (!clash) return null;
  if (clash.status === 'pending') {
    return `“${wanted}” is taken: a login that has not finished is holding it. A pending login keeps its label until it completes or expires. Pick another label, or finish or close that login.`;
  }
  return `“${wanted}” is taken: another ${SPACE_PROVIDER_NAME[provider]} credential in this space already has that label.`;
}

export const SECRET_MIN = 8;
export const SECRET_MAX = 4096;

/** The contract's bounds, answered WITHOUT quoting the draft (I5). */
export function validateSecret(secret: string): string | null {
  if (secret.length === 0) return null;
  if (/\s/.test(secret)) return 'A key has no spaces or line breaks. Check that nothing else was pasted with it.';
  if (secret.length < SECRET_MIN) return `That is too short to be a key (at least ${SECRET_MIN} characters).`;
  if (secret.length > SECRET_MAX) return `That is too long to be a key (at most ${SECRET_MAX} characters).`;
  return null;
}

/**
 * How a failed call reads. `refused` is a 403 answered BEFORE any probe
 * (#681 D): it must never read as "the vendor said no" and never carries a
 * probe spinner. `rejected` and `unreachable` ARE probe answers.
 */
export type SpaceCredentialFailureKind = 'refused' | 'rejected' | 'unreachable' | 'invalid' | 'failed';

export interface SpaceCredentialFailure {
  kind: SpaceCredentialFailureKind;
  text: string;
}

export function failureOf(err: unknown): SpaceCredentialFailure {
  const code = (err as { code?: unknown })?.code;
  const details = (err as { details?: Record<string, unknown> })?.details;
  const reason = typeof details?.reason === 'string' ? details.reason : null;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'forbidden') return { kind: 'refused', text: `Refused: ${message}` };
  if (reason === 'credential_rejected') {
    return { kind: 'rejected', text: 'The vendor rejected this key, so nothing was stored.' };
  }
  if (reason === 'credential_probe_unreachable') {
    return { kind: 'unreachable', text: 'The vendor could not be reached to check the key, so nothing was stored. Try again.' };
  }
  if (code === 'invalid_input' || code === 'conflict') return { kind: 'invalid', text: message };
  return { kind: 'failed', text: message };
}

/**
 * A login onto a credential is already open (`login_open`). The server quotes
 * its `expiresAt` even when that moment has PASSED, so past means "expired:
 * close it", not "wait". The close is starting again onto `credentialId`: the
 * server reclaims an expired terminal for its creator or a space admin (N1).
 * An unexpired terminal someone else opened cannot be closed from here.
 */
export interface LoginOpenNotice {
  expired: boolean;
  expiresAt: string;
  /** The credential the open login is holding, when the refusal names it. */
  credentialId: string | null;
  text: string;
}

export function loginOpenNoticeOf(err: unknown, now: Date = new Date()): LoginOpenNotice | null {
  const details = (err as { details?: Record<string, unknown> })?.details;
  if (details?.reason !== 'login_open' || typeof details.expiresAt !== 'string') return null;
  const expiresAt = details.expiresAt;
  const credentialId = typeof details.credentialId === 'string' ? details.credentialId : null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  if (at < now.getTime()) {
    return {
      expired: true,
      expiresAt,
      credentialId,
      text: `An earlier login onto this credential expired at ${formatWhen(expiresAt)} but was never closed: close it by logging in again, which ends that terminal and opens a fresh one.`,
    };
  }
  return {
    expired: false,
    expiresAt,
    credentialId,
    text: `A login onto this credential is already open until ${formatWhen(expiresAt)}. Whoever opened it can finish it; after that time, you can log in again.`,
  };
}

/**
 * How a refused space-login start reads. `conflict` means two different
 * things, told apart ONLY by `details.reason`: a login already open on the
 * credential, or a label taken (A7). The code alone never picks the copy.
 */
export type SpaceLoginStartFailure =
  | { kind: 'login_open'; notice: LoginOpenNotice }
  | { kind: 'label_taken'; text: string }
  | { kind: 'failure'; failure: SpaceCredentialFailure };

export function spaceLoginStartFailureOf(
  err: unknown,
  provider: SpaceCredentialProviderName,
  rows: readonly SpaceCredentialView[],
  now: Date = new Date(),
): SpaceLoginStartFailure {
  const code = (err as { code?: unknown })?.code;
  const details = (err as { details?: Record<string, unknown> })?.details;
  const open = loginOpenNoticeOf(err, now);
  if (open) return { kind: 'login_open', notice: open };
  if (details?.reason === 'label_taken') {
    const label = typeof details.label === 'string' ? details.label : '';
    return {
      kind: 'label_taken',
      text: labelTakenReason(provider, label, rows)
        ?? `“${label}” is taken: another ${SPACE_PROVIDER_NAME[provider]} credential in this space, or a login that has not finished, already holds it. Pick another label.`,
    };
  }
  if (code === 'not_found') {
    return { kind: 'failure', failure: { kind: 'failed', text: 'That credential is no longer in this space. The list has been re-read.' } };
  }
  return { kind: 'failure', failure: failureOf(err) };
}

/**
 * What a finished space login achieved. Read from the credential row the
 * PROBED finish returned (I6), never from `connected` alone: a re-login that
 * failed leaves an active credential active, and a new login that failed
 * leaves its row pending until `pendingExpiresAt` sweeps it.
 */
export function spaceLoginOutcome(result: CredentialsLoginSessionFinishResult): string {
  const cred = result.spaceCredential;
  if (!cred) {
    return 'The login ended, but the server did not say which space credential it wrote. The list has been re-read.';
  }
  const name = `“${cred.label}”`;
  if (cred.status === 'active' && result.connected) {
    const as = cred.displayLogin ? ` as ${cred.displayLogin}` : '';
    return `Logged in${as}: ${name} is ready to launch with.${cred.isDefault ? ` It is the ${SPACE_PROVIDER_NAME[cred.provider]} default.` : ''}`;
  }
  if (cred.status === 'active') {
    return `That login did not complete, so ${name} keeps the login it already had.`;
  }
  if (cred.status === 'pending') {
    return `That login did not complete, so ${name} is still pending and launches cannot use it. Log in again, or delete it; an unfinished login is removed when it expires.`;
  }
  if (cred.status === 'stale') {
    return `${name} is stored, but its check failed, so launches may be refused. Log in again to replace it.`;
  }
  return `${name} is no longer usable. The list has been re-read.`;
}

/** The sources a provider's space policy allows. `null` policy means all three. */
export function allowedSourcesOf(
  policy: CredentialsSpacePolicyView | null,
  provider: SpaceCredentialProviderName,
): CredentialPolicySource[] {
  const entry = policy?.providers.find((p) => p.provider === provider);
  return entry?.allowedSources ?? ['member', 'space', 'node'];
}

/** The node admin's word on node fallback. `null`/absent means allowed. */
export function nodeAllowedOf(
  policy: { node: CredentialsSpacePolicyView['node'] } | null,
  provider: SpaceCredentialProviderName,
): boolean {
  return policy?.node.find((n) => n.provider === provider)?.allowNode !== false;
}

/**
 * Toggle one source in a provider's allowed set. All three on is stored as
 * `null` (no policy). An empty set is not a policy anyone can launch under,
 * so the last source cannot be switched off.
 */
export function toggleSource(
  current: readonly CredentialPolicySource[],
  source: CredentialPolicySource,
): CredentialPolicySource[] | null {
  const next = current.includes(source) ? current.filter((s) => s !== source) : [...current, source];
  const ordered = (['member', 'space', 'node'] as const).filter((s) => next.includes(s));
  if (ordered.length === 3) return null;
  return ordered;
}

/** A stable, locale-free rendering: tests and screenshots read the same thing. */
export function formatWhen(iso: string | null): string {
  if (!iso) return 'never';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
