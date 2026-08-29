import { isCollabError } from '@tm8/contract';

/**
 * B10 — THE MERGE DOOR'S REFUSAL VOCABULARY, read.
 *
 * `tracking.pr.merge` guards from OBSERVED FACTS before any network, and names
 * each refusal in `error.details.reason` (server
 * `facade/services/w2/tracking-write.ts:81-135`). That vocabulary is part of
 * the seam's contract, not an implementation detail — Amendment 11 says so —
 * so it is read here, in `domain/`, and the flow component renders whatever
 * this answers without knowing a single one of the words.
 *
 * TWO HONESTY RULES SHAPE EVERY LINE BELOW.
 *
 * 1. THE SERVER'S SENTENCE WINS. Each guard already throws a full, specific
 *    message — "PR tm8/tm8#42 has failing checks (observed ci_status=failing)"
 *    — naming the fact it measured. Re-authoring that here would replace a
 *    measurement with a guess and let the two drift.
 *
 * 2. THE VOCABULARY HAS A TAIL, and it is where a naive reader breaks. Four
 *    reachable outcomes carry NO `details.reason` at all: `not_found`,
 *    `unauthorized` (thrown as a bare `forbidden`), `rate_limited`, and the
 *    `upstream_unavailable` catch-all. A renderer keyed on `reason` alone
 *    shows an EMPTY refusal for every one of them — the user clicks Merge,
 *    nothing merges, and nothing says why. So `reason` is a LABEL here, never
 *    the text.
 *
 * Reasons are STRINGS, in the house `cause — remedy` shape that
 * `panels/honesty`'s `toReason` splits: `domain/` states the words and never
 * imports a component's view model (the same rule `REASONS` follows).
 */

/**
 * A refusal, read into what a surface renders. `reason` is the vocabulary word
 * when the server gave one and `null` when it did not — `null` is "this code
 * carries no vocabulary", NOT "no refusal".
 */
export interface MergeRefusal {
  reason: string | null;
  /** What to show. The server's own sentence wherever there is one. */
  text: string;
  /**
   * 501 — the running node has no merge door. A STATE to render, not an error
   * to log (`data/LLD.md:150`), and the state this control ships into until
   * the node restarts.
   */
  predatesDoor: boolean;
}

/**
 * The 501's copy, authored here because the server that would have written it
 * is precisely the one that does not exist yet.
 *
 * IT NAMES A RESTART, NOT A DEFECT. No op lets a client ask a node which
 * operations it serves, so this verb renders ENABLED on a node predating the
 * door and learns otherwise on the first attempt. That correction is honest —
 * the client genuinely could not know — but it reads as flakiness unless the
 * copy says so, which is what everything after the em-dash is for.
 */
export const PREDATES_MERGE_DOOR =
  'This node predates the merge door — the operation shipped after the running server started, ' +
  'so nothing could tell us until this first attempt. It will work once the node restarts; merge on the forge until then.';

export function mergeRefusalOf(error: unknown): MergeRefusal {
  if (isCollabError(error)) {
    const raw = error.details?.['reason'];
    return {
      reason: typeof raw === 'string' ? raw : null,
      text: error.message,
      predatesDoor: error.code === 'not_implemented',
    };
  }
  // Not a wire refusal at all — a transport or programming failure. It still
  // has to SAY something: a silent Merge is the one outcome this file exists
  // to prevent.
  return {
    reason: null,
    text: error instanceof Error ? error.message : 'the node refused this merge and gave no reason',
    predatesDoor: false,
  };
}

/**
 * The sentence a surface shows. The vocabulary word rides as the remedy half
 * so the refusal stays greppable against the server's own switch without ever
 * becoming the thing a human has to read.
 */
export function mergeRefusalText(refusal: MergeRefusal): string {
  if (refusal.predatesDoor) return PREDATES_MERGE_DOOR;
  return refusal.reason ? `${refusal.text} — ${refusal.reason}` : refusal.text;
}
