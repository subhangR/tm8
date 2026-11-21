// @vitest-environment jsdom
/**
 * The shell shows Secure Vault's paste warning: views/GateApp.tsx registers vault/paste-warning.ts's
 * host, so a warning the seam hands over becomes a notice with the server's text, and the notice's one
 * action opens Settings → Secure vault. paste-warning.test.ts covers the seam half.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { VAULT_PASTE_WARNING_CODE } from '@tm8/contract';
import { GateApp } from '../views/GateApp';
import { navStore, resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { createMemoryTarget } from '../routes';
import { FIXTURE_SPACE_ID } from '../fixtures';
import { PASTE_NOTICE_ACTION, PASTE_NOTICE_TITLE, surfacePasteWarning } from './paste-warning';

const MESSAGE = 'That message looked like it held a secret (a GitHub token). Treat it as exposed anyway.';
const answered = () => ({ messages: [], warnings: [{ code: VAULT_PASTE_WARNING_CODE, message: MESSAGE }] });

function installStorage(): void {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: store });
}

beforeEach(() => {
  installStorage();
  resetNav();
  screenStackStore.getState().clearAll();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the shell and the paste warning', () => {
  it('shows the server text as a notice whose action opens Settings → Secure vault', async () => {
    const view = render(<GateApp routerTarget={createMemoryTarget(`#/s/${FIXTURE_SPACE_ID}/workspace`)} />);
    // The shell re-renders its notice host while it boots, so look it up each time rather than keep one.
    const host = () => view.getByTestId('notice-host');
    await waitFor(host);

    act(() => {
      surfacePasteWarning(answered());
    });
    await waitFor(() => within(host()).getByText(MESSAGE));
    expect(within(host()).getByText(PASTE_NOTICE_TITLE)).toBeTruthy();

    fireEvent.click(within(host()).getByRole('button', { name: PASTE_NOTICE_ACTION }));
    await waitFor(() => expect(navStore.getState().view).toMatchObject({ view: 'settings', section: 'vault' }));
    expect(within(host()).queryByText(MESSAGE)).toBeNull();

    view.unmount();
    // Unmounted, the shell has left the slot: a later warning reaches nobody and breaks nothing.
    const result = answered();
    expect(surfacePasteWarning(result)).toBe(result);
  });
});
