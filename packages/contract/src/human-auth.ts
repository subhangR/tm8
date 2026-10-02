/**
 * THE human-session allow-list: the auth kinds a human-only door admits.
 *
 * It mirrors `internal.require_human_auth_kind()` (083), which passes only
 * `browser` and `cli` and fails closed on a missing, empty or unrecognised
 * kind. It does NOT answer "is this a person". A `link` session (250/251) acts
 * in the target space AS a member and is still refused here, as are `agent`
 * and `agent_runtime`.
 *
 * Every server guard reads this one list: the credential, space-link and
 * server facades, discovery's `human` header, and the others named in
 * `packages/server/test/human-auth-kinds.test.ts`. That test also bans a
 * private copy, because private copies of a security predicate are how a
 * kind comes to be misclassified.
 */
export const HUMAN_AUTH_KINDS: readonly string[] = Object.freeze(['browser', 'cli']);

/** True iff `kind` is admitted by `internal.require_human_auth_kind()`. Fails closed. */
export function isHumanAuthKind(kind: string | null | undefined): boolean {
  return typeof kind === 'string' && HUMAN_AUTH_KINDS.includes(kind);
}
