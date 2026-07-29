import { DisabledAction } from '../panels/honesty/DisabledWithReason';
import { RefusalCard } from './RefusalCard';
import type { TaskSaveHandle } from './useTaskSave';

/**
 * THE SAVE AFFORDANCES — the "editing" pill and the Cancel/Save pair.
 *
 * MEASURED FROM T5-6's teammate-authoring frame, which is the only frame in
 * the authoring canvas that draws a staged edit:
 *   pill    mono 9.5px/600, #9A581F → --pn-brand-2, on rgba(178,106,43,.11) →
 *           --pn-brand-soft, radius 999px, padding 2px 7px, flex:none
 *   Cancel  11.5px/600, #5B564C → --pn-ink-2, 1px #D8D3C6 → --pn-line-2, r6,
 *           2px 9px, #FFFFFF → --pn-card, hover #F2EFE8 → --pn-hover
 *   Save    11.5px/600, #9A581F → --pn-brand-2, on --pn-brand-soft, 1px
 *           rgba(178,106,43,.35) → rgba(var(--pn-brand-rgb), .35), r6, 2px 9px,
 *           hover rgba(178,106,43,.2)
 *
 * WHERE IT MOUNTS — a RULED divergence from the frame, not drift. T5-6 draws
 * the pair in a standalone 32px action row beneath the tab strip; D63 (user
 * ruling, 2026-07-29) retired that row entirely and moved the action bar
 * inline into the header. So this renders as a FRAGMENT with no wrapper row of
 * its own, for the header's existing `actions` slot — the same shape
 * `ActionBar inline` already takes.
 *
 * IT RENDERS WHEN DIRTY, **OR** WHEN SAVING IS UNAVAILABLE. The second half is
 * L6, not clutter: a panel that cannot save must say so where the Save would
 * be, or the user discovers it by typing something and finding no way to keep
 * it. Hidden and disabled are different states, and only one of them teaches.
 */
export function SaveControls({ save }: { save: TaskSaveHandle }) {
  const saving = save.state.phase === 'saving';

  if (save.unavailable) {
    return (
      <DisabledAction reason={save.unavailable} label="Save">
        Save
      </DisabledAction>
    );
  }

  if (!save.dirty && !saving) return null;

  return (
    <>
      <span className="au-editing" data-testid="authoring-editing-pill">
        editing
      </span>
      <button
        type="button"
        className="au-btn au-btn--quiet"
        onClick={save.cancel}
        disabled={saving}
      >
        Cancel
      </button>
      <button
        type="button"
        className="au-btn au-btn--primary"
        data-testid="authoring-save"
        /* PENDING SHOWS ITS PROMISE. aria-busy rather than a spinner alone:
           the state has to reach a screen reader too, and "Saving…" is the
           word that says the request is out there rather than lost. */
        aria-busy={saving}
        onClick={() => void save.save()}
        disabled={saving}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </>
  );
}

/**
 * The two save honesty states, hosted beside whatever the caller renders.
 *
 * Kept OUT of `SaveControls` on purpose: the controls belong in the header row
 * (D63) and a card cannot live in a 30px row. The host renders the card in the
 * body flow, where there is room for a sentence.
 */
export function AuthoringHost({
  save,
  children,
}: {
  save: TaskSaveHandle;
  children?: React.ReactNode;
}) {
  return (
    <>
      {children}
      {save.state.phase === 'conflict' ? (
        <ConflictCard save={save} />
      ) : null}
      {save.state.phase === 'refused' ? (
        <RefusalCard
          word={save.state.failure.cause}
          detail={save.state.failure.detail}
          aftermath={save.state.failure.aftermath}
          note={save.state.failure.retryable ? undefined : 'not retryable — the node said so'}
          moves={[
            ...(save.state.failure.retryable
              ? [{ label: 'retry', onSelect: () => void save.save() }]
              : []),
            { label: 'keep editing', onSelect: save.dismiss },
            { label: 'discard my changes', onSelect: save.cancel },
          ]}
        />
      ) : null}
    </>
  );
}

/**
 * THE VERSION CONFLICT, as its own designed state.
 *
 * It wears the T5-5 refusal card because it IS a refusal, and it names BOTH
 * numbers — the version the edit was based on and the version that won —
 * because "someone else changed this" without saying what changed is a
 * message the user cannot act on. Where the node sent the whole detail we can
 * even name their title.
 *
 * TWO MOVES, AND NEITHER IS TAKEN AUTOMATICALLY:
 *   · reload   — take theirs. The draft is dropped; the caller is handed the
 *                server's detail.
 *   · overwrite — keep mine, re-sent at THEIR version. Explicit, and labelled
 *                as what it is.
 * A "retry" would be neither: at the same expectedVersion it fails forever,
 * and at a re-read version it is the silent overwrite this whole flow exists
 * to prevent. It is therefore not offered.
 *
 * OVERWRITE DISABLES WHEN THE NODE DID NOT SAY WHICH VERSION WON. Offering a
 * button that cannot know what it would replace is a guess wearing a verb; it
 * renders disabled-with-reason so the user learns the move exists and why it
 * is not available right now (L6, D28).
 */
function ConflictCard({ save }: { save: TaskSaveHandle }) {
  if (save.state.phase !== 'conflict') return null;
  const { failure } = save.state;
  const mine = save.baseVersion;
  const theirs = failure.currentVersion;

  const versions =
    theirs === null
      ? `Your edit was made against v${mine}; the node did not say which version won.`
      : `Your edit was made against v${mine}; the saved version is now v${theirs}.`;
  const theirTitle = failure.current ? ` It is now titled “${failure.current.title}”.` : '';

  return (
    <RefusalCard
      testId="authoring-conflict"
      word={failure.cause}
      detail={`${versions}${theirTitle}`}
      aftermath={failure.aftermath}
      note="no merge in v1 — honestly"
      moves={[
        { label: 'reload — take the saved version', onSelect: save.reload },
        ...(theirs === null
          ? []
          : [{ label: 'overwrite — keep mine', onSelect: () => void save.overwrite() }]),
      ]}
    >
      {theirs === null ? (
        <DisabledAction
          label="overwrite — keep mine"
          reason={{
            cause: 'Can’t overwrite — the current version is unknown',
            remedy: 'the refusal carried no version; reload to see what is saved',
          }}
        >
          overwrite — keep mine
        </DisabledAction>
      ) : null}
    </RefusalCard>
  );
}
