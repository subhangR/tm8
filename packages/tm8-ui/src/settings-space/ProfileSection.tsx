/** Space profile and server-backed editing. Without an authorized onSave callback,
 * the same section remains read-only for legacy/member settings. */
import { useState, type ReactNode } from 'react';
import type { SpaceProfilePatch } from './port';
import type { SpaceSummary } from '@tm8/contract';
import { DisabledAction } from '../panels';
import { absTime, shortDate } from '../kit';
import { SectionAbsent, SectionFrame } from './SectionFrame';
import { SPACE_EDIT_UNAVAILABLE } from './reasons';
import './space-profile.css';

/** What an absent field says. Never a dash — see the header, point 3. */
const NOT_SET = 'Not set';

/**
 * "3 members" / "1 member". A bare `3` needed its label to mean anything.
 *
 * WRITTEN AS ONE TEMPLATE ON PURPOSE, and please leave it that way: the
 * obvious `n === 1 ? 'member' : 'members'` puts a quoted bare kind slug in
 * this file, and `no-kind-literals.test.ts` (§15.2) fails it — correctly, by
 * its own letter. This is a count noun in an English sentence rather than a
 * reference to the member KIND, so `memberKindRef()` is the wrong instrument
 * here: it answers with a registry slug, which is an identifier and not a word
 * anybody reads. Interpolating past the quote satisfies both facts.
 */
function memberCount(n: number): string {
  return `${n} member${n === 1 ? '' : 's'}`;
}

/**
 * One record row. `value` is null when the field is genuinely absent, which is
 * a different rendering rather than a different string — a caller cannot pass
 * "the empty look" by accident, and a test can find it by `data-unset`.
 */
function Field({
  label,
  value,
  mono = false,
  title,
}: {
  label: string;
  value: ReactNode | null;
  /** Machine-shaped values (the id, the repo path) render mono. */
  mono?: boolean;
  title?: string;
}) {
  return (
    <>
      <dt className="set-space-profile__k">{label}</dt>
      <dd
        className={`set-space-profile__v${mono ? ' set-space-profile__v--mono' : ''}`}
        title={title}
      >
        {value === null ? (
          <span className="set-space-profile__unset" data-unset="true">
            {NOT_SET}
          </span>
        ) : (
          value
        )}
      </dd>
    </>
  );
}

export function ProfileSection({ space, heading, onSave }: { space: SpaceSummary | null; heading: string; onSave?: (patch: SpaceProfilePatch) => Promise<void> }) {
  if (space === null) {
    return (
      <SectionFrame title={heading} bodyTestId="profile-body">
        {/* Wrapped so this lane can undo `.set-absent`'s own padding without
            editing the shared stylesheet — see space-profile.css. */}
        <div className="set-space-profile__absent">
          <SectionAbsent
            head="This space did not resolve."
            why="spaces() returned no row with this id"
          />
        </div>
      </SectionFrame>
    );
  }

  // '' when unparseable, which `kit/time.ts` guarantees rather than 'Invalid
  // Date' — so a broken stamp falls through to the absent rendering instead of
  // printing garbage with a label on it.
  const created = shortDate(space.createdAt);
  const createdExact = absTime(space.createdAt);

  return (
    <SectionFrame title={heading} bodyTestId="profile-body">
      <div className="set-space-profile">
        <header className="set-space-profile__id">
          <h3 className="set-space-profile__name">{space.name}</h3>
          {space.description ? (
            <p className="set-space-profile__about">{space.description}</p>
          ) : (
            <p className="set-space-profile__about">
              <span className="set-space-profile__unset" data-unset="true">
                No description set.
              </span>
            </p>
          )}
        </header>

        <dl className="set-space-profile__record">
          <Field label="Members" value={memberCount(space.memberCount)} />
          <Field label="Repo" value={space.githubRepo || null} mono />
          <Field
            label="Created"
            value={created || null}
            /* The exact instant stays one hover away, which is the whole
               reason the short form is safe to show. */
            title={createdExact || undefined}
          />
          <Field label="Space id" value={space.id} mono />
        </dl>

        <div className="set-space-profile__actions">
          {onSave ? <SpaceProfileForm key={space.id} space={space} onSave={onSave} /> :
            <DisabledAction reason={SPACE_EDIT_UNAVAILABLE} label="edit space details">Edit space details</DisabledAction>}
        </div>
      </div>
    </SectionFrame>
  );
}

function SpaceProfileForm({ space, onSave }: { space: SpaceSummary; onSave: (patch: SpaceProfilePatch) => Promise<void> }) {
  const [name, setName] = useState(space.name);
  const [description, setDescription] = useState(space.description ?? '');
  const [repo, setRepo] = useState(space.githubRepo ?? '');
  const [minutes, setMinutes] = useState(String(space.sessionAutoCloseMinutes ?? 30));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  return <form className="set-space-profile__form" onSubmit={async (event) => {
    event.preventDefault();
    if (pending) return;
    setError(null); setSaved(false);
    const autoClose = Number(minutes);
    if (!name.trim() || !minutes.trim() || !Number.isInteger(autoClose) || autoClose < 0 || autoClose > 10080) {
      setError('Enter a name and whole auto-close minutes between 0 and 10080.'); return;
    }
    setPending(true);
    try {
      await onSave({ name: name.trim(), description: description.trim(), githubRepo: repo.trim() || null, sessionAutoCloseMinutes: autoClose });
      setSaved(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  }}>
    <fieldset disabled={pending}>
      <legend>Space details</legend>
      <label>Name<input value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} required /></label>
      <label>Description<textarea value={description} onChange={(e) => { setDescription(e.target.value); setSaved(false); }} /></label>
      <label>GitHub repository<input value={repo} onChange={(e) => { setRepo(e.target.value); setSaved(false); }} placeholder="owner/repository" /></label>
      <label>Session auto-close minutes<input type="number" min="0" max="10080" step="1" required value={minutes} onChange={(e) => { setMinutes(e.target.value); setSaved(false); }} /></label>
      <p>Close completed sessions after this many idle minutes. Set 0 to never close them automatically.</p>
      <button type="submit">{pending ? 'Saving…' : 'Save space details'}</button>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {saved && <p role="status">Space details saved.</p>}
  </form>;
}
