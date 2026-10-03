import { useEffect, useState } from 'react';
import type { CredentialProviderName } from '@tm8/contract';
import { SPACE_CREDENTIAL_LABEL_MAX_LENGTH } from '@tm8/contract';
import type { CredentialsSharePort } from './port';
import { LoginTerminalPanel, type PendingLogin } from './CredentialsProviderBlock';
import { presentationOf } from './provider-presentation';

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Creates one private space credential, then grants only the selected members. */
export function ShareCredentialPanel({ provider, port, serverBaseUrl, onClose }: {
  provider: CredentialProviderName;
  port: CredentialsSharePort;
  serverBaseUrl?: string;
  onClose: () => void;
}) {
  const [spaces, setSpaces] = useState<Array<{ id: string; name: string }> | null>(null);
  const [spaceId, setSpaceId] = useState(port.currentSpaceId);
  const [members, setMembers] = useState<Array<{ id: string; name: string }> | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [label, setLabel] = useState(`My ${presentationOf(provider).name}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingLogin | null>(null);
  const [complete, setComplete] = useState(false);
  const supported = provider === 'github' || provider === 'anthropic' || provider === 'openai';

  useEffect(() => {
    if (!supported) return;
    let live = true;
    void port.spaces().then((rows) => {
      if (!live) return;
      setSpaces(rows);
      if (!rows.some((row) => row.id === port.currentSpaceId)) setSpaceId(rows[0]?.id ?? '');
    }, (err: unknown) => { if (live) setError(messageOf(err)); });
    return () => { live = false; };
  }, [port, supported]);

  useEffect(() => {
    if (!supported || !spaceId) return;
    let live = true;
    setMembers(null);
    setSelected([]);
    setMemberError(null);
    void port.members(spaceId).then((rows) => {
      if (live) setMembers(rows);
    }, (err: unknown) => { if (live) setMemberError(messageOf(err)); });
    return () => { live = false; };
  }, [port, spaceId, supported]);

  async function grant(id: string) {
    const failed: string[] = [];
    const reasons: string[] = [];
    for (const memberId of selected) {
      try { await port.share(id, memberId); }
      catch (err) {
        failed.push(memberId);
        reasons.push(`${members?.find((member) => member.id === memberId)?.name ?? memberId}: ${messageOf(err)}`);
      }
    }
    setSelected(failed);
    const spaceName = spaces?.find((space) => space.id === spaceId)?.name ?? spaceId;
    setNotice(`“${label.trim()}” is saved as your private credential in ${spaceName}.${selected.length > 0 ? ` Shared with ${selected.length - failed.length} selected member(s).` : ''}`);
    if (failed.length > 0) {
      setError(`Some members could not be added. Successful shares are saved. ${reasons.join(' ')}`);
    } else {
      setComplete(true);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (credentialId) {
        await grant(credentialId);
      } else if (provider === 'github') {
        const created = await port.addMine(spaceId, label.trim());
        setCredentialId(created.id);
        await grant(created.id);
      } else if (provider === 'anthropic' || provider === 'openai') {
        const started = await port.startPrivateLogin(spaceId, provider, label.trim());
        setCredentialId(started.spaceCredential!.id);
        setPending({ provider, workSessionId: started.workSessionId, expiresAt: started.expiresAt, command: started.command });
      }
    } catch (err) { setError(messageOf(err)); }
    finally { setBusy(false); }
  }

  async function finish() {
    if (!pending || !credentialId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await port.finishLogin(pending.workSessionId);
      setPending(null);
      if (result.spaceCredential?.id !== credentialId || result.spaceCredential.status !== 'active') {
        setError('The space sign-in did not complete. Open Space credentials to reconnect this credential before sharing it.');
        setComplete(true);
        return;
      }
      await grant(credentialId);
    } catch (err) {
      if ((err as { code?: string })?.code === 'not_found') {
        setPending(null);
        setComplete(true);
        setError('That space login has expired or closed. Open Space credentials to reconnect it.');
      } else {
        setError(messageOf(err));
      }
    }
    finally { setBusy(false); }
  }

  const locked = busy || credentialId !== null;
  return (
    <section className="cred-share" aria-label={`Share ${presentationOf(provider).name} to a space`}>
      <h3>Share to</h3>
      {!supported ? <p>Sharing {presentationOf(provider).name} to a space is not supported yet.</p> : <>
        <p>{provider === 'github'
          ? 'Save a separate private copy in a space. Select members who may launch agents with it, or leave the selection empty to keep it for yourself.'
          : 'Sign in again for a separate private credential in this space, then share it with the selected members. Your existing personal login keeps working.'}</p>
        <p className="cred-notice__why">Sharing lets these members launch agents billed to this credential. Its secret stays hidden; only its owner can open terminals using it.</p>
        <label>Space
          <select aria-label="Share to space" value={spaceId} disabled={locked || spaces === null} onChange={(event) => setSpaceId(event.target.value)}>
            {spaces?.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
          </select>
        </label>
        {spaces?.length === 0 ? <p>No spaces are available.</p> : null}
        <label>Credential name
          <input value={label} maxLength={SPACE_CREDENTIAL_LABEL_MAX_LENGTH} disabled={locked} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <fieldset disabled={locked}>
          <legend>Members (optional)</legend>
          {memberError ? <p role="alert">Could not load members: {memberError}</p> : members === null ? <p>Loading members…</p> : members.length === 0 ? <p>No other members in this space.</p> : members.map((member) => (
            <label key={member.id} className="cred-share__member">
              <input type="checkbox" checked={selected.includes(member.id)} onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, member.id] : ids.filter((id) => id !== member.id))} />
              {member.name}
            </label>
          ))}
        </fieldset>
        {pending ? <LoginTerminalPanel login={pending} serverBaseUrl={serverBaseUrl} busy={busy} onFinish={() => void finish()} lede="Sign in for the new private space credential, then finish here to share it." /> : null}
        {notice ? <p role="status">{notice}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {!complete && !pending ? <button className="cred-action cred-action--primary" type="button" disabled={busy || !label.trim() || !spaces?.some((space) => space.id === spaceId) || (members === null && !memberError)} onClick={() => void submit()}>
          {busy ? 'Saving…' : credentialId ? 'Retry sharing' : provider === 'github' ? 'Share to space' : 'Sign in to share'}
        </button> : null}
      </>}
      <button className="cred-action" type="button" disabled={busy || pending !== null} onClick={onClose}>{complete ? 'Done' : 'Close'}</button>
    </section>
  );
}
