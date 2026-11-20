import { useCallback, useState } from 'react';
import { VAULT_ITEM_TYPES, type VaultItemView, type VaultItemType } from '@tm8/contract';
import { openVaultCapture, openVaultImport } from './links';
import { GrantsPanel } from './GrantsPanel';
import {
  CommandNotice, LoadState, Metadata, PageControls, TestSecretsNotice, actorLabel, dateLabel,
  hasOwnerSession, useVaultCommand, useVaultResource, type SurfaceProps,
} from './ui';

export function ItemsPanel(props: SurfaceProps) {
  const { port, status, readOnly } = props;
  const [selected, setSelected] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string>();
  const [itemType, setItemType] = useState<VaultItemType>('login');
  const load = useCallback(() => port.itemsList(cursor ? { cursor } : {}), [port, cursor]);
  const resource = useVaultResource(load);
  const command = useVaultCommand();
  if (selected) return <ItemDetailPanel {...props} itemId={selected} onBack={() => setSelected(null)} />;
  return <section aria-labelledby="vault-items-title">
    <h3 id="vault-items-title">Items</h3><TestSecretsNotice status={status} />
    <p>Capture and import open in the standalone secure page. Item values stay outside this app.</p>
    <div className="vault-actions">
      <label>New item type<select value={itemType} onChange={(event) => setItemType(event.target.value as VaultItemType)}>
        {VAULT_ITEM_TYPES.map((type) => <option key={type} value={type}>{type.replace('_', ' ')}</option>)}
      </select></label>
      <button type="button" disabled={readOnly || command.busy || !status.features.capture} onClick={() => void command.run(
        () => port.captureLinkCreate({ itemType, purpose: 'create' }), openVaultCapture,
      )}>New item</button>
      <button type="button" disabled={readOnly || !hasOwnerSession(status) || !status.features.import || status.reviewGate === 'open'}
        onClick={openVaultImport}>Import</button>
      <button type="button" onClick={resource.reload}>Refresh items</button>
    </div>
    {!status.features.import || status.reviewGate === 'open' ? <p>Import is disabled until the review gate passes and import is enabled.</p> : null}
    <CommandNotice command={command} /><LoadState {...resource} />
    {resource.value ? <>
      <ul className="vault-list">{resource.value.items.map((item) => <li key={item.id}>
        <div className="vault-row-heading"><button type="button" className="vault-item-link" onClick={() => setSelected(item.id)}>{item.name}</button>
          <span className="vault-badge">{item.state}</span></div>
        <ItemMetadata item={item} compact />
      </li>)}</ul>
      {resource.value.items.length === 0 ? <p>No vault items.</p> : null}
      <PageControls cursor={cursor} next={resource.value.nextCursor} onCursor={setCursor} />
    </> : null}
  </section>;
}

export function ItemMetadata({ item, compact = false }: { item: VaultItemView; compact?: boolean }) {
  const entries: [string, React.ReactNode][] = [
    ['Type', item.type], ['State', item.state], ['Exposure tier', item.exposureTier ?? 'Unspecified'],
    ['Exact bound origins', item.origins.length ? item.origins.join(', ') : 'None'],
  ];
  if (item.access === 'grant') entries.push(['Shared by', item.sharedBy?.name ?? item.sharedBy?.memberId ?? 'Owner']);
  if (!compact) entries.push(
    ['Username', item.username], ['Last four', item.last4],
    ['Card expiry', item.expMonth && item.expYear ? `${item.expMonth}/${item.expYear}` : null],
    ['Connector', item.connector], ['Dev mode', item.devMode ? 'Enabled for this item' : 'Off'],
    ['TOTP', item.hasTotp ? 'Present' : 'None'], ['Notes', item.hasNotes ? 'Present' : 'None'],
    ['Identity field names', item.fieldNames.join(', ') || 'None'], ['Created', dateLabel(item.createdAt)],
    ['Updated', dateLabel(item.updatedAt)], ['Rotated', item.rotatedAt ? dateLabel(item.rotatedAt) : 'Never'],
    ['Credential version', item.secretVersion],
  );
  return <>
    {item.state === 'blocked_until_rotated' ? <p className="vault-warning">Blocked until rotated at the source and replaced here.</p> : null}
    {item.state === 'tombstoned' ? <p>This item is deleted.</p> : null}
    <Metadata entries={entries} />
  </>;
}

function ItemDetailPanel(props: SurfaceProps & { itemId: string; onBack(): void }) {
  const { port, status, itemId, readOnly, onBack } = props;
  const load = useCallback(async () => {
    const [item, activity] = await Promise.all([port.itemGet(itemId), port.itemActivity(itemId)]);
    return { item, activity };
  }, [port, itemId]);
  const resource = useVaultResource(load);
  const command = useVaultCommand();
  const item = resource.value?.item;
  const activity = resource.value?.activity;
  return <section aria-label="Item details">
    <button type="button" onClick={onBack}>Back to items</button>
    <TestSecretsNotice status={status} /><LoadState {...resource} /><CommandNotice command={command} />
    {item && activity ? <>
      <h3>{item.name}</h3><ItemMetadata item={item} />
      {item.access === 'owner' && item.state !== 'tombstoned' ? <button type="button"
        disabled={readOnly || command.busy || !status.features.capture} onClick={() => void command.run(
          () => port.captureLinkCreate({ itemType: item.type, purpose: 'replace', itemId: item.id, name: item.name }), openVaultCapture,
        )}>Rotate</button> : null}
      <h4>Activity in the last {activity.windowDays} days</h4>
      {activity.uses.length ? <ul>{activity.uses.map((use, index) => <li key={index}>
        Used {use.fills + use.apiCalls} times in the last {activity.windowDays} days by {actorLabel(use.actor)}
        {' '}on {[...use.origins, ...use.hosts].join(', ') || 'no recorded destination'}.
      </li>)}</ul> : <p>No recent uses.</p>}
      <p>{item.pendingApprovals} pending approvals · {item.activeGrants} active grants</p>
      {hasOwnerSession(status) && item.access === 'owner' ? <GrantsPanel {...props} item={item} /> : null}
    </> : null}
  </section>;
}
