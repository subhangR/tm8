/**
 * Settings → Access & style: two space-wide defaults a space admin sets.
 *
 * - "Require a space password" (`spaces.spacePassword.setRequired`). The
 *   server owns every rule: turning it on is an owner's act, needs the node to
 *   run TM8_SPACE_SESSIONS=enforce, and needs the caller's own space password
 *   unless they already have one. Its refusal is shown as given.
 * - The default style (`spaces.styleDefault.set`), from the styles the space
 *   can resolve (`styles.list`), revision-guarded.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { SpaceSummary } from '@tm8/contract';
import type { SpaceDefaultsPort, SpaceStyleChoice } from '../data/space-defaults-port';
import { DisabledAction } from '../panels';
import { SectionFrame } from './SectionFrame';
import { SPACE_EDIT_UNAVAILABLE } from './reasons';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface SpaceAccessSectionProps {
  heading: string;
  space: SpaceSummary | null;
  port?: SpaceDefaultsPort;
  /** The viewer administers this space; otherwise every control is refused. */
  canEdit: boolean;
  /** The space row changed (the password requirement); the host re-reads it. */
  onSpaceChanged?: () => void;
}

export function SpaceAccessSection({ heading, space, port, canEdit, onSpaceChanged }: SpaceAccessSectionProps) {
  return (
    <SectionFrame title={heading}>
      <PasswordRequirement space={space} port={port} canEdit={canEdit} onChanged={onSpaceChanged} />
      <DefaultStyle port={port} canEdit={canEdit} />
    </SectionFrame>
  );
}

function PasswordRequirement({
  space,
  port,
  canEdit,
  onChanged,
}: {
  space: SpaceSummary | null;
  port?: SpaceDefaultsPort;
  canEdit: boolean;
  onChanged?: () => void;
}) {
  const known = space?.requireSpacePassword;
  const [required, setRequired] = useState<boolean | undefined>(known);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  useEffect(() => setRequired(known), [known]);
  const set = port?.setPasswordRequired;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!set || required === undefined) return;
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      const result = await set(!required, password || undefined);
      setRequired(result.requireSpacePassword);
      setPassword('');
      setNote(
        result.requireSpacePassword
          ? `Space password required. ${result.revokedSessionIds.length} session(s) signed in without one were ended.`
          : 'Space password no longer required.',
      );
      onChanged?.();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Space password" className="set-space-access">
      <h3>Space password</h3>
      <p>
        When required, members enter a space password, besides their account password, to open this space. Turning
        it on needs the node to run with <code>TM8_SPACE_SESSIONS=enforce</code>, and only an owner can turn it on.
      </p>
      <p role="status">
        Currently: {required === undefined ? 'not reported by this server' : required ? 'required' : 'not required'}
      </p>
      {!canEdit || !set ? (
        <DisabledAction reason={SPACE_EDIT_UNAVAILABLE} label="change the space password requirement">
          Change requirement
        </DisabledAction>
      ) : required === undefined ? null : (
        <form onSubmit={submit}>
          <fieldset disabled={busy}>
            {!required && (
              <label>
                Your space password (only if you do not have one yet)
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            )}
            <button type="submit">{required ? 'Stop requiring a space password' : 'Require a space password'}</button>
          </fieldset>
        </form>
      )}
      {error && <p role="alert">Not changed: {error}</p>}
      {note && <p role="status">{note}</p>}
    </section>
  );
}

function DefaultStyle({ port, canEdit }: { port?: SpaceDefaultsPort; canEdit: boolean }) {
  const [state, setState] = useState<{ value?: SpaceStyleChoice; error?: string }>({});
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const load = port?.loadStyle;
  useEffect(() => {
    if (!load) return;
    let live = true;
    void load().then(
      (value) => {
        if (!live) return;
        setState({ value });
        setDraft(value.defaultStyle);
      },
      (cause) => live && setState({ error: errorText(cause) }),
    );
    return () => {
      live = false;
    };
  }, [load, revision]);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const set = port?.setStyleDefault;
  const { value } = state;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!set || !value) return;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await set(draft, value.revision);
      setSaved(true);
      reload();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Default style" className="set-space-access">
      <h3>Default style</h3>
      <p>The style members see until they choose their own.</p>
      {!load ? (
        <p>This server does not report styles.</p>
      ) : state.error ? (
        <p role="alert">Styles could not be read: {state.error}</p>
      ) : !value ? (
        <p role="status">Reading styles…</p>
      ) : !canEdit || !set ? (
        <>
          <p>
            Current default: <code>{value.defaultStyle}</code>
          </p>
          <DisabledAction reason={SPACE_EDIT_UNAVAILABLE} label="change the default style">
            Change default style
          </DisabledAction>
        </>
      ) : (
        <form onSubmit={submit}>
          <fieldset disabled={busy}>
            <label>
              Default style
              <select value={draft} onChange={(event) => setDraft(event.target.value)}>
                {!value.styles.some((style) => style.ref === value.defaultStyle) && (
                  <option value={value.defaultStyle}>{value.defaultStyle} (no longer available)</option>
                )}
                {value.styles.map((style) => (
                  <option key={style.ref} value={style.ref}>
                    {style.title} ({style.origin === 'builtin' ? 'built-in' : 'space style'})
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={draft === value.defaultStyle}>
              Save default style
            </button>
          </fieldset>
        </form>
      )}
      {error && <p role="alert">Not saved: {error}</p>}
      {saved && <p role="status">Default style saved.</p>}
    </section>
  );
}
