import { DisabledAction, DisabledIconControl } from '../panels/honesty/DisabledWithReason';
import { RefusalCard } from '../authoring';
import type { DocSaveHandle } from './useDocSave';

/**
 * THE EDITOR'S SHARED FURNITURE — the action bar, the conflict banner and the
 * footer, factored out because T5-3 draws the SAME editing session in two
 * geometries: the Z3 panel (F1b) and the Z4 split (F2a). The oracle's own words
 * for that are "⤢ promotes the same editing session" (line 139) — same session,
 * so the same controls, so one implementation of them.
 *
 * MEASURED FROM THE ORACLE (F1b action row line 81-90, footer line 113-118,
 * banner line 91-100). Every colour below already had a token name; the mapping
 * is stated once in `doc-edit.css` rather than restated per component.
 */

export type DocStance = 'write' | 'preview';

/**
 * Write ⇄ Preview. NOT a generic segmented control: the oracle's annotation 2
 * makes the stance a consequence of GEOMETRY ("a 320-440px panel can't afford
 * honest columns"), and the draft survives the switch because the draft lives
 * in the hook, not in either pane.
 */
export function StanceToggle({
  stance,
  onChange,
}: {
  stance: DocStance;
  onChange(next: DocStance): void;
}) {
  return (
    <span className="de-stance" role="group" aria-label="Editor stance">
      <button
        type="button"
        className="de-stance__opt"
        data-testid="doc-stance-write"
        aria-pressed={stance === 'write'}
        onClick={() => onChange('write')}
      >
        Write
      </button>
      <button
        type="button"
        className="de-stance__opt"
        data-testid="doc-stance-preview"
        aria-pressed={stance === 'preview'}
        onClick={() => onChange('preview')}
      >
        Preview
      </button>
    </span>
  );
}

/**
 * Cancel + Save. THE SAVE NAMES THE VERSION IT WILL PUBLISH ("Save v4", oracle
 * line 89) — a button that says what it will do rather than what it is.
 *
 * IN A CONFLICT THE PRIMARY SAVE IS DISABLED-WITH-REASON, and that is the whole
 * design rather than a defensive check. Pressing Save again would re-send the
 * same `expectedVersion` and fail forever; making it re-read the version would
 * be the silent overwrite the flow exists to prevent. So the two real answers
 * live in the banner, and the button says why it is not one of them.
 */
export function SaveActions({ save }: { save: DocSaveHandle }) {
  if (save.unavailable) {
    return (
      <DisabledAction reason={save.unavailable} label="Save">
        Save
      </DisabledAction>
    );
  }

  if (save.state.phase === 'conflict') {
    return (
      <>
        <button type="button" className="de-btn de-btn--quiet" data-testid="doc-cancel" onClick={save.cancel}>
          Cancel
        </button>
        <DisabledAction
          label="Save"
          reason={{
            cause:
              save.theirVersion === null
                ? 'This can’t save — the document moved while you were editing'
                : `This can’t save at v${save.baseVersion} — the document is now v${save.theirVersion}`,
            remedy: 'choose load theirs or overwrite in the banner above',
          }}
        >
          Save
        </DisabledAction>
      </>
    );
  }

  const saving = save.state.phase === 'saving';
  return (
    <>
      <button
        type="button"
        className="de-btn de-btn--quiet"
        data-testid="doc-cancel"
        onClick={save.cancel}
        disabled={saving}
      >
        Cancel
      </button>
      <button
        type="button"
        className="de-btn de-btn--primary"
        data-testid="doc-save"
        /* PENDING SHOWS ITS PROMISE. aria-busy rather than a spinner alone: the
           state has to reach a screen reader too. */
        aria-busy={saving}
        /* Nothing staged is not a refusal, so it is not disabled-with-reason —
           but it must not look armed either. aria-disabled keeps it focusable
           (D28) while the footer word beside it already says "saved · v3". */
        aria-disabled={!save.dirty || saving}
        onClick={() => void save.save()}
      >
        {saving ? 'Saving…' : save.nextVersion === null ? 'Save' : `Save v${save.nextVersion}`}
      </button>
    </>
  );
}

/**
 * THE CONFLICT BANNER — T5-3's entire concurrency story (line 91-100, and the
 * annotation at 128: "A fact, not a fork").
 *
 * Three parts, in the oracle's order: the FACT (someone saved), the
 * CONSEQUENCE of saving anyway (v5 over their text), and ONE QUIET OUT (load
 * theirs — discards draft). No merge dialog, and no toast.
 *
 * WHO SAVED IT IS USUALLY UNKNOWN, and the copy says so rather than inventing a
 * name. The oracle writes "@noa saved v4"; `EntitySummary` carries `createdBy`
 * and no last-editor field at all, so the actor is only nameable when the HOST
 * supplies it from the event stream. Rendering `createdBy` here would attribute
 * a stranger's edit to whoever first made the document — a plausible, wrong,
 * unfalsifiable sentence. Reported as GAP G4.
 */
export function ConflictBanner({
  save,
  actor,
}: {
  save: DocSaveHandle;
  /** Supplied by the host from the event stream when it has one; else null. */
  actor?: string | null;
}) {
  if (save.state.phase !== 'conflict') return null;
  const who = actor ? `${actor} saved` : 'Someone saved';
  const theirs = save.theirVersion;

  const fact = theirs === null ? `${who} a new version while you were editing` : `${who} v${theirs} while you were editing`;
  const consequence =
    theirs === null
      ? 'Your draft is still yours. The node did not say which version won.'
      : `Your draft is still yours. Saving publishes v${theirs + 1} over their text.`;

  return (
    <div className="de-banner" role="alert" data-testid="doc-conflict-banner">
      <span className="de-banner__glyph" aria-hidden>
        ✎
      </span>
      <div className="de-banner__text">
        <span className="de-banner__fact">{fact}</span>
        <span className="de-banner__sub">{consequence}</span>
      </div>
      <span className="de-banner__moves">
        {save.canOverwrite ? (
          <button
            type="button"
            className="de-banner__move"
            data-testid="doc-overwrite"
            onClick={() => void save.overwrite()}
          >
            overwrite — keep mine
          </button>
        ) : (
          <DisabledIconControl
            label="overwrite — keep mine"
            reason={{
              cause: 'Can’t overwrite — the current version is unknown',
              remedy: 'the refusal carried no version, so we cannot say what this would replace',
            }}
          >
            overwrite — keep mine
          </DisabledIconControl>
        )}
        {save.canReload ? (
          <button
            type="button"
            className="de-banner__move"
            data-testid="doc-load-theirs"
            onClick={save.reload}
          >
            load theirs — discards draft
          </button>
        ) : (
          <DisabledIconControl
            label="load theirs"
            reason={{
              cause: 'Can’t load theirs — the refusal carried no document',
              remedy: 'reopen the doc to see the saved version; your draft stays here until you do',
            }}
          >
            load theirs — discards draft
          </DisabledIconControl>
        )}
      </span>
    </div>
  );
}

/**
 * A non-conflict refusal. This one DOES wear the T5-5 card, because it is the
 * failure the authoring canvas designed a card for and it carries a server
 * sentence that needs room. The banner above is reserved for the concurrency
 * fact the T5-3 canvas draws its own furniture for.
 */
export function RefusalHost({ save }: { save: DocSaveHandle }) {
  if (save.state.phase !== 'refused') return null;
  const { failure } = save.state;
  return (
    <RefusalCard
      testId="doc-refusal"
      word={failure.cause}
      detail={failure.detail}
      aftermath={failure.aftermath}
      note={failure.retryable ? undefined : 'not retryable — the node said so'}
      moves={[
        ...(failure.retryable ? [{ label: 'retry', onSelect: () => void save.save() }] : []),
        { label: 'keep editing', onSelect: save.dismiss },
        { label: 'discard my changes', onSelect: save.cancel },
      ]}
    />
  );
}

/**
 * THE SAVE WORD — F3a, and its law is on the canvas: "word + colour, never
 * colour alone" (line 208). The dot carries the colour, the word carries the
 * meaning, and a screen reader gets the meaning because the dot is empty.
 *
 * The saved version is READ OFF THE RESULT (`savedVersion`), never computed as
 * base+1 — see `commands.savedVersionOf`. When the result carried no version
 * the word is "saved" with no number, which is what not knowing looks like.
 */
export function SaveWord({ save, version }: { save: DocSaveHandle; version: number | null }) {
  const { tone, word } = saveWordOf(save, version);
  return (
    <span className={`de-word de-word--${tone}`} data-testid="doc-save-word">
      <span className="de-word__dot" aria-hidden />
      {word}
    </span>
  );
}

export function saveWordOf(
  save: DocSaveHandle,
  version: number | null,
): { tone: 'idle' | 'wait' | 'run' | 'info' | 'block'; word: string } {
  switch (save.state.phase) {
    case 'saving':
      return { tone: 'wait', word: 'saving…' };
    case 'conflict':
      return {
        tone: 'info',
        word:
          save.theirVersion === null
            ? 'a newer version was saved — see banner'
            : `v${save.theirVersion} saved elsewhere — see banner`,
      };
    case 'refused':
      return { tone: 'block', word: 'not saved — see the refusal' };
    case 'dirty':
      return { tone: 'idle', word: 'unsaved changes' };
    default: {
      if (save.savedVersion !== null) return { tone: 'run', word: `saved · v${save.savedVersion} · just now` };
      return { tone: 'idle', word: version === null ? 'saved' : `saved · v${version}` };
    }
  }
}
