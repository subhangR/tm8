import { useCallback, useState, type FormEvent } from 'react';
import type { VaultItemDetail } from '@tm8/contract';
import {
  CommandNotice, GenericModeNotice, LoadState, Metadata, dateLabel, hasOwnerSession, useVaultCommand, useVaultResource, type SurfaceProps,
} from './ui';

export function GrantsPanel({ port, status, readOnly, item }: SurfaceProps & { item: VaultItemDetail }) {
  const load = useCallback(() => port.grantsList(item.id), [port, item.id]);
  const resource = useVaultResource(load);
  const command = useVaultCommand();
  const [kind, setKind] = useState<'member' | 'space'>('member');
  const [granteeId, setGranteeId] = useState('');
  const [origins, setOrigins] = useState<string[]>([]);
  const [hosts, setHosts] = useState<string[]>([]);
  const [approvalPerUse, setApprovalPerUse] = useState(true);
  const [expiry, setExpiry] = useState('');
  const disabled = readOnly || command.busy || !hasOwnerSession(status);

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void command.run(() => port.grantCreate(item.id, {
      grantee: { kind, id: granteeId },
      constraints: { origins, hosts, requireApprovalPerUse: approvalPerUse },
      expiresAt: new Date(expiry).toISOString(),
    }), () => { command.setNotice('Use-only grant created.'); resource.reload(); });
  }

  return <section aria-label="Item grants">
    <h4>Use-only grants</h4><p>Recipients can use the listed origins and API hosts under these constraints.</p>
    <LoadState {...resource} /><CommandNotice command={command} />
    {resource.value ? <ul className="vault-list">{resource.value.grants.map((grant) => <li key={grant.id}>
      <strong>{grant.grantee.name ?? grant.grantee.id}</strong> <span className="vault-badge">use-only</span>
      <Metadata entries={[
        ['Recipient', grant.grantee.kind], ['Origins', grant.constraints.origins?.join(', ') ?? 'All item origins'],
        ['API hosts', grant.constraints.hosts?.join(', ') ?? 'All policy hosts'],
        ['Approval per use', grant.constraints.requireApprovalPerUse ? 'Required' : 'Not required'],
        ['Expires', grant.expiresAt ? dateLabel(grant.expiresAt) : 'No expiry'],
        ['State', grant.revokedAt ? 'revoked' : grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now() ? 'expired' : 'active'],
      ]} />
      {!grant.revokedAt ? <button type="button" disabled={disabled} onClick={() => void command.run(
        () => port.grantRevoke(grant.id), () => {
          command.setNotice('Grant revoked, effective within 5 s. A use already in progress may complete.'); resource.reload();
        },
      )}>Revoke grant to {grant.grantee.name ?? grant.grantee.id}</button> : null}
    </li>)}</ul> : null}
    {resource.value?.grants.length === 0 ? <p>No grants for this item.</p> : null}
    {item.access === 'owner' && item.state !== 'tombstoned' && status.features.grants ? <form className="vault-form" onSubmit={create}>
      <h4>Create a use-only grant</h4>
      <label>Recipient type<select value={kind} onChange={(event) => setKind(event.target.value as 'member' | 'space')}>
        <option value="member">Member</option><option value="space">Space</option></select></label>
      <label>Recipient ID<input required pattern="[0-9a-fA-F-]{36}" value={granteeId}
        onChange={(event) => setGranteeId(event.target.value)} /></label>
      <fieldset><legend>Allowed exact origins</legend>{item.origins.length ? item.origins.map((origin) =>
        <label key={origin}><input type="checkbox" checked={origins.includes(origin)} onChange={(event) => setOrigins(
          event.target.checked ? [...origins, origin] : origins.filter((value) => value !== origin),
        )} />{origin}</label>) : <p>No bound origins.</p>}</fieldset>
      <fieldset><legend>Allowed API hosts</legend>
        {item.policy?.mode === 'generic' ? <GenericModeNotice keyInUrl={item.policy.injection.kind === 'query'} /> : null}
        {item.policy?.hosts.length ? item.policy.hosts.map((host) =>
        <label key={host}><input type="checkbox" checked={hosts.includes(host)} onChange={(event) => setHosts(
          event.target.checked ? [...hosts, host] : hosts.filter((value) => value !== host),
        )} />{host}</label>) : <p>No API policy hosts.</p>}</fieldset>
      <label><input type="checkbox" checked={approvalPerUse} onChange={(event) => setApprovalPerUse(event.target.checked)} />Require approval per use</label>
      <label>Grant expiry<input type="datetime-local" required value={expiry} onChange={(event) => setExpiry(event.target.value)} /></label>
      <button type="submit" disabled={disabled || (origins.length === 0 && hosts.length === 0)}>Create grant with passkey</button>
    </form> : null}
  </section>;
}
