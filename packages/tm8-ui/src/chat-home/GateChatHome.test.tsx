// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { GateApp } from '../views/GateApp';
import { resetNav } from '../stores/navStore';

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    },
  });
  resetNav();
  /* The URL is state now, and jsdom keeps ONE `window.location` per file. A
     case that navigates leaves its address behind and the next case boots from
     it, because an addressable hash at boot deliberately outranks last-place
     (R3) — so `resetNav()` alone stopped being a reset the day the router was
     mounted. Same class as the localStorage doubles these files already carry,
     one global later. */
  window.location.hash = '';
});

describe('dashboard route', () => {
  it('mounts the merged single home — chat hero inside the HomePage canvas', async () => {
    const view = render(<GateApp />);
    const rail = await waitFor(() => view.getByTestId('menu-rail'));
    // Revision 11: the row reads "Home" (the ref stays `dashboard`).
    fireEvent.click(within(rail).getByRole('button', { name: /^Home$/ }));

    // The merged canvas hosts the chat surface as its hero. The old T5-1
    // triage dashboard stays unmounted.
    expect(await view.findByTestId('home-page')).toBeTruthy();
    expect(await view.findByTestId('chat-home-screen')).toBeTruthy();
    expect(view.queryByTestId('home-screen')).toBeNull();
    expect(await view.findAllByText('Plan the launch sequence')).toHaveLength(2);
    fireEvent.click(view.getByRole('button', { name: /^New$/ }));
    expect(await view.findByText('What should we work on?')).toBeTruthy();
  });
});
