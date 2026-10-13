/**
 * Node admin → Configuration. A curated set of node settings is editable
 * (`node.settings.set`, migration 323); everything else is read-only, grouped.
 *
 * What the server decides and this screen only reports:
 *   - precedence env > stored > default — a variable the server environment
 *     sets outranks a stored value;
 *   - every setting applies at the next restart, so a saved value shows
 *     "Restart needed" until the server has booted with it;
 *   - turning off loopback sign-in needs an admin signed in with a password
 *     (the server refuses otherwise, and the refusal is shown as given).
 * Provider keys are never edited here; they point at Node credentials.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ConfigKnobView, NodeSettingSetResult, SpaceConfigsView } from '@tm8/contract';
import { SectionFrame } from '../settings-space/SectionFrame';
import { valueLabel } from '../settings-space/ConfigsSection';

export const NODE_SETTINGS_PRECEDENCE =
  'Precedence: a variable set in the server environment wins; otherwise a stored setting applies; otherwise the default. Stored settings take effect when the server restarts.';

const SOURCE_TEXT: Record<ConfigKnobView['source'], string> = {
  env: 'server environment',
  db: 'stored setting',
  default: 'default',
  persona: 'persona',
  profile: 'profile',
  code: 'code constant',
};

/** Settings whose change can turn off loopback sign-in at the next restart. */
const LOCKOUT_NOTE: Record<string, string> = {
  TM8_NODE_MODE:
    'multi turns off loopback sign-in at the next restart. You must be signed in with your account password to choose it.',
  TM8_DISABLE_AUTO_OWNER:
    'true turns off loopback sign-in at the next restart. You must be signed in with your account password to choose it.',
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function groupBy(knobs: ConfigKnobView[]): Array<[string, ConfigKnobView[]]> {
  const groups = new Map<string, ConfigKnobView[]>();
  for (const knob of knobs) groups.set(knob.group, [...(groups.get(knob.group) ?? []), knob]);
  return [...groups];
}

export interface NodeConfigurationSectionProps {
  load: () => Promise<SpaceConfigsView>;
  save?: (name: string, value: string | null) => Promise<NodeSettingSetResult>;
  onOpenCredentials?: () => void;
}

export function NodeConfigurationSection({ load, save, onOpenCredentials }: NodeConfigurationSectionProps) {
  const [state, setState] = useState<{ value?: SpaceConfigsView; error?: string }>({});
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    void load().then(
      (value) => live && setState({ value }),
      (error) => live && setState({ error: errorText(error) }),
    );
    return () => {
      live = false;
    };
  }, [load, revision]);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const { value, error } = state;
  const knobs = value?.node.visible ? value.node.knobs : [];
  const editable = knobs.filter((knob) => knob.setting);
  const readOnly = knobs.filter((knob) => !knob.setting);
  const pending = editable.filter((knob) => knob.setting!.restartPending);
  return (
    <SectionFrame title="Configuration">
      <p>{NODE_SETTINGS_PRECEDENCE} Secret values are never displayed.</p>
      {error ? (
        <p role="alert">Configuration could not be read: {error}</p>
      ) : !value ? (
        <p role="status">Reading configuration…</p>
      ) : !value.node.visible ? (
        <p role="alert">{value.node.reason}</p>
      ) : (
        <>
          {pending.length > 0 && (
            <p role="status" className="node-config__pending">
              Restart the server to apply: {pending.map((knob) => knob.name).join(', ')}.
            </p>
          )}
          <section aria-label="Editable settings">
            <h3>Editable settings</h3>
            {groupBy(editable).map(([group, rows]) => (
              <div key={group}>
                <h4>{group}</h4>
                <ul className="node-admin__list">
                  {rows.map((knob) => (
                    <SettingRow key={knob.name} knob={knob} save={save} onSaved={reload} />
                  ))}
                </ul>
              </div>
            ))}
          </section>
          <section aria-label="Read-only settings">
            <h3>Read-only settings</h3>
            <p>Change these in the server environment and restart, or in code.</p>
            {[...groupBy(readOnly), ['Code constants', value.code] as [string, ConfigKnobView[]]].map(
              ([group, rows]) => (
                <details key={group} className="node-config__group">
                  <summary>
                    {group} ({rows.length})
                  </summary>
                  <ul className="node-admin__list">
                    {rows.map((knob) => (
                      <li key={knob.name}>
                        <strong>{knob.name}</strong>
                        <code>{valueLabel(knob.value)}</code>
                        <p>{knob.summary}</p>
                        <span>
                          Source: {SOURCE_TEXT[knob.source]}
                          {knob.default !== null ? ` · Default: ${knob.default}` : ''}
                        </span>
                        {knob.managedIn === 'node_credentials' ? (
                          <span>
                            Provider keys are managed in Node credentials.{' '}
                            {onOpenCredentials && (
                              <button type="button" className="node-config__link" onClick={onOpenCredentials}>
                                Open Node credentials
                              </button>
                            )}
                          </span>
                        ) : (
                          <span>
                            {knob.change === 'env'
                              ? `Set ${knob.name} in the server environment and restart.`
                              : 'Requires a code change.'}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              ),
            )}
          </section>
        </>
      )}
    </SectionFrame>
  );
}

function SettingRow({
  knob,
  save,
  onSaved,
}: {
  knob: ConfigKnobView;
  save?: (name: string, value: string | null) => Promise<NodeSettingSetResult>;
  onSaved: () => void;
}) {
  const setting = knob.setting!;
  const [draft, setDraft] = useState(setting.stored ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const write = async (value: string | null) => {
    if (!save) return;
    setBusy(true);
    setError(undefined);
    try {
      await save(knob.name, value);
      onSaved();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const inputId = `node-setting-${knob.name}`;
  const input = setting.input;
  return (
    <li data-setting={knob.name}>
      <strong>{knob.name}</strong>
      <p>{knob.summary}</p>
      <span>
        Running value: <code>{valueLabel(knob.value)}</code> · Source: {SOURCE_TEXT[knob.source]}
        {knob.default !== null ? ` · Default: ${knob.default}` : ''}
      </span>
      <span>
        Stored setting: {setting.stored === null ? 'none' : <code>{setting.stored}</code>} · Applies after a
        server restart
      </span>
      {setting.pinnedByEnv && (
        <span role="note">
          Set in the server environment, which outranks a stored setting. A stored value applies only once{' '}
          {knob.name} is removed from the environment.
        </span>
      )}
      {setting.restartPending && (
        <span role="status" className="node-config__pending">
          Restart needed: the server is not yet running the stored value.
        </span>
      )}
      {LOCKOUT_NOTE[knob.name] && <span role="note">{LOCKOUT_NOTE[knob.name]}</span>}
      {save ? (
        <form
          className="node-config__editor"
          onSubmit={(event) => {
            event.preventDefault();
            void write(draft.trim() === '' ? null : draft);
          }}
        >
          <label htmlFor={inputId}>New value</label>
          {input.kind === 'enum' ? (
            <select id={inputId} value={draft} onChange={(event) => setDraft(event.target.value)} disabled={busy}>
              <option value="">(no stored value)</option>
              {input.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={inputId}
              value={draft}
              disabled={busy}
              placeholder={
                input.kind === 'integer'
                  ? `a whole number ≥ ${input.min}${input.unlimited ? ', or unlimited' : ''}`
                  : `absolute directories separated by ${input.delimiter}`
              }
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
          <button type="submit" disabled={busy || draft === (setting.stored ?? '')}>
            Save
          </button>
          {setting.stored !== null && (
            <button type="button" disabled={busy} onClick={() => void write(null)}>
              Clear stored value
            </button>
          )}
        </form>
      ) : (
        <span>This node does not accept setting changes from the UI.</span>
      )}
      {error && <p role="alert">Not saved: {error}</p>}
    </li>
  );
}
