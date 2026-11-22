/**
 * Settings → Secure vault (task 01a1fa87, WS-A): the vault screens
 * (`src/vault`, WS-E) on a port built over this node's relay with the
 * cookie-only transport (./transport.ts).
 *
 * KEYED ON THE SPACE. A space switch builds a new port and remounts the
 * screens, so nothing read in one space is still on screen in the next.
 * The port reads its space once (`createVaultPort`), so reusing one across a
 * switch would act in the old space.
 */
import { useMemo } from 'react';

import { SectionAbsent, SectionFrame } from '../settings-space/SectionFrame';
import { VaultSection, createVaultPort, type VaultAuthenticator } from '../vault';
import { createVaultTransport, type VaultFetch } from './transport';

export interface VaultSettingsSectionProps {
  /** The active space. */
  spaceId: string;
  heading?: string;
  /** Tests only. */
  fetch?: VaultFetch;
  /** Tests only. */
  authenticator?: VaultAuthenticator;
}

export function VaultSettingsSection({ spaceId, heading = 'Secure vault', fetch, authenticator }: VaultSettingsSectionProps) {
  const port = useMemo(() => {
    try {
      return createVaultPort(
        createVaultTransport({ spaceId: spaceId.toLowerCase(), ...(fetch ? { fetch } : {}) }),
        authenticator ? { authenticator } : {},
      );
    } catch {
      return null;
    }
  }, [spaceId, fetch, authenticator]);
  return (
    <SectionFrame title={heading} measure={false}>
      {port
        ? <VaultSection key={spaceId} port={port} heading="Vault status" />
        : <SectionAbsent head="The vault cannot open in this space." why="The space id is not one the vault accepts." testId="vault-settings-absent" />}
    </SectionFrame>
  );
}
