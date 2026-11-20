import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { VaultMaskedScreenshotSchema, type VaultOutput } from '@tm8/contract';
import {
  CommandNotice, ErrorNotice, LoadState, Metadata, PageControls, actorLabel, dateLabel, hasOwnerSession,
  useVaultCommand, useVaultResource, type SurfaceProps,
} from './ui';

export function SessionsPanel({ port, status, readOnly, onStatusChange }: SurfaceProps) {
  const load = useCallback(() => port.sessionsList(), [port]);
  const resource = useVaultResource(load);
  const command = useVaultCommand();
  return <section aria-labelledby="vault-sessions-title">
    <h3 id="vault-sessions-title">Vault sessions</h3><p>Revoking a vault session ends that device’s vault access.</p>
    <button type="button" onClick={resource.reload}>Refresh sessions</button><LoadState {...resource} /><CommandNotice command={command} />
    {resource.value ? <ul className="vault-list">{resource.value.sessions.map((session) => <li key={session.id}>
      <strong>{session.deviceLabel ?? 'Unnamed device'}</strong> {session.current ? <span className="vault-badge">this session</span> : null}
      <Metadata entries={[
        ['State', session.revokedAt ? 'revoked' : Date.parse(session.expiresAt) <= Date.now() ? 'expired' : 'active'],
        ['Created', dateLabel(session.createdAt)], ['Last used', dateLabel(session.lastUsedAt)],
        ['Expires', dateLabel(session.expiresAt)], ['Refresh family expires', dateLabel(session.refreshExpiresAt)],
      ]} />
      {!session.revokedAt ? <button type="button" disabled={readOnly || command.busy || !hasOwnerSession(status)}
        onClick={() => void command.run(() => port.sessionRevoke(session.id), () => {
          command.setNotice('Vault session revoked.'); resource.reload(); onStatusChange();
        })}>Revoke session {session.deviceLabel ?? session.id}</button> : null}
    </li>)}</ul> : null}
    {resource.value?.sessions.length === 0 ? <p>No vault sessions.</p> : null}
  </section>;
}

export function AuditPanel({ port, onChainStatus }: SurfaceProps & { onChainStatus(broken: boolean): void }) {
  const [cursor, setCursor] = useState<string>();
  const load = useCallback(async () => {
    const [feed, verification] = await Promise.all([port.auditList(cursor ? { cursor } : {}), port.auditVerify()]);
    return { feed, verification };
  }, [port, cursor]);
  const resource = useVaultResource(load);
  const broken = resource.value?.verification.status === 'broken' || resource.value?.feed.chain.status === 'broken';
  useEffect(() => { if (resource.value) onChainStatus(broken); }, [resource.value, broken, onChainStatus]);
  return <section aria-labelledby="vault-audit-title">
    <h3 id="vault-audit-title">Audit</h3><p>Import commits and item activity appear here as metadata.</p>
    <button type="button" onClick={resource.reload}>Verify audit chain</button><LoadState {...resource} />
    {resource.value ? <>
      {broken ? <div className="vault-alarm" role="alert"><h4>Audit chain broken</h4>
        <p>Vault writes are locked. Contact the vault operator to investigate the integrity failure.</p>
        <p>First broken sequence: {resource.value.verification.firstBrokenSeq ?? 'unavailable'}</p>
      </div> : <p className={resource.value.verification.status === 'verified' ? 'vault-success' : 'vault-warning'}>
        Chain {resource.value.verification.status}; feed {resource.value.feed.chain.status}.
      </p>}
      <Metadata entries={[
        ['Checked through sequence', resource.value.verification.checkedThroughSeq],
        ['Head hash', resource.value.verification.headHash],
        ['Checkpoint', resource.value.verification.checkpoint
          ? `${resource.value.verification.checkpoint.sink}: ${resource.value.verification.checkpoint.anchored ? 'anchored' : 'not anchored'}`
          : 'No independent checkpoint is available'],
      ]} />
      <ol className="vault-list">{resource.value.feed.events.map((event) => <li key={event.seq}>
        <strong>{event.action}</strong><Metadata entries={[
          ['Sequence', event.seq], ['At', dateLabel(event.at)], ['Actor', actorLabel(event.actor)], ['Item', event.itemId],
          ...Object.entries(event.params).map(([key, value]): [string, React.ReactNode] =>
            [key, Array.isArray(value) ? value.join(', ') : String(value)]),
        ]} />
      </li>)}</ol>
      {resource.value.feed.events.length === 0 ? <p>No audit events.</p> : null}
      <PageControls cursor={cursor} next={resource.value.feed.nextCursor} onCursor={setCursor} />
    </> : null}
  </section>;
}

/** PNG signature is checked independently of the declared MIME type. */
export function MaskedScreenshot({ screenshot }: { screenshot: unknown }) {
  const parsed = VaultMaskedScreenshotSchema.safeParse(screenshot);
  let valid = parsed.success;
  if (parsed.success) {
    try {
      const bytes = atob(parsed.data.dataBase64);
      const signature = [137, 80, 78, 71, 13, 10, 26, 10];
      valid = bytes.length >= 8 && signature.every((byte, index) => bytes.charCodeAt(index) === byte);
    } catch { valid = false; }
  }
  if (!valid || !parsed.success) return <ErrorNotice message="The masked screenshot was refused: invalid PNG." />;
  return <figure className="vault-screenshot">
    <img src={`data:image/png;base64,${parsed.data.dataBase64}`} width={parsed.data.width} height={parsed.data.height}
      alt="Masked operation screenshot" />
    <figcaption>{parsed.data.maskedRegions} masked regions</figcaption>
  </figure>;
}

export function OperationsPanel({ port }: SurfaceProps) {
  const [operationId, setOperationId] = useState('');
  const [operation, setOperation] = useState<VaultOutput<'vault.operations.get'> | null>(null);
  const command = useVaultCommand();
  function read(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setOperation(null);
    void command.run(() => port.operationGet(operationId), setOperation);
  }
  return <section aria-labelledby="vault-operations-title">
    <h3 id="vault-operations-title">Operation outcome</h3><p>Read an existing operation’s recorded result.</p>
    <form className="vault-form" onSubmit={read}>
      <label>Operation ID<input required pattern="[0-9a-fA-F-]{36}" value={operationId} onChange={(event) => setOperationId(event.target.value)} /></label>
      <button type="submit" disabled={command.busy}>Read operation</button>
    </form><CommandNotice command={command} />
    {operation ? <div aria-label="Recorded operation outcome">
      <Metadata entries={[
        ['Kind', operation.kind], ['State', operation.state], ['Item', operation.itemId],
        ['Created', dateLabel(operation.createdAt)],
      ]} />
      {operation.result && 'code' in operation.result ? <p className="vault-warning">Operation refused: {operation.result.code}</p> : null}
      {operation.kind === 'fill' && operation.result && 'screenshot' in operation.result && operation.result.screenshot
        ? <MaskedScreenshot screenshot={operation.result.screenshot} /> : null}
      {operation.state === 'unknown' ? <p className="vault-warning">Outcome unknown. The broker must reconcile it before retry.</p> : null}
    </div> : null}
  </section>;
}
