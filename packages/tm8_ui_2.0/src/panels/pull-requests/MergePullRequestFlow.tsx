import { useCallback, useRef, useState } from 'react';
import type { TrackingPrMergeResult } from '@tm8/contract';
import { mergeRefusalOf, mergeRefusalText, type MergeRefusal } from '../../domain';
import { DisabledAction, toReason } from '../honesty/DisabledWithReason';
import { useDismissable } from '../useDismissable';

/**
 * THE MERGE CONFIRM — the flow surface behind the PR panel's `Merge…`
 * (UI-PLACEMENT-MAP §4.3 B10).
 *
 * TWO STEPS, NEVER ONE, AND NEVER A BROWSER DIALOG. The bar's verb opens this;
 * this carries the button that commits. That is the session git rail's idiom
 * (`git/SessionGitBody.tsx`) applied to the one act in this build that lands
 * code on someone else's base branch, and it is why the verb keeps its
 * ellipsis: `Merge…` promises a confirm, not a merge.
 *
 * WHY THE FACT-REFUSALS LIVE HERE AND NOT ON THE ACTION BAR. `tracking.pr.merge`
 * refuses from observed facts — state, mergeability, CI, credential — that
 * `ActionContext` does not carry, and teaching it those would put one kind's
 * vocabulary on the shared type every verb reads (§15.2). So the bar gates on
 * op availability alone and this surface answers the rest: the click that
 * discovers a refusal is the click that reads it, which is strictly more
 * informative than a greyed verb behind a tooltip at a distance.
 *
 * THE ORDER BELOW MIRRORS THE SERVER'S GUARDS, and that symmetry is the
 * contract: a refusal the user reads here is the same refusal, in the same
 * sequence, the node would have produced.
 *
 * NOTHING HERE FLIPS THE CHIP. Success shows the forge's `mergeSha` and says
 * the lifecycle word arrives through the observer (`git.pr_state_changed`).
 * Repainting the chip `merged` locally would be this component asserting an
 * outcome only the forge can confirm — and a failed projection would then look
 * like data being deleted rather than like a merge that never landed.
 */

export interface MergePullRequestFlowProps {
  /**
   * What the confirm NAMES. `repository`/`number` come from the panel's own
   * detail read, so the sentence says the same `repo#n` the header does.
   */
  pr: { repository: string; number: number };
  /**
   * The head the viewer was SHOWN, when a read has told us one.
   *
   * ABSENT/NULL IS THE COMMON CASE TODAY and is not "no pin": no client read
   * projects a PR's head sha, so this stays honest by omitting `headSha` from
   * the input and letting the server pin the head IT stored — the row the
   * human reviewed. The copy says which of the two happened rather than
   * printing a sha nobody observed.
   */
  headSha?: string | null;
  /**
   * The GitHub login the merge will be attributed to. `null`/absent ⇒ this
   * node has not told us one, and the line says "your GitHub account" instead
   * of naming a login it does not have.
   */
  githubLogin?: string | null;
  /**
   * Commits the merge. ABSENT ⇒ disabled-with-reason, never enabled-inert
   * (R5 #9) — the same structural rule every other verb follows.
   */
  onMerge?: (input: { headSha?: string }) => Promise<TrackingPrMergeResult>;
  onDismiss?: () => void;
  /** What counts as "inside" for outside-click dismissal; see LaunchQuickConfig. */
  boundsRef?: React.RefObject<HTMLElement | null>;
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

export function MergePullRequestFlow({
  pr,
  headSha,
  githubLogin,
  onMerge,
  onDismiss,
  boundsRef,
}: MergePullRequestFlowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const noop = useCallback(() => {}, []);
  useDismissable(true, boundsRef ?? ref, onDismiss ?? noop);

  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<MergeRefusal | null>(null);
  const [receipt, setReceipt] = useState<TrackingPrMergeResult | null>(null);

  const label = `${pr.repository}#${String(pr.number)}`;
  const at = headSha ? `at ${shortSha(headSha)}` : 'at the head this node last observed';
  const as = githubLogin ? `as ${githubLogin}` : 'as your GitHub account';

  return (
    <div className="pm" ref={ref} data-testid="pr-merge-flow">
      <div className="pm__head">
        <span className="pm__heading">Merge pull request</span>
        <span className="pm__subject" title={label}>
          {label}
        </span>
        {onDismiss ? (
          <button type="button" className="pm__close" aria-label="Close merge confirmation" onClick={onDismiss}>
            ×
          </button>
        ) : null}
      </div>

      {receipt ? (
        /* THE RECEIPT, and the second sentence is the load-bearing one. The
           merge really happened — here is the forge's own sha — and the chip
           has NOT changed yet, on purpose. Without that line a viewer reads
           the unchanged chip as a merge that silently failed. */
        <p className="pm__receipt" data-testid="pr-merge-receipt">
          {`Merged ${receipt.repo}#${String(receipt.number)} as ${shortSha(receipt.mergeSha)}. `}
          <span className="pm__receipt-note">
            The state chip still reads open: `merged` arrives when the observer reports it
            (git.pr_state_changed), not from this screen.
          </span>
        </p>
      ) : (
        <>
          {/* THE CONFIRM NAMES WHAT WILL HAPPEN — which PR, which head, whose
              credential. The op pins the observed head rather than merging
              whatever the branch has become, so the sentence says so. */}
          <p className="pm__confirm-text" data-testid="pr-merge-confirm-text">
            {`Merge ${label} ${at} ${as}?`}
          </p>

          {refusal ? (
            /* ABOVE the button that produced it, so it is read before it is
               pressed again — the launch config's rule, same reason. */
            <p className="pm__refusal" role="alert" data-testid="pr-merge-refusal">
              <span className="pm__refusal-label">
                {refusal.predatesDoor ? 'Not on this node' : 'Merge refused'}
              </span>
              {` — ${mergeRefusalText(refusal)}`}
            </p>
          ) : null}

          <div className="pm__actions">
            <span className="pm__spacer" />
            {onDismiss ? (
              <button type="button" className="pm__verb" data-testid="pr-merge-cancel" onClick={onDismiss}>
                Cancel
              </button>
            ) : null}
            {!onMerge ? (
              <DisabledAction
                reason={{
                  cause: 'Merging isn’t connected yet',
                  remedy: 'the confirmation is real; this screen does not dispatch it in this build',
                }}
              >
                Confirm merge
              </DisabledAction>
            ) : refusal ? (
              /* mb1: EVERY refusal in the vocabulary, including the 501,
                 renders as the disabled-with-reason primitive rather than as
                 an alert beside a still-live button. The facts have to change
                 before this can be pressed again, and a re-armed button would
                 say otherwise. */
              <DisabledAction reason={toReason(mergeRefusalText(refusal))}>Confirm merge</DisabledAction>
            ) : (
              <button
                type="button"
                className="pm__go"
                data-testid="pr-merge-go"
                disabled={pending}
                onClick={() => {
                  setRefusal(null);
                  setPending(true);
                  onMerge(headSha ? { headSha } : {})
                    .then((result) => {
                      setPending(false);
                      // NOT a dismiss: the sha and the observer note are the
                      // point, and closing on success would throw both away.
                      setReceipt(result);
                    })
                    .catch((error: unknown) => {
                      setPending(false);
                      setRefusal(mergeRefusalOf(error));
                    });
                }}
              >
                {pending ? 'Merging…' : 'Confirm merge'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
