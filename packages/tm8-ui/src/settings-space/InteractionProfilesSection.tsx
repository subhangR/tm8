/**
 * Settings → Interaction profiles: the governance list
 * (`settings-governance/InteractionProfilesScreen.tsx`, mounted here as its
 * HANDOVER §7.1 describes) plus the one verb that has a server command — the
 * space default profile (`spaces.interactionProfile.setDefault`,
 * settings-revision guarded). Only an active profile can be the default; the
 * server says so if a stale list offers another.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { EntitySummary } from '@tm8/contract';
import type { SpaceDefaultsPort, SpaceDefaultsSnapshot } from '../data/space-defaults-port';
import { DisabledAction } from '../panels';
import { InteractionProfilesScreen } from '../settings-governance/InteractionProfilesScreen';
import { profileRowOf } from '../settings-governance/governance-model';
import type { LoadState } from '../settings-governance/port';
import { SectionAbsent, SectionFrame } from './SectionFrame';
import { SPACE_EDIT_UNAVAILABLE } from './reasons';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const SPACE_DEFAULT_SCOPE = { scope: 'space', label: 'space default' } as const;

export interface InteractionProfilesSectionProps {
  heading: string;
  spaceName: string;
  port?: SpaceDefaultsPort;
  canEdit: boolean;
}

export function InteractionProfilesSection({ heading, spaceName, port, canEdit }: InteractionProfilesSectionProps) {
  const [profiles, setProfiles] = useState<LoadState<readonly EntitySummary[]>>({ phase: 'loading' });
  const [defaults, setDefaults] = useState<{ value?: SpaceDefaultsSnapshot; error?: string }>({});
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!port) return;
    let live = true;
    void port.loadProfiles().then(
      (items) => live && setProfiles({ phase: 'ready', value: items }),
      (cause) => live && setProfiles({ phase: 'failed', message: errorText(cause) }),
    );
    void port.loadDefaults().then(
      (value) => live && setDefaults({ value }),
      (cause) => live && setDefaults({ error: errorText(cause) }),
    );
    return () => {
      live = false;
    };
  }, [port, revision]);

  if (!port) {
    return (
      <SectionFrame title={heading}>
        <SectionAbsent head="Interaction profiles are not available here." why="this host passed no space-defaults port" />
      </SectionFrame>
    );
  }
  const current = defaults.value?.defaultInteractionProfileId ?? null;
  return (
    <SectionFrame title={heading}>
      <DefaultProfilePicker
        profiles={profiles}
        defaults={defaults}
        canEdit={canEdit}
        set={port.setDefaultProfile}
        onSaved={reload}
      />
      <InteractionProfilesScreen
        spaceLabel={`space · ${spaceName}`}
        profiles={profiles}
        // The space default is read; teammate defaults are not, so every other
        // row stays "defaults unread" rather than claiming "not a default".
        {...(defaults.value ? { defaultsFor: (p: EntitySummary) => (p.id === current ? [SPACE_DEFAULT_SCOPE] : undefined) } : {})}
      />
    </SectionFrame>
  );
}

function DefaultProfilePicker({
  profiles,
  defaults,
  canEdit,
  set,
  onSaved,
}: {
  profiles: LoadState<readonly EntitySummary[]>;
  defaults: { value?: SpaceDefaultsSnapshot; error?: string };
  canEdit: boolean;
  set?: SpaceDefaultsPort['setDefaultProfile'];
  onSaved: () => void;
}) {
  const current = defaults.value?.defaultInteractionProfileId ?? null;
  const [draft, setDraft] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(current ?? ''), [current]);
  if (defaults.error) return <p role="alert">The space default could not be read: {defaults.error}</p>;
  if (!defaults.value || profiles.phase !== 'ready') return <p role="status">Reading the space default…</p>;
  const active = profiles.value.filter((p) => profileRowOf(p).status === 'active');
  const currentTitle = profiles.value.find((p) => p.id === current)?.title;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!set || !defaults.value) return;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await set(draft === '' ? null : draft, defaults.value.revision);
      setSaved(true);
      onSaved();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Space default profile" className="set-space-access">
      <h3>Space default profile</h3>
      <p>
        New sessions in this space use this profile unless their teammate names its own. Currently:{' '}
        {current === null ? 'the node’s core default' : (currentTitle ?? current)}.
      </p>
      {!canEdit || !set ? (
        <DisabledAction reason={SPACE_EDIT_UNAVAILABLE} label="change the space default profile">
          Change default profile
        </DisabledAction>
      ) : (
        <form onSubmit={submit}>
          <fieldset disabled={busy}>
            <label>
              Default profile
              <select value={draft} onChange={(event) => setDraft(event.target.value)}>
                <option value="">Core default (no space default)</option>
                {current !== null && !active.some((p) => p.id === current) && (
                  <option value={current}>{currentTitle ?? current} (not active)</option>
                )}
                {active.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={draft === (current ?? '')}>
              Save default profile
            </button>
          </fieldset>
        </form>
      )}
      {error && <p role="alert">Not saved: {error}</p>}
      {saved && <p role="status">Space default profile saved.</p>}
    </section>
  );
}
