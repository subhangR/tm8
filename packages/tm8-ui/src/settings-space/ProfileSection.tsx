/** Space profile and server-backed editing. Without an authorized onSave callback,
 * the same section remains read-only for legacy/member settings. */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { SpaceProfilePatch } from './port';
import type { EntitySummary, SpaceSummary } from '@tm8/contract';
import type { SpaceDefaultsPort, SpaceDefaultsSnapshot } from '../data/space-defaults-port';
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

/** `private` is the default: only members see the space. */
export const VISIBILITY_LABEL: Record<'private' | 'public', string> = {
  private: 'Private — only members can find it',
  public: 'Public — listed for anyone on this node to discover',
};

export function ProfileSection({ space, heading, onSave, defaults }: {
  space: SpaceSummary | null;
  heading: string;
  onSave?: (patch: SpaceProfilePatch) => Promise<void>;
  /** The default-channel read and write; absent ⇒ the row is not shown. */
  defaults?: SpaceDefaultsPort;
}) {
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
          {/* Only when the server reports it: an older node's absence is not "Not set". */}
          {space.visibility && <Field label="Visibility" value={VISIBILITY_LABEL[space.visibility]} />}
          <Field label="Space id" value={space.id} mono />
        </dl>

        {defaults && <DefaultChannelField port={defaults} canEdit={!!onSave} />}

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
  const [minutesChanged, setMinutesChanged] = useState(false);
  const [visibility, setVisibility] = useState(space.visibility ?? 'private');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setSaved(false);
    const autoClose = Number(minutes);
    if (!name.trim() || !minutes.trim() || !Number.isInteger(autoClose) || autoClose < 0 || autoClose > 10080) {
      setError('Enter a name and whole auto-close minutes between 0 and 10080.');
      return;
    }
    setPending(true);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim(),
        githubRepo: repo.trim() || null,
        ...(space.sessionAutoCloseMinutes !== undefined || minutesChanged
          ? { sessionAutoCloseMinutes: autoClose }
          : {}),
        // Sent only when this server reports visibility, or the admin changed it.
        ...(space.visibility !== undefined || visibility !== 'private' ? { visibility } : {}),
      });
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="set-space-profile__form" onSubmit={submit}>
      <fieldset disabled={pending}>
        <legend>Space details</legend>
        <label>
          Name
          <input required value={name} onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
          }} />
        </label>
        <label>
          Description
          <textarea value={description} onChange={(event) => {
            setDescription(event.target.value);
            setSaved(false);
          }} />
        </label>
        <label>
          GitHub repository
          <input value={repo} placeholder="owner/repository" onChange={(event) => {
            setRepo(event.target.value);
            setSaved(false);
          }} />
        </label>
        <label>
          Session auto-close minutes
          <input type="number" min="0" max="10080" step="1" required value={minutes}
            onChange={(event) => {
              setMinutes(event.target.value);
              setMinutesChanged(true);
              setSaved(false);
            }} />
        </label>
        <p>Close completed sessions after this many idle minutes. Set 0 to never close them automatically.</p>
        <label>
          Visibility
          <select value={visibility} onChange={(event) => {
            setVisibility(event.target.value as 'private' | 'public');
            setSaved(false);
          }}>
            <option value="private">{VISIBILITY_LABEL.private}</option>
            <option value="public">{VISIBILITY_LABEL.public}</option>
          </select>
        </label>
        <button type="submit">{pending ? 'Saving…' : 'Save space details'}</button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">Space details saved.</p>}
    </form>
  );
}

/**
 * The space's default channel (`spaces.defaultChannel.set`, settings-revision
 * guarded): where a member lands when they open the space.
 */
function DefaultChannelField({ port, canEdit }: { port: SpaceDefaultsPort; canEdit: boolean }) {
  const [state, setState] = useState<{ defaults?: SpaceDefaultsSnapshot; channels?: EntitySummary[]; error?: string }>({});
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.all([port.loadDefaults(), port.loadChannels()]).then(
      ([defaults, channels]) => {
        if (!live) return;
        setState({ defaults, channels });
        setDraft(defaults.defaultChannelId ?? '');
      },
      (cause: unknown) => live && setState({ error: cause instanceof Error ? cause.message : String(cause) }),
    );
    return () => {
      live = false;
    };
  }, [port, revision]);
  const set = port.setDefaultChannel;
  const { defaults, channels } = state;
  const current = defaults?.defaultChannelId ?? null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!set || !defaults) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await set(draft === '' ? null : draft, defaults.revision);
      setSaved(true);
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="set-space-profile__form" aria-label="Default channel">
      <h4>Default channel</h4>
      {state.error ? (
        <p role="alert">The default channel could not be read: {state.error}</p>
      ) : !defaults || !channels ? (
        <p role="status">Reading channels…</p>
      ) : !canEdit || !set ? (
        <p>
          {current === null
            ? 'No default channel is set.'
            : `Members open ${channels.find((c) => c.id === current)?.title ?? current} first.`}
        </p>
      ) : (
        <form onSubmit={submit}>
          <fieldset disabled={busy}>
            <label>
              Channel members open first
              <select value={draft} onChange={(event) => {
                setDraft(event.target.value);
                setSaved(false);
              }}>
                <option value="">No default channel</option>
                {current !== null && !channels.some((c) => c.id === current) && (
                  <option value={current}>{current} (not readable)</option>
                )}
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>{c.title}</option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={draft === (current ?? '')}>Save default channel</button>
          </fieldset>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">Default channel saved.</p>}
    </section>
  );
}
