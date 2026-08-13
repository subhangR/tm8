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
});

describe('dashboard route', () => {
  it('mounts Chat as Home rather than the previous triage dashboard', async () => {
    const view = render(<GateApp />);
    const rail = await waitFor(() => view.getByTestId('menu-rail'));
    fireEvent.click(within(rail).getByRole('button', { name: /^Dashboard$/ }));

    expect(await view.findByTestId('chat-home-screen')).toBeTruthy();
    expect(view.queryByTestId('home-screen')).toBeNull();
    expect(await view.findAllByText('Plan the launch sequence')).toHaveLength(2);
    fireEvent.click(view.getByRole('button', { name: /^New$/ }));
    expect(await view.findByText('What should we work on?')).toBeTruthy();
  });
});
