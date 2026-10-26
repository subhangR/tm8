import { useState } from 'react';
import type { ToolInput, ToolView } from '@tm8/contract';
import type { ToolPermissions, ToolPort } from './port';
import { initialValues, parseValue } from './values';
import { InputValue } from './InputValue';

function ConfigInput({ tool, input, port, permissions, refresh }: { tool: ToolView; input: ToolInput; port: ToolPort; permissions: ToolPermissions; refresh(): Promise<void> }) {
  const [value, setValue] = useState(initialValues(tool)[input.name] ?? '');
  const [settingSecret, setSettingSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const binding = tool.secretBindings.find(item => item.inputName === input.name);
  async function mutate(action: () => Promise<unknown>, secret = false) {
    setBusy(true); setError('');
    try { await action(); setSettingSecret(false); await refresh(); }
    catch (failure) { setError(secret ? 'The secret could not be saved. Check your permissions and try again.' : failure instanceof Error ? failure.message : 'Configuration could not be saved.'); }
    finally { setBusy(false); }
  }
  return <article className="tool-config-row"><div><strong>{input.name}</strong>{input.required && <span> · required</span>}{input.description && <p>{input.description}</p>}</div>
    {input.type === 'secret' ? <>
      <p>{binding ? `Secret set${binding.keyHint ? ` · ${binding.keyHint}` : ''}` : 'No secret set'}</p>
      {permissions.setSecret ? <>
        {!settingSecret && <button type="button" className="pn-btn" disabled={busy} onClick={() => setSettingSecret(true)}>Set secret for {input.name}</button>}
        {settingSecret && <form onSubmit={event => {
          event.preventDefault(); const form = event.currentTarget; const secret = String(new FormData(form).get('secret') ?? ''); form.reset();
          void mutate(() => port.setSecret(tool, input.name, secret), true);
        }}><label>Secret for {input.name}<input name="secret" type="password" autoComplete="off" required disabled={busy} /></label>
          <button className="pn-btn pn-btn--primary" disabled={busy}>Save secret</button><button type="button" className="pn-btn" disabled={busy} onClick={() => setSettingSecret(false)}>Cancel</button>
        </form>}
        {binding && <button type="button" className="pn-btn" disabled={busy} onClick={() => void mutate(() => port.unsetSecret(tool, input.name), true)}>Unset secret for {input.name}</button>}
      </> : <p>Only a human can set secrets.</p>}
    </> : <form onSubmit={event => { event.preventDefault(); void mutate(() => port.setConfig(tool, input.name, parseValue(input, value))); }}>
      <InputValue input={input} value={value} onChange={setValue} disabled={busy || !permissions.configure} label={`Configured ${input.name}`} />
      <button className="pn-btn" disabled={busy || !permissions.configure}>Save {input.name}</button>
      {Object.prototype.hasOwnProperty.call(tool.config, input.name) && <button type="button" className="pn-btn" disabled={busy || !permissions.configure} onClick={() => void mutate(() => port.unsetConfig(tool, input.name))}>Unset {input.name}</button>}
    </form>}
    {error && <p role="alert">{error}</p>}
  </article>;
}
export function ToolConfig(props: { tool: ToolView; port: ToolPort; permissions: ToolPermissions; refresh(): Promise<void> }) {
  return <section aria-label="Configuration"><h3>Configuration</h3><p>Saved values prefill each run. Secret values are never shown.</p>
    {props.tool.definition.inputs.map(input => <ConfigInput key={`${input.name}:${props.tool.version}`} {...props} input={input} />)}
    {!props.tool.definition.inputs.length && <p>No inputs declared.</p>}
  </section>;
}
