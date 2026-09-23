/**
 * A POLICY "no" from the attach mint, told apart from a transport failure.
 *
 * Why this exists at all. `execution.streams.attach` is the only place a
 * viewer's right to a session's bytes is decided, and it decides it BEFORE any
 * socket opens. Until this type, every way that call could fail arrived at
 * `_ensureSocket`'s catch as an indistinguishable `unknown`, and the catch did
 * the only safe thing it could with an unknown: scheduled a reconnect. So a
 * session the server had deliberately closed to this viewer produced an
 * endless exponential-backoff loop behind a black canvas — a refusal that
 * neither stopped nor said anything, re-asking a question whose answer cannot
 * change by being asked again.
 *
 * A refusal is therefore TERMINAL for the current attach: retrying is not
 * resilience here, it is a poll of somebody else's decision. It resumes only
 * when something actually changes. For `forbidden` and `not_found` that change
 * is somebody ELSE acting — the owner shares the session (187) — which the
 * transport has no feed to learn about, so a remount is what clears those two
 * latches and there is deliberately no in-place Retry: pressing one before the
 * owner has shared would re-ask a settled question.
 *
 * `unauthorized` is the exception, and the only one, because it is about the
 * VIEWER: they can fix it, the sentence below tells them to, and signing in is
 * an event the client already sees. `ptyTransport.clearAuthRefusals()` drops
 * those latches, re-dials, and announces the clear so the surface stops showing
 * the sentence. An instruction the user follows to no effect is worse than no
 * instruction.
 *
 * It lives in its own leaf module so the transport can recognise a refusal
 * without importing the HTTP mint, and the guard is BRANDED rather than
 * `instanceof`: a bundle that loads this module twice would break `instanceof`
 * and silently restore the old infinite-retry behaviour.
 */

export type PtyAttachRefusalReason =
  /** Authorised, but this session is not shared with you (or is view-only). */
  | 'forbidden'
  /** No such live session — it ended, or was never visible to you. */
  | 'not_found'
  /** Not signed in, or the pass expired. */
  | 'unauthorized';

const BRAND = '__tm8PtyAttachRefused';

export class PtyAttachRefused extends Error {
  readonly [BRAND] = true as const;
  readonly reason: PtyAttachRefusalReason;
  /** The mode that was asked for — `view` means nothing narrower was left to try. */
  readonly requestedMode: 'view' | 'drive';

  constructor(
    reason: PtyAttachRefusalReason,
    requestedMode: 'view' | 'drive',
    message: string,
  ) {
    super(message);
    this.name = 'PtyAttachRefused';
    this.reason = reason;
    this.requestedMode = requestedMode;
  }
}

export function isPtyAttachRefused(error: unknown): error is PtyAttachRefused {
  return typeof error === 'object' && error !== null
    && (error as Record<string, unknown>)[BRAND] === true;
}

/**
 * What to SHOW. One sentence, no jargon, and it never guesses at a cause it
 * cannot see: the client knows it was refused, not why the owner chose that.
 */
export function describePtyAttachRefusal(refusal: PtyAttachRefused): string {
  switch (refusal.reason) {
    case 'unauthorized':
      return 'Sign in again to watch this terminal.';
    case 'not_found':
      return 'This terminal is no longer available.';
    default:
      return 'This terminal is private. Its owner can share it from the session menu.';
  }
}
