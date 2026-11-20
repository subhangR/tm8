import { useCallback, useState, type FormEvent } from 'react';
import type { PasskeyAuthorization } from './port';
import {
  CommandNotice, LoadState, Metadata, dateLabel, hasOwnerSession, useVaultCommand, useVaultResource,
  type SurfaceProps,
} from './ui';

export function SessionControls({ port, status, readOnly, onStatusChange }: SurfaceProps) {
  const command = useVaultCommand();
  const session = status.viewer.vaultSession;
  return <div className="vault-session" aria-label="Vault sign-in">
    <p>{session ? <>Vault session expires <time dateTime={session.expiresAt}>{dateLabel(session.expiresAt)}</time>.
      {!hasOwnerSession(status) ? <strong> Session expired.</strong> : null}</> : 'Sign in with a passkey to manage the vault.'}</p>
    <div className="vault-actions">
      {(!session || !hasOwnerSession(status)) ? <button type="button" disabled={readOnly || command.busy}
        onClick={() => void command.run(() => port.signIn(), onStatusChange)}>Sign in with passkey</button> : null}
      {session ? <>
        <button type="button" disabled={readOnly || command.busy}
          onClick={() => void command.run(() => port.sessionRefresh(), () => {
            command.setNotice('Vault session refreshed.'); onStatusChange();
          })}>Refresh session</button>
        <button type="button" disabled={readOnly || command.busy}
          onClick={() => void command.run(() => port.sessionEnd(), onStatusChange)}>Sign out of vault</button>
      </> : null}
    </div><CommandNotice command={command} />
  </div>;
}

export function PasskeysPanel(props: SurfaceProps) {
  const { port, status, readOnly, onStatusChange } = props;
  const owner = hasOwnerSession(status);
  const load = useCallback(async () => owner ? port.passkeysList() : null, [port, owner]);
  const resource = useVaultResource(load);
  const command = useVaultCommand();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<PasskeyAuthorization['kind']>('enrollment');
  const [code, setCode] = useState('');
  const [confirmLast, setConfirmLast] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const active = resource.value?.passkeys.filter((passkey) => !passkey.revokedAt).length ?? 0;

  function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const authorization: PasskeyAuthorization = kind === 'passkey' ? { kind } : { kind, code };
    setCode('');
    void command.run(() => port.passkeyRegister(name.trim(), authorization), () => {
      setName(''); command.setNotice('Passkey registered.'); resource.reload(); onStatusChange();
    });
  }

  return <section aria-labelledby="vault-passkeys-title">
    <h3 id="vault-passkeys-title">Passkeys and recovery</h3>
    <p>Enroll with a broker-issued enrollment code, recover with a one-time code, or verify an existing passkey.</p>
    <form className="vault-form" onSubmit={register}>
      <label>Passkey name<input required maxLength={64} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Registration authorization<select value={kind} onChange={(event) => {
        setKind(event.target.value as PasskeyAuthorization['kind']); setCode('');
      }}>
        <option value="enrollment">Enrollment code</option><option value="recovery">Recovery code</option>
        <option value="passkey" disabled={!owner}>Existing passkey (step-up)</option>
      </select></label>
      {kind !== 'passkey' ? <label>{kind === 'enrollment' ? 'Enrollment code' : 'Recovery code'}
        <input type="password" required minLength={8} maxLength={64} autoComplete="one-time-code" value={code}
          onChange={(event) => setCode(event.target.value)} /></label> : null}
      <button type="submit" disabled={readOnly || command.busy || (kind === 'passkey' && !owner)}>Register passkey</button>
    </form>
    <LoadState {...resource} /><CommandNotice command={command} />
    {!owner ? <p>Sign in to list passkeys and create recovery codes.</p> : null}
    {resource.value ? <>
      <ul className="vault-list">{resource.value.passkeys.map((passkey) => <li key={passkey.id}>
        <strong>{passkey.name}</strong> <span className="vault-badge">{passkey.revokedAt ? 'revoked' : 'active'}</span>
        <Metadata entries={[
          ['Created', dateLabel(passkey.createdAt)], ['Last used', passkey.lastUsedAt ? dateLabel(passkey.lastUsedAt) : 'Never'],
          ['Backup', passkey.backedUp ? 'Backed up' : 'Device bound'], ['Transports', passkey.transports.join(', ')],
        ]} />
        {!passkey.revokedAt ? <button type="button" disabled={readOnly || command.busy || (active === 1 && !confirmLast)}
          onClick={() => void command.run(() => port.passkeyRevoke(passkey.id, active === 1 && confirmLast), () => {
            command.setNotice('Passkey revoked.'); resource.reload(); onStatusChange();
          })}>Revoke {passkey.name}</button> : null}
      </li>)}</ul>
      {active === 1 ? <label><input type="checkbox" checked={confirmLast}
        onChange={(event) => setConfirmLast(event.target.checked)} /> I understand this revokes my last passkey</label> : null}
      {resource.value.passkeys.length === 0 ? <p>No passkeys registered.</p> : null}
    </> : null}
    {owner && !codes ? <div className="vault-recovery">
      <p>New recovery codes replace all unused codes. Save them when shown; they cannot be reopened.</p>
      <button type="button" disabled={readOnly || command.busy} onClick={() => void command.run(
        () => port.recoveryCodesCreate(), (result) => setCodes(result.codes),
      )}>Create recovery codes</button>
    </div> : null}
    {codes ? <RecoveryCodes codes={codes} onClose={() => setCodes(null)} /> : null}
  </section>;
}

function RecoveryCodes({ codes, onClose }: { codes: string[]; onClose(): void }) {
  const command = useVaultCommand();
  return <section className="vault-warning" role="region" aria-label="Recovery codes shown once"
    onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
    <h4>Save your recovery codes now</h4><p>Shown once. Closing this panel removes them from this page.</p>
    <ol>{codes.map((code, index) => <li key={index}><code>{code}</code></li>)}</ol>
    <div className="vault-actions">
      <button type="button" disabled={command.busy} onClick={() => void command.run(async () => {
        await navigator.clipboard.writeText(codes.join('\n'));
      }, () => command.setNotice('Recovery codes copied.'))}>Copy recovery codes</button>
      <button type="button" onClick={onClose}>Close recovery codes</button>
    </div><CommandNotice command={command} />
  </section>;
}
