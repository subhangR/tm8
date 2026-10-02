/**
 * `runs_on` (work_session -> credential) is listed only from its session.
 *
 * The binding "this session runs on that card" is space-visible, like the
 * session it describes (spec doc 01a0e248 §6). The credential side is not: the
 * sessions that used a card, with who launched them and when, is
 * `credentials.space.usage`, which is human-only and owner-or-admin gated (270).
 * A list of a credential's incoming `runs_on` edges would rebuild that list
 * through an ungated read, so every read that lists edges admits a `runs_on`
 * row only when the read is anchored on the edge's own session (its `src_id`).
 * The credential's detail shows one summary group instead (`runsOnSummary`),
 * pointing at the usage read, which enforces its own gate.
 *
 * Residual, accepted: a member can still walk the space-visible sessions one by
 * one and rebuild a partial list (session ids and cards, without launcher,
 * agent session or timestamps). That is strictly weaker than `usage`.
 */
export const RUNS_ON = 'runs_on';

/** The operation a credential's `runs_on` summary points at. */
export const RUNS_ON_USAGE_OPERATION = 'credentials.space.usage';

/**
 * A SQL predicate over edge alias `edge`: true for every non-`runs_on` edge,
 * and for a `runs_on` edge only when `sessionParam` (a bound parameter or
 * expression naming the read's anchor) is its source. `null` means the read
 * has no single anchor, so no `runs_on` edge is listed.
 */
export function runsOnListedFrom(edge: string, sessionParam: string | null): string {
  return sessionParam === null
    ? `${edge}.type <> '${RUNS_ON}'`
    : `(${edge}.type <> '${RUNS_ON}' or ${edge}.src_id = ${sessionParam})`;
}
