// @vitest-environment jsdom
/**
 * Lane K — the TypeSafe (Jev) key in Settings → Agent credentials.
 *
 * What is held here: the block renders inside the credentials section, says
 * what the key is for, saves a pasted key through the port and then shows ONLY
 * its last four characters, replaces and removes it, and never renders a key
 * anywhere once saved. Each rule has a control that would go red without it.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  CredentialsServiceKeysStatusView,
  CredentialsStatusView,
  ServiceKeyView,
} from '@tm8/contract';
import { CredentialsSection } from './CredentialsSection';
import { ServiceKeysBlock, stateSentence } from './ServiceKeysBlock';
import { serviceKeysPortFromSeam, type CredentialsPort, type ServiceKeysPort } from './port';

const KEY = 'ts_live_0123456789abcdefWXYZ';

const EMPTY: ServiceKeyView = { provider: 'typesafe', connected: false, keyHint: null, updatedAt: null, nodeFallback: false };

function keysPort(initial: ServiceKeyView = EMPTY, store: 'present' | 'absent' = 'present') {
  let current = { ...initial };
  const port = {
    load: vi.fn(async (): Promise<CredentialsServiceKeysStatusView> => ({ keys: [{ ...current }], store })),
    save: vi.fn(async (_provider: 'typesafe', apiKey: string): Promise<ServiceKeyView> => {
      current = { ...current, connected: true, keyHint: apiKey.slice(-4), updatedAt: '2026-09-23T12:00:00.000Z' };
      return { ...current };
    }),
    remove: vi.fn(async (provider: 'typesafe') => {
      current = { ...current, connected: false, keyHint: null, updatedAt: null };
      return { provider, revoked: true };
    }),
  } satisfies ServiceKeysPort;
  return port;
}

const NO_PROVIDERS: CredentialsStatusView = { providers: [], gitCredentialStore: 'present' };
const credentialsPort: CredentialsPort = {
  load: async () => NO_PROVIDERS,
  disconnect: async () => { throw new Error('unused'); },
  startLogin: async () => { throw new Error('unused'); },
  finishLogin: async () => { throw new Error('unused'); },
};

describe('the TypeSafe service key block', () => {
  it('renders inside Settings → Agent credentials and says what the key is for', async () => {
    render(<CredentialsSection port={credentialsPort} serviceKeysPort={keysPort()} />);
    const body = screen.getByTestId('credentials-body');
    const card = await within(body).findByTestId('service-key-card-typesafe');
    expect(within(card).getByText('TypeSafe · Jev')).toBeTruthy();
    expect(screen.getByTestId('service-key-purpose-typesafe').textContent)
      .toMatch(/only when you press ✦ Ask Jev on a launch/);
    expect(screen.getByTestId('service-key-purpose-typesafe').textContent)
      .toMatch(/never given to an agent/);
  });

  it('is absent when the host wires no service-key port (control for the test above)', async () => {
    render(<CredentialsSection port={credentialsPort} />);
    await screen.findByTestId('credentials-body');
    expect(screen.queryByTestId('service-keys-block')).toBeNull();
  });

  it('saves a pasted key, clears the field, and shows only the last four characters', async () => {
    const port = keysPort();
    const view = render(<ServiceKeysBlock port={port} />);
    const input = await screen.findByTestId('service-key-input-typesafe') as HTMLInputElement;
    // A password field: the paste is not shown on screen either.
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');

    fireEvent.change(input, { target: { value: `  ${KEY}\n` } });
    await act(async () => { fireEvent.click(screen.getByTestId('service-key-save-typesafe')); });

    expect(port.save).toHaveBeenCalledWith('typesafe', KEY);
    expect(screen.getByTestId('service-key-state-typesafe').textContent).toBe('Your key is saved, ending in WXYZ.');
    expect(screen.getByTestId('service-key-saved-typesafe').textContent).toMatch(/next ✦ Ask Jev uses this key/);
    // The key is nowhere on the page once saved — not in text, not in a value.
    expect(screen.queryByTestId('service-key-input-typesafe')).toBeNull();
    expect(view.container.innerHTML).not.toContain(KEY.slice(0, -4));
  });

  it('replaces and removes a stored key', async () => {
    const port = keysPort({ ...EMPTY, connected: true, keyHint: 'abcd', updatedAt: '2026-09-22T00:00:00.000Z' });
    render(<ServiceKeysBlock port={port} />);
    await screen.findByText('Your key is saved, ending in abcd.');
    expect(screen.queryByTestId('service-key-input-typesafe')).toBeNull();

    fireEvent.click(screen.getByTestId('service-key-replace-typesafe'));
    fireEvent.change(screen.getByTestId('service-key-input-typesafe'), { target: { value: 'ts_new_key_9999' } });
    await act(async () => { fireEvent.click(screen.getByTestId('service-key-save-typesafe')); });
    expect(screen.getByTestId('service-key-state-typesafe').textContent).toBe('Your key is saved, ending in 9999.');

    await act(async () => { fireEvent.click(screen.getByTestId('service-key-remove-typesafe')); });
    expect(port.remove).toHaveBeenCalledWith('typesafe');
    expect(screen.getByTestId('service-key-state-typesafe').textContent).toBe('No key saved. ✦ Ask Jev is off until you add one.');
    expect(screen.getByTestId('service-key-input-typesafe')).toBeTruthy();
  });

  it('surfaces a refused save and keeps the paste for a retry', async () => {
    const port = keysPort();
    port.save.mockRejectedValueOnce(new Error('an API key contains no whitespace'));
    render(<ServiceKeysBlock port={port} />);
    const input = await screen.findByTestId('service-key-input-typesafe') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bad key here' } });
    await act(async () => { fireEvent.click(screen.getByTestId('service-key-save-typesafe')); });
    expect(screen.getByTestId('service-key-error-typesafe').textContent).toBe('an API key contains no whitespace');
    expect(screen.queryByTestId('service-key-saved-typesafe')).toBeNull();
  });

  it('says the node key is the fallback, and says unknown when the store is absent', async () => {
    expect(stateSentence({ ...EMPTY, nodeFallback: true }, 'present')).toMatch(/uses this node’s shared key/);
    const port = keysPort(EMPTY, 'absent');
    render(<ServiceKeysBlock port={port} />);
    await waitFor(() => expect(screen.getByTestId('service-key-state-typesafe').textContent)
      .toBe('Unknown: this node cannot store service keys yet.'));
    // Nothing to paste into on a node that cannot keep it.
    expect(screen.queryByTestId('service-key-input-typesafe')).toBeNull();
  });

  it('the seam adapter maps onto credentials.serviceKeys, saveServiceKey and removeServiceKey', async () => {
    const credentials = {
      serviceKeys: vi.fn(async () => ({ keys: [EMPTY], store: 'present' as const })),
      saveServiceKey: vi.fn(async () => EMPTY),
      removeServiceKey: vi.fn(async () => ({ provider: 'typesafe' as const, revoked: true })),
    };
    const port = serviceKeysPortFromSeam({ credentials } as never);
    await port.load();
    await port.save('typesafe', KEY);
    await port.remove('typesafe');
    expect(credentials.serviceKeys).toHaveBeenCalledOnce();
    expect(credentials.saveServiceKey).toHaveBeenCalledWith('typesafe', KEY);
    expect(credentials.removeServiceKey).toHaveBeenCalledWith('typesafe');
  });
});
