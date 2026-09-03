// @vitest-environment jsdom
/**
 * The version switch says what is true about the OTHER UI.
 *
 * The control's whole job is to be honest about a door it does not own: the
 * 2.0 bundle is optional and an operator may not have configured one. The two
 * failures worth guarding are the ones that look like success — offering a
 * link to a bundle that is not served, and disappearing while it finds out
 * (which would also make the tab bar's controls jump under the pointer).
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UiVersionSwitch } from './UiVersionSwitch';
import { probeUi20, resetUi20Probe, UI_2_0_PATH } from './mount';

const ok = () => Promise.resolve(new Response(null, { status: 200 }));
const missing = () => Promise.resolve(new Response(null, { status: 404 }));

beforeEach(() => resetUi20Probe());
afterEach(() => {
  resetUi20Probe();
  vi.restoreAllMocks();
});

describe('UiVersionSwitch', () => {
  it('links to the 2.0 mount when the bundle is served', async () => {
    render(<UiVersionSwitch fetcher={ok as unknown as typeof fetch} />);

    const link = await screen.findByTestId('switch-to-ui-2-0');
    expect(link.getAttribute('href')).toBe(UI_2_0_PATH);
  });

  it('never opens a second copy of the app beside itself', async () => {
    render(<UiVersionSwitch fetcher={ok as unknown as typeof fetch} />);

    // Two live UIs over one catalog would put the same entity on screen twice
    // with independent event streams.
    const link = await screen.findByTestId('switch-to-ui-2-0');
    expect(link.getAttribute('target')).toBeNull();
  });

  it('refuses with a reason when the server serves no 2.0 bundle', async () => {
    render(<UiVersionSwitch fetcher={missing as unknown as typeof fetch} />);

    await waitFor(() => {
      expect(screen.getByTestId('disabled-with-reason')).toBeTruthy();
    });
    expect(screen.queryByTestId('switch-to-ui-2-0')).toBeNull();
    expect(screen.getByText(/TM8_UI_2_0_DIR/)).toBeTruthy();
  });

  it('refuses rather than vanishing while the probe is in flight', () => {
    // Deliberately never resolves: the control must already be on screen.
    render(<UiVersionSwitch fetcher={(() => new Promise(() => {})) as unknown as typeof fetch} />);

    expect(screen.getByTestId('disabled-with-reason')).toBeTruthy();
    expect(screen.getByLabelText('Switch to UI 2.0')).toBeTruthy();
  });

  it('treats a network failure as absent rather than throwing', async () => {
    render(
      <UiVersionSwitch
        fetcher={(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('disabled-with-reason')).toBeTruthy();
    });
  });
});

describe('probeUi20', () => {
  it('probes with GET — the static handler answers no other method', async () => {
    // Measured: tm8-server guards static dispatch on `method === 'GET'`, so a
    // HEAD probe 404s against a server that IS serving the bundle, and the
    // control reports it permanently unavailable.
    const fetcher = vi.fn(ok);
    await probeUi20(fetcher as unknown as typeof fetch);

    expect(fetcher.mock.calls[0]?.[1]).toEqual({ method: 'GET' });
  });

  it('probes index.html, not the directory', async () => {
    // The mounted handler answers extension-less paths with its own SPA
    // fallback, so probing `/ui-2.0/` would return 200 from the fallback even
    // against a root holding no bundle.
    const fetcher = vi.fn(ok);
    await probeUi20(fetcher as unknown as typeof fetch);

    expect(fetcher).toHaveBeenCalledWith(`${UI_2_0_PATH}index.html`, { method: 'GET' });
  });

  it('asks once per page load however many controls mount', async () => {
    const fetcher = vi.fn(ok);
    await Promise.all([
      probeUi20(fetcher as unknown as typeof fetch),
      probeUi20(fetcher as unknown as typeof fetch),
      probeUi20(fetcher as unknown as typeof fetch),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
