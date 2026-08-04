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
 */
import { useEffect, useState } from 'react';
import type { IdentityProfileUpdateInput, IdentityProfileView } from '@tm8/contract';
import type { IdentityView } from '../data/seam';
import { Avatar } from '../kit';

export type ProfileDraftInput = Omit<IdentityProfileUpdateInput, 'clientMutationId'>;

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

type SaveState =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'saved' }
  | { phase: 'refused'; detail: string };

export function IdentityProfileSection({ identity, spaceId, onSave, onSaved }: IdentityProfileSectionProps) {
  const [displayName, setDisplayName] = useState('');
  const [avatar, setAvatar] = useState('');
  const [globalId, setGlobalId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ phase: 'idle' });

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
      <>
        <div className="set-section__head">
          <span className="set-section__title">Your profile</span>
        </div>
        <div className="set-absent" data-testid="profile-absent">
          <span className="set-absent__head">Your identity could not be read.</span>
          <span className="set-absent__why">
            identity.get did not resolve — there is no profile to edit until it does
          </span>
        </div>
      </>
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

  async function submit() {
    const input = fieldsToWrite();
    if (input.globalId !== undefined) {
      const bad = globalIdProblem(input.globalId);
      if (bad) {
        setProblem(bad);
        return;
      }
    }
    setProblem(null);
    if (Object.keys(input).length === 0) {
      setProblem('Nothing changed — there is nothing to save.');
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

  return (
    <>
      <div className="set-section__head">
        <span className="set-section__title">Your profile</span>
      </div>
      <div className="set-section__scroll">
        <div className="set-stack">
          <div className="set-profile__preview" data-testid="profile-preview">
            {actorId ? (
              <Avatar actorId={actorId} provenance="human" label={previewName} size={32} src={avatar.trim() || null} />
            ) : null}
            <div className="set-profile__preview-text">
              <span className="set-profile__preview-name">{previewName}</span>
              <span className="set-profile__preview-sub">
                @{identity.username}
                {globalId.trim() ? ` · ${globalId.trim()}` : ''}
              </span>
            </div>
          </div>

          <label className="set-profile__field">
            <span className="set-profile__label">Display name</span>
            <input
              className="set-profile__input"
              data-testid="profile-display-name"
              aria-label="Display name"
              value={displayName}
              maxLength={200}
              placeholder={identity.displayName ?? 'not set'}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>

          <label className="set-profile__field">
            <span className="set-profile__label">Avatar URL</span>
            <input
              className="set-profile__input"
              data-testid="profile-avatar"
              aria-label="Avatar URL"
              value={avatar}
              maxLength={2000}
              placeholder={identity.avatar ?? 'not set — the monogram above is what others see'}
              onChange={(e) => setAvatar(e.target.value)}
            />
          </label>

          <label className="set-profile__field">
            <span className="set-profile__label">Global id</span>
            <input
              className="set-profile__input"
              data-testid="profile-global-id"
              aria-label="Global id"
              value={globalId}
              maxLength={200}
              placeholder={identity.globalId ?? 'not set — e.g. google:12345'}
              onChange={(e) => setGlobalId(e.target.value)}
            />
            <span className="set-profile__help">{GLOBAL_ID_EXPLAINER}</span>
          </label>

          <span className="set-profile__help">{BLANK_UNCHANGED}</span>

          {problem ? (
            <span className="set-profile__problem" role="alert" data-testid="profile-problem">
              {problem}
            </span>
          ) : null}
          {save.phase === 'refused' ? (
            <span className="set-profile__problem" role="alert" data-testid="profile-refused">
              The server refused the write: {save.detail}
            </span>
          ) : null}
          {save.phase === 'saved' ? (
            <span className="set-profile__saved" data-testid="profile-saved">
              Saved — where your name and avatar appear, they now use this.
            </span>
          ) : null}

          <div>
            <button
              type="button"
              className="set-chip"
              data-testid="profile-save"
              disabled={save.phase === 'saving'}
              onClick={() => void submit()}
            >
              {save.phase === 'saving' ? 'Saving…' : 'Save profile'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
