// @vitest-environment jsdom
/**
 * Settings → Secure vault (./VaultSettingsSection.tsx) over the cookie-only
 * transport: the off state a node with TM8_VAULT_MODE=off shows, the space
 * header every call carries, and a space switch that leaves nothing behind.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { VaultStatus } from '@tm8/contract';

import type { VaultFetch } from './transport';
import { VaultSettingsSection } from './VaultSettingsSection';

const SPACE_A = '0b3c2f0e-3d7c-4a4e-9a51-1f7a1c1c1c1c';
const SPACE_B = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';

afterEach(() => { cleanup(); });

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const status: VaultStatus = {
  mode: 'pre_review', reviewGate: 'open', testSecretsOnly: true, broker: 'ok', audit: 'ok',
  kms: { kind: 'local-dev', productionGrade: false },
  features: { capture: true, fill: true, callApi: true, spend: false, import: false, grants: true },
  viewer: { passkeys: 1, recoveryCodesRemaining: 10, vaultSession: null },
};

interface Seen { url: string; space: string | undefined }

/** Answers per space; a space with no answer never answers. */
function relay(answers: Record<string, (url: string) => Response | Promise<Response>>): { fetch: VaultFetch; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: (url, init) => {
      const space = (init.headers as Record<string, string>)['x-tm8-vault-space'];
      seen.push({ url, space });
      const answer = space === undefined ? undefined : answers[space];
      return answer ? Promise.resolve(answer(url)) : new Promise<Response>(() => {});
    },
  };
}

const vaultOff = () => json(503, { error: { code: 'upstream_unavailable', message: 'vault: vault_disabled', details: { reason: 'vault_disabled' }, retryable: true } });

const vaultOn = (url: string) => url === '/v2/vault/status'
  ? json(200, { data: status, requestId: 'r' })
  : url.startsWith('/v2/vault/items')
    ? json(200, { data: { items: [], nextCursor: null }, requestId: 'r' })
    : json(404, { error: { code: 'not_found', message: 'vault: not_found' } });

describe('Settings: Secure vault', () => {
  it('on a node with the vault off, says so under the section heading', async () => {
    const { fetch, seen } = relay({ [SPACE_A]: vaultOff });
    render(<VaultSettingsSection spaceId={SPACE_A} fetch={fetch} />);
    expect(screen.getByText('Secure vault')).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toBe('The vault is switched off.');
    expect(seen).toEqual([{ url: '/v2/vault/status', space: SPACE_A }]);
  });

  it('sends the active space lowercased, and on a switch remounts with nothing from the space it left', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { fetch, seen } = relay({ [SPACE_A]: vaultOn, [SPACE_B]: (url) => gate.then(() => vaultOn(url)) });
    const view = render(<VaultSettingsSection spaceId={SPACE_A.toUpperCase()} fetch={fetch} />);
    await screen.findByText(/Mode: pre_review/);
    fireEvent.click(screen.getByRole('button', { name: 'Approvals', exact: true }));
    expect(screen.getByRole('button', { name: 'Approvals', exact: true }).getAttribute('aria-current')).toBe('page');
    expect(seen.every(({ space }) => space === SPACE_A)).toBe(true);

    view.rerender(<VaultSettingsSection spaceId={SPACE_B} fetch={fetch} />);
    await waitFor(() => expect(seen.at(-1)).toEqual({ url: '/v2/vault/status', space: SPACE_B }));
    expect(screen.queryByText(/Mode: pre_review/)).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Reading vault metadata…');

    const before = seen.length;
    release();
    await screen.findByText(/Mode: pre_review/);
    // A fresh mount: the screen chosen in the other space is not kept.
    expect(screen.getByRole('button', { name: 'Items', exact: true }).getAttribute('aria-current')).toBe('page');
    expect(seen.slice(before).every(({ space }) => space === SPACE_B)).toBe(true);
  });

  it('refuses a space id the vault does not accept, without a request', () => {
    const { fetch, seen } = relay({});
    render(<VaultSettingsSection spaceId="not-a-space" fetch={fetch} />);
    expect(screen.getByTestId('vault-settings-absent')).toBeTruthy();
    expect(seen).toEqual([]);
  });
});
