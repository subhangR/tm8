import { useCallback, useState } from 'react';
import type { VaultApprovalView } from '@tm8/contract';
import { vaultError } from './errors';
import {
  CommandNotice, LoadState, Metadata, PageControls, actorLabel, dateLabel, hasOwnerSession,
  useVaultCommand, useVaultNow, useVaultResource, type SurfaceProps,
} from './ui';

export function ApprovalsPanel(props: SurfaceProps) {
  const { port } = props;
  const [selected, setSelected] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string>();
  const load = useCallback(() => port.approvalsList(cursor ? { cursor } : {}), [port, cursor]);
  const resource = useVaultResource(load);
  if (selected) return <ApprovalDetail {...props} approvalId={selected} onBack={() => { setSelected(null); resource.reload(); }} />;
  return <section aria-labelledby="vault-approvals-title">
    <h3 id="vault-approvals-title">Approvals inbox</h3>
    <button type="button" onClick={resource.reload}>Refresh approvals</button><LoadState {...resource} />
    {resource.value ? <>
      <ul className="vault-list">{resource.value.approvals.map((approval) => <li key={approval.id}>
        <button type="button" onClick={() => setSelected(approval.id)}>Review {approval.itemName}</button>
        <ApprovalMetadata approval={approval} />
      </li>)}</ul>
      {resource.value.approvals.length === 0 ? <p>No approvals.</p> : null}
      <PageControls cursor={cursor} next={resource.value.nextCursor} onCursor={setCursor} />
    </> : null}
  </section>;
}

function ApprovalMetadata({ approval }: { approval: VaultApprovalView }) {
  const now = useVaultNow();
  const state = approval.state === 'pending' && Date.parse(approval.expiresAt) <= now ? 'expired' : approval.state;
  const exactOrigin = approval.boundParams.origin;
  return <>
    <div className="vault-row-heading"><strong>{approval.kind}</strong><span className="vault-badge">{state}</span>
      {approval.oneUse ? <span className="vault-badge">one-use</span> : null}</div>
    {approval.kind === 'new_origin' ? <div className="vault-warning" role={approval.lookalike.length ? 'alert' : 'note'}>
      <p><strong>Exact requested origin: {typeof exactOrigin === 'string' ? exactOrigin : 'Unavailable'}</strong></p>
      {approval.lookalike.length ? <>
        <strong>Lookalike warning — verify this destination carefully.</strong>
        <ul>{approval.lookalike.map((finding, index) => <li key={index}>
          {finding.kind.replace(/_/g, ' ')}{finding.similarTo ? `: resembles ${finding.similarTo}` : ''}
        </li>)}</ul>
      </> : <p>No lookalike finding was reported. Check the exact origin before approving.</p>}
    </div> : null}
    <Metadata entries={[
      ['Item', approval.itemName], ['Item ID', approval.itemId], ['Requesting actor', actorLabel(approval.requestedBy)],
      ['Actor kind', approval.requestedBy.kind], ['Requesting member', approval.requestedBy.memberId], ['Actor session', approval.requestedBy.sessionId],
      ['Purpose', approval.purpose], ['Expires', dateLabel(approval.expiresAt)],
      ['Decision', approval.decidedAt ? dateLabel(approval.decidedAt) : 'Not decided'],
      ['Decided by', approval.decidedBy ? actorLabel(approval.decidedBy) : null],
      ['Consumed', approval.consumedAt ? dateLabel(approval.consumedAt) : 'Not consumed'],
      ...Object.entries(approval.boundParams).map(([key, value]): [string, React.ReactNode] =>
        [`Bound ${key}`, Array.isArray(value) ? value.join(', ') : String(value)]),
    ]} />
    {approval.spend ? <div className="vault-warning"><h4>Payment request</h4><Metadata entries={[
      ['Merchant', approval.spend.merchant], ['Exact amount', `${approval.spend.amountMinor} minor units ${approval.spend.currency}`],
      ['Item summary', approval.spend.itemSummary], ['Instrument', approval.spend.instrumentTier],
    ]} /><strong>Payments are off. This request cannot be approved here.</strong></div> : null}
  </>;
}

function ApprovalDetail({ port, status, readOnly, approvalId, onBack }: SurfaceProps & { approvalId: string; onBack(): void }) {
  const load = useCallback(() => port.approvalGet(approvalId), [port, approvalId]);
  const resource = useVaultResource(load);
  const command = useVaultCommand();
  const [standing, setStanding] = useState(false);
  const [decided, setDecided] = useState<VaultApprovalView | null>(null);
  const now = useVaultNow();
  const approval = decided ?? resource.value;
  const pending = approval?.state === 'pending' && Date.parse(approval.expiresAt) > now;
  const disabled = readOnly || command.busy || !hasOwnerSession(status, now);
  function decide(decision: 'approve' | 'deny') {
    if (!approval || !pending) return;
    void command.run(async () => {
      try { return await port.approvalDecide(approval.id, approval.intentHash, decision, standing); }
      catch (failure) {
        if (vaultError(failure).code === 'approval_not_pending') resource.reload();
        throw failure;
      }
    }, (result) => {
      setDecided(result); command.setNotice(decision === 'deny' ? 'Approval denied.' : 'Approval approved.');
    });
  }
  return <section aria-label="Approval details">
    <button type="button" onClick={onBack}>Back to approvals</button><h3>Approval details</h3>
    <LoadState {...resource} /><CommandNotice command={command} />
    {approval ? <>
      <ApprovalMetadata approval={approval} />
      {pending ? <>
        {approval.kind === 'new_origin' ? <label><input type="checkbox" checked={standing} disabled={disabled}
          onChange={(event) => setStanding(event.target.checked)} /> Add this exact origin permanently (standing approval)</label> : null}
        <div className="vault-actions">
          {approval.kind !== 'spend' ? <button type="button" disabled={disabled}
            onClick={() => decide('approve')}>Approve with passkey</button> : null}
          <button type="button" disabled={disabled} onClick={() => decide('deny')}>Deny</button>
        </div>
      </> : <p className="vault-warning">This approval is {approval.state === 'pending' ? 'expired' : approval.state}. It cannot be decided again.</p>}
    </> : null}
  </section>;
}
