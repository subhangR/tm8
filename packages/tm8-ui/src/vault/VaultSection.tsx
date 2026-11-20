import { useCallback, useState } from 'react';
import type { VaultPort } from './port';
import { ApprovalsPanel } from './ApprovalsPanel';
import { AuditPanel, OperationsPanel, SessionsPanel } from './ActivityPanels';
import { ItemsPanel } from './ItemsPanel';
import { PasskeysPanel, SessionControls } from './PasskeysPanel';
import { LoadState, TestSecretsNotice, hasOwnerSession, useVaultNow, useVaultResource } from './ui';
import './vault.css';

export interface VaultSectionProps { port: VaultPort; heading?: string }
const SCREENS = ['Items', 'Approvals', 'Passkeys', 'Sessions', 'Audit', 'Operations'] as const;
type Screen = typeof SCREENS[number];

/** Mount in Settings with a port created from WS-A's VaultTransport adapter. */
export function VaultSection({ port, heading = 'Secure vault' }: VaultSectionProps) {
  const load = useCallback(() => port.status(), [port]);
  const resource = useVaultResource(load);
  const [screen, setScreen] = useState<Screen>('Items');
  const [integrityAlarm, setIntegrityAlarm] = useState(false);
  const chainStatus = useCallback((broken: boolean) => setIntegrityAlarm(broken), []);
  const now = useVaultNow();
  const status = resource.value;
  const readOnly = !status || status.broker !== 'ok' || status.audit !== 'ok' || status.mode === 'off' || integrityAlarm;
  const owner = status ? hasOwnerSession(status, now) : false;
  const ownerOnly = screen === 'Sessions' || screen === 'Audit';
  const shared = status ? { port, status, readOnly, onStatusChange: resource.reload } : null;
  return <section className="vault-section" aria-label={heading}>
    <div className="vault-row-heading"><h2>{heading}</h2><button type="button" onClick={resource.reload}>Refresh vault status</button></div>
    <LoadState {...resource} />
    {status && shared ? <>
      <div className="vault-status" aria-label="Vault status">
        <p><strong>Mode: {status.mode}</strong> · Broker: {status.broker} · Audit: {status.audit}</p>
        <TestSecretsNotice status={status} />
        {!status.features.spend ? <p><strong>Payments are off.</strong></p> : null}
        {readOnly ? <p className="vault-alarm" role="alert"><strong>Read-only:</strong> {integrityAlarm
          ? 'Audit integrity failed. Vault writes are locked.' : 'The broker or audit service is unavailable, or the vault is off.'}</p> : null}
      </div>
      <SessionControls {...shared} />
      <nav className="vault-navigation" aria-label="Vault screens">{SCREENS.map((name) => <button key={name} type="button"
        aria-current={screen === name ? 'page' : undefined} onClick={() => setScreen(name)}>{name}</button>)}</nav>
      <div key={`${status.viewer.vaultSession?.sessionId ?? 'guest'}-${owner ? 'active' : 'expired'}-${screen}`} className="vault-surface">
        {ownerOnly && !owner ? <p>Sign in with a passkey to open this screen.</p> : <>
          {screen === 'Items' ? <ItemsPanel {...shared} /> : null}
          {screen === 'Approvals' ? <ApprovalsPanel {...shared} /> : null}
          {screen === 'Passkeys' ? <PasskeysPanel {...shared} /> : null}
          {screen === 'Sessions' ? <SessionsPanel {...shared} /> : null}
          {screen === 'Audit' ? <AuditPanel {...shared} onChainStatus={chainStatus} /> : null}
          {screen === 'Operations' ? <OperationsPanel {...shared} /> : null}
        </>}
      </div>
    </> : null}
  </section>;
}
