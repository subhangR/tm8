/**
 * YOUR PROFILE — the identity-display editor (migration 067 / Identity v2).
 *
 * This section writes the VIEWER'S OWN `user_profiles` row through
 * `identity.profile.update` — the operation names no subject by design, so
 * this surface cannot edit anyone else even if it wanted to (doc 4: the
 * subject is the bound identity claim, resolved server-side).
 *
 * THE EMPTY STATE IS THE NORMAL STATE. Every profile field on every row is
 * NULL today (067 landed with no backfill), so this editor is built blank-
 * first: placeholders say "not set", the avatar preview renders the monogram
 * until a URL both exists and loads, and nothing assumes a filled profile.
 *
 * WHAT `globalId` IS — spelled out in the UI because users will otherwise
 * read it as a login. It is the cross-server display binding
 * (`issuer:subject`, e.g. `google:12345`): how two servers recognise the same
 * human FOR DISPLAY. It is a claim by the server hosting it, it grants
 * nothing, and it is never an authorization input (invariant I6). The copy
 * below states this; the code enforces its own side by never branching on it.
 *
 * A BLANK FIELD IS LEFT UNCHANGED, NOT CLEARED. The operation writes only
 * provided fields and its schema refuses empty strings (`min(1)`), so there
 * is no clear-a-field verb on this surface. Stated in the helper text rather
 * than silently true.
 *
 * ── LAYOUT PASS 2026-08-16 (SECTION-CONTRACT.md) ──────────────────────────
 *
 * This section used to hand-write the shell's `set-section__head` and render
 * its body into a flat `.set-stack`. Four things were wrong and are fixed
 * here; `identity-profile.css` carries the numbers.
 *
 *  1. NO MEASURE. It rendered no `.set-section__measure` at all, so on the
 *     reporter's 3016px display the globalId explainer came back as one 883px
 *     line. It is a form: `SectionFrame` caps it at `--set-measure` by default
 *     and this section keeps that on.
 *  2. NO GROUPING. Preview, three inputs, two paragraphs and a button were
 *     nine siblings on one 6px gap. They are now two named groups — how you
 *     appear here, and how you are recognised elsewhere — because those are
 *     two different questions with two different audiences.
 *  3. PROSE IN THE WRONG PLACE. The globalId explainer hung UNDER its input,
 *     so it was read after the box it explains, and the "blank is unchanged"
 *     sentence floated at the foot of the form belonging to nothing. Group
 *     prose now sits under the group title, above the fields it governs.
 *  4. THE CONFIRMATION MOVED THE BUTTON. `Saved …` mounted as a new sibling
 *     ABOVE the save button, shifting the control down under the pointer that
 *     had just pressed it. All four save states (idle · dirty · saving ·
 *     saved/refused) now render into ONE reserved status line beside the
 *     button, so the form's height does not change when they swap.
 *
 * WHERE A REFUSAL RENDERS. Beside the field it concerns, not at the foot of
 * the form: the client-side globalId check and any server refusal naming the
 * global id draw inside the globalId field. Only a refusal that concerns the
 * form as a whole ("nothing changed") goes to the action row.
 */
import { useEffect, useId, useState } from 'react';
import type { IdentityProfileUpdateInput, IdentityProfileView } from '@tm8/contract';
import type { IdentityView } from '../data/seam';
import { Avatar } from '../kit';
import { SectionAbsent, SectionFrame } from './SectionFrame';
import { SETTINGS_SECTIONS } from './types';
import './identity-profile.css';

export type ProfileDraftInput = Omit<IdentityProfileUpdateInput, 'clientMutationId'>;

/** The oracle's word for this section, read from the one list rather than
 *  re-typed — the shell does not pass a heading to this section. */
const HEADING = SETTINGS_SECTIONS.find((s) => s.id === 'account')!.heading;

export interface IdentityProfileSectionProps {
  identity: IdentityView | null;
  /** Active space, used only to select the stable member actor id. */
  spaceId: string;
  /** Adapter to `seam.commands.updateProfile`; the port mints the mutation id. */
  onSave: (input: ProfileDraftInput) => Promise<IdentityProfileView>;
  /** Notified with the written row so the host can refresh its identity read. */
  onSaved?: (view: IdentityProfileView) => void;
}

/** Mirrors the 067 check constraint + contract schema — validate BEFORE the
 *  wire so the user reads a sentence, not a constraint error. */
export function globalIdProblem(value: string): string | null {
  if (value.length < 3 || value.length > 200) {
    return 'globalId must be 3–200 characters.';
  }
  if (!/^[^:\s]+:\S+$/.test(value)) {
    return 'globalId must look like issuer:subject — a name, one colon, an id, no spaces (e.g. google:12345).';
  }
  return null;
}

export const GLOBAL_ID_EXPLAINER =
  'Your global id is a display binding, not a login. It is how two servers recognise you as the ' +
  'same person — for avatars and names only. It grants no access and is never used to decide ' +
  'permissions; each server decides membership on its own.';

const BLANK_UNCHANGED =
  'A field left blank is left unchanged — this operation writes only what you provide, and has no way to clear a value.';

/** Where a refusal belongs. The server answers in prose, so the only honest
 *  routing is to read which field it names; anything it does not name is a
 *  statement about the write as a whole and belongs beside the button. */
export function refusalField(detail: string): 'globalId' | 'form' {
  return /global[\s_-]?id/i.test(detail) ? 'globalId' : 'form';
}

type Problem = { where: 'globalId' | 'form'; text: string };

type SaveState =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'saved' }
  | { phase: 'refused'; detail: string };

export function IdentityProfileSection({ identity, spaceId, onSave, onSaved }: IdentityProfileSectionProps) {
  const [displayName, setDisplayName] = useState('');
  const [avatar, setAvatar] = useState('');
  const [globalId, setGlobalId] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [save, setSave] = useState<SaveState>({ phase: 'idle' });
  const uid = useId();

  // Seed the inputs once identity resolves; a later identity refresh must not
  // stomp what the user is mid-typing, so seed only fields still untouched ''.
  useEffect(() => {
    if (!identity) return;
    setDisplayName((cur) => cur || (identity.displayName ?? ''));
    setAvatar((cur) => cur || (identity.avatar ?? ''));
    setGlobalId((cur) => cur || (identity.globalId ?? ''));
  }, [identity]);

  if (identity === null) {
    return (
      <SectionFrame title={HEADING} bodyTestId="account-body">
        <SectionAbsent
          testId="profile-absent"
          head="Your identity could not be read."
          why="identity.get did not resolve — there is no profile to edit until it does"
        />
      </SectionFrame>
    );
  }

  const previewName = displayName.trim() || identity.username;
  const actorId = identity.memberships.find((membership) => membership.spaceId === spaceId)?.memberId ?? null;

  function fieldsToWrite(): ProfileDraftInput {
    const out: ProfileDraftInput = {};
    const name = displayName.trim();
    const url = avatar.trim();
    const gid = globalId.trim();
    if (name && name !== (identity!.displayName ?? '')) out.displayName = name;
    if (url && url !== (identity!.avatar ?? '')) out.avatar = url;
    if (gid && gid !== (identity!.globalId ?? '')) out.globalId = gid;
    return out;
  }

  const dirty = Object.keys(fieldsToWrite()).length > 0;

  /** Any edit retires the previous verdict: a "Saved" that outlives the value
   *  it described is a lie, and a refusal you are mid-way through fixing is
   *  noise. Both clear on the first keystroke after them. */
  function edited(set: (v: string) => void, value: string) {
    set(value);
    setProblem(null);
    setSave({ phase: 'idle' });
  }

  async function submit() {
    const input = fieldsToWrite();
    if (input.globalId !== undefined) {
      const bad = globalIdProblem(input.globalId);
      if (bad) {
        setProblem({ where: 'globalId', text: bad });
        return;
      }
    }
    setProblem(null);
    if (Object.keys(input).length === 0) {
      setProblem({ where: 'form', text: 'Nothing changed — there is nothing to save.' });
      return;
    }
    setSave({ phase: 'saving' });
    try {
      const written = await onSave(input);
      setSave({ phase: 'saved' });
      onSaved?.(written);
    } catch (error) {
      setSave({
        phase: 'refused',
        detail: String((error as { message?: string })?.message ?? error),
      });
    }
  }

  const refusedAt = save.phase === 'refused' ? refusalField(save.detail) : null;
  const refusalText = save.phase === 'refused' ? `The server refused the write: ${save.detail}` : '';

  /** ONE status line, four states. Precedence is deliberate: what just
   *  happened outranks what is merely pending, so a save that landed is not
   *  hidden by the fact the draft still differs from a stale identity read. */
  const status: { text: string; tone: 'saved' | 'problem' | 'quiet'; testId?: string } =
    save.phase === 'saving'
      ? { text: 'Saving…', tone: 'quiet' }
      : save.phase === 'saved'
        ? {
            text: 'Saved — where your name and avatar appear, they now use this.',
            tone: 'saved',
            testId: 'profile-saved',
          }
        : refusedAt === 'form'
          ? { text: refusalText, tone: 'problem', testId: 'profile-refused' }
          : problem?.where === 'form'
            ? { text: problem.text, tone: 'problem', testId: 'profile-problem' }
            : dirty
              ? { text: 'Unsaved changes.', tone: 'quiet' }
              : { text: '', tone: 'quiet' };

  const globalIdProblemText =
    problem?.where === 'globalId'
      ? { text: problem.text, testId: 'profile-problem' }
      : refusedAt === 'globalId'
        ? { text: refusalText, testId: 'profile-refused' }
        : null;

  return (
    <SectionFrame title={HEADING} bodyTestId="account-body">
      <div className="set-account">
        <div className="set-account__identity" data-testid="profile-preview">
          {actorId ? (
            <Avatar actorId={actorId} provenance="human" label={previewName} size={32} src={avatar.trim() || null} />
          ) : null}
          <div className="set-account__identity-text">
            <span className="set-account__identity-name">{previewName}</span>
            <span className="set-account__identity-sub">
              @{identity.username}
              {globalId.trim() ? ` · ${globalId.trim()}` : ''}
            </span>
          </div>
        </div>

        <form
          className="set-account__form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="set-account__group" role="group" aria-labelledby={`${uid}-here`}>
            <div className="set-account__group-head">
              <h3 className="set-account__group-title" id={`${uid}-here`}>
                How you appear here
              </h3>
              <p className="set-account__group-note">{BLANK_UNCHANGED}</p>
            </div>

            <label className="set-account__field">
              <span className="set-account__label">Display name</span>
              <input
                className="set-account__input"
                data-testid="profile-display-name"
                aria-label="Display name"
                value={displayName}
                maxLength={200}
                placeholder={identity.displayName ?? 'not set'}
                onChange={(e) => edited(setDisplayName, e.target.value)}
              />
              <span className="set-account__help">
                Shown instead of @{identity.username}. Your username itself is not editable here.
              </span>
            </label>

            <label className="set-account__field">
              <span className="set-account__label">Avatar URL</span>
              <input
                className="set-account__input"
                data-testid="profile-avatar"
                aria-label="Avatar URL"
                value={avatar}
                maxLength={2000}
                placeholder={identity.avatar ?? 'not set — the monogram above is what others see'}
                onChange={(e) => edited(setAvatar, e.target.value)}
              />
              <span className="set-account__help">
                The image above is the preview. If it does not load, the monogram stays.
              </span>
            </label>
          </div>

          <div className="set-account__group" role="group" aria-labelledby={`${uid}-elsewhere`}>
            <div className="set-account__group-head">
              <h3 className="set-account__group-title" id={`${uid}-elsewhere`}>
                How other servers recognise you
              </h3>
              <p className="set-account__group-note">{GLOBAL_ID_EXPLAINER}</p>
            </div>

            <label className="set-account__field">
              <span className="set-account__label">Global id</span>
              <input
                className="set-account__input"
                data-testid="profile-global-id"
                aria-label="Global id"
                value={globalId}
                maxLength={200}
                placeholder={identity.globalId ?? 'not set — e.g. google:12345'}
                aria-invalid={globalIdProblemText ? true : undefined}
                onChange={(e) => edited(setGlobalId, e.target.value)}
              />
              <span className="set-account__help">Format: issuer:subject, e.g. google:12345.</span>
              {globalIdProblemText ? (
                <span
                  className="set-account__field-problem"
                  role="alert"
                  data-testid={globalIdProblemText.testId}
                >
                  {globalIdProblemText.text}
                </span>
              ) : null}
            </label>
          </div>

          <div className="set-account__actions">
            {/* `type="button"` + an explicit handler, with the form's own
                onSubmit covering Enter-in-a-field: one entry point, and no
                reliance on implicit submission to reach the write. */}
            <button
              type="button"
              className="set-chip"
              data-testid="profile-save"
              disabled={save.phase === 'saving'}
              onClick={() => void submit()}
            >
              {/* The label does NOT change to "Saving…": that resized the
                  button mid-save and slid the status line under it. The
                  disabled state plus the status line carry the phase. */}
              Save profile
            </button>
            {/* Always mounted, `min-height` reserved: the four states swap text
                inside one line instead of mounting a sibling that pushes the
                button down under the pointer that just pressed it. */}
            <span
              className={`set-account__status${
                status.tone === 'quiet' ? '' : ` set-account__status--${status.tone}`
              }`}
              data-testid={status.testId}
              role={status.tone === 'problem' ? 'alert' : 'status'}
            >
              {status.text}
            </span>
          </div>
        </form>
      </div>
    </SectionFrame>
  );
}
