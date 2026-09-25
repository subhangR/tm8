// @vitest-environment jsdom
/** Every real `form_deliveries` state → chip, note and door (FORMS-DESIGN §7.3). */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FormDeliveryView } from '@tm8/contract';
import { DELIVERING_GRACE_MS, deliveryStart, readDelivery } from './delivery';
import { DeliveryNote, FormsNavContext } from './parts';
import { FormsPortError } from './seam';

const d = (extra: Partial<FormDeliveryView>): FormDeliveryView => ({
  workSessionId: 'ws1', status: 'pending', spawnedSessionId: null, lastError: null, attempts: 0,
  createdAt: '2026-09-01T00:00:00.000Z', ...extra,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('readDelivery', () => {
  it.each([
    ['queued', d({}), 'queued', 'resume'],
    ['retrying (attempts)', d({ attempts: 2 }), 'retrying', 'resume'],
    ['retrying (error)', d({ lastError: 'pty busy' }), 'retrying', 'resume'],
    ['a row sent to a new session reads redelivering, even with old attempts', d({ attempts: 3, lastError: 'redelivered_from: session_deleted' }), 'redelivering', null],
    ['delivered', d({ status: 'delivered', attempts: 1 }), 'delivered', null],
    ['unverified', d({ status: 'delivered', lastError: 'delivery_unverified: no echo' }), 'unverified', null],
    ['spawned', d({ status: 'spawned', spawnedSessionId: 'ws2' }), 'spawned', null],
    ['cancelled: session_deleted', d({ status: 'cancelled', lastError: 'session_deleted' }), 'cancelled', 'new_session'],
    ['cancelled: resume_unavailable', d({ status: 'cancelled', lastError: 'resume_unavailable: exited' }), 'cancelled', 'new_session'],
    ['cancelled: spawn_failed', d({ status: 'cancelled', lastError: 'spawn_failed' }), 'cancelled', 'new_session'],
    ['cancelled: envelope refusal', d({ status: 'cancelled', lastError: 'envelope_refused: too large' }), 'cancelled', 'new_session'],
  ] as const)('%s', (_name, row, state, action) => {
    expect(readDelivery(row)).toMatchObject({ state, action });
  });

  // The grace window: only a fresh, never-attempted, error-free pending row reads "delivering".
  it.each([
    ['fresh pending → delivering, no door', d({}), 0, 'delivering', null],
    ['pending just inside the window → delivering', d({}), DELIVERING_GRACE_MS - 1, 'delivering', null],
    ['pending at the window’s end → queued', d({}), DELIVERING_GRACE_MS, 'queued', 'resume'],
    ['pending well past the window → queued', d({}), 10 * DELIVERING_GRACE_MS, 'queued', 'resume'],
    ['an unknown age → queued', d({}), null, 'queued', 'resume'],
    ['an attempted row inside the window still retries', d({ attempts: 1 }), 0, 'retrying', 'resume'],
    ['an errored row inside the window still retries', d({ lastError: 'pty busy' }), 0, 'retrying', 'resume'],
    ['a redelivery inside the window still reads redelivering', d({ lastError: 'redelivered_from: session_deleted' }), 0, 'redelivering', null],
    ['delivered inside the window', d({ status: 'delivered', attempts: 1 }), 0, 'delivered', null],
    ['cancelled inside the window', d({ status: 'cancelled', lastError: 'session_deleted' }), 0, 'cancelled', 'new_session'],
  ] as const)('%s', (_name, row, age, state, action) => {
    expect(readDelivery(row, age)).toMatchObject({ state, action });
  });

  it('a delivery starts at the later of the server’s submit and this viewer’s', () => {
    const server = Date.parse('2026-09-01T00:00:00.000Z');
    expect(deliveryStart('2026-09-01T00:00:00.000Z')).toBe(server);
    expect(deliveryStart('2026-09-01T00:00:00.000Z', server + 5_000)).toBe(server + 5_000);
    expect(deliveryStart('2026-09-01T00:00:00.000Z', server - 5_000)).toBe(server);
    expect(deliveryStart(null, server)).toBe(server);
    expect(deliveryStart(null)).toBeNull();
  });

  it('cancel reasons read as words; an unknown refusal is shown verbatim', () => {
    expect(readDelivery(d({ status: 'cancelled', lastError: 'session_deleted' })).reason).toBe('the session was deleted');
    expect(readDelivery(d({ status: 'cancelled', lastError: 'resume_unavailable: x' })).reason).toBe('the session could not be resumed');
    expect(readDelivery(d({ status: 'cancelled', lastError: 'spawn_failed' })).reason).toBe('a new session could not be started');
    expect(readDelivery(d({ status: 'cancelled', lastError: 'envelope_refused: big' })).reason).toBe('envelope_refused: big');
  });
});

describe('DeliveryNote', () => {
  it('queued: Resume now → redeliver(to=resume), then the latency note', async () => {
    const redeliver = vi.fn(async () => {});
    const settled = vi.fn();
    render(<DeliveryNote delivery={d({})} redeliver={redeliver} onSettled={settled} />);
    expect(screen.getByTestId('delivery-note').textContent).toMatch(/when the session resumes/);
    fireEvent.click(screen.getByRole('button', { name: 'Resume now' }));
    expect(await screen.findByText(/Resume requested\. Resuming can take a couple of minutes/)).toBeTruthy();
    expect(redeliver).toHaveBeenCalledWith('ws1', 'resume');
    expect(settled).toHaveBeenCalled();
  });

  it('fresh: "Delivering…" with no door and no resume text, then "Queued" + Resume now when the window runs out', () => {
    vi.useFakeTimers();
    render(<DeliveryNote delivery={d({})} since={Date.now()} redeliver={async () => {}} />);
    expect(screen.getByTestId('delivery-chip').textContent).toMatch(/^●?Delivering…$/);
    expect(screen.getByTestId('delivery-note').getAttribute('data-state')).toBe('delivering');
    expect(screen.getByTestId('delivery-note').textContent).not.toMatch(/resume/i);
    expect(screen.queryByRole('button')).toBeNull();
    act(() => { vi.advanceTimersByTime(DELIVERING_GRACE_MS); });
    expect(screen.getByTestId('delivery-chip').textContent).toBe('Queued');
    expect(screen.getByTestId('delivery-note').textContent).toMatch(/when the session resumes/);
    expect(screen.getByRole('button', { name: 'Resume now' })).toBeTruthy();
  });

  it('a row that started long ago reads "Queued" at once', () => {
    render(<DeliveryNote delivery={d({})} since={Date.now() - 2 * DELIVERING_GRACE_MS} redeliver={async () => {}} />);
    expect(screen.getByTestId('delivery-chip').textContent).toBe('Queued');
    expect(screen.getByRole('button', { name: 'Resume now' })).toBeTruthy();
  });

  it('retrying shows the attempt and the error', () => {
    render(<DeliveryNote delivery={d({ attempts: 3, lastError: 'pty busy' })} />);
    expect(screen.getByTestId('delivery-note').textContent).toMatch(/being retried \(attempt 3\): pty busy/);
    expect(screen.getByTestId('delivery-chip').textContent).toBe('Retrying');
  });

  it('unverified warns, with the reason', () => {
    render(<DeliveryNote delivery={d({ status: 'delivered', lastError: 'delivery_unverified: no echo' })} />);
    expect(screen.getByTestId('delivery-chip').textContent).toBe('Unverified');
    expect(screen.getByTestId('delivery-note').textContent).toMatch(/didn’t confirm it arrived \(delivery_unverified: no echo\)/);
  });

  it('spawned links the new session through the host', () => {
    const open = vi.fn();
    render(
      <FormsNavContext.Provider value={open}>
        <DeliveryNote delivery={d({ status: 'spawned', spawnedSessionId: 'ws2' })} />
      </FormsNavContext.Provider>,
    );
    fireEvent.click(screen.getByTestId('delivery-spawned-link'));
    expect(open).toHaveBeenCalledWith('ws2');
  });

  it('cancelled: Send to a new session → redeliver(to=new_session)', async () => {
    const redeliver = vi.fn(async () => {});
    render(<DeliveryNote delivery={d({ status: 'cancelled', lastError: 'session_deleted' })} redeliver={redeliver} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send to a new session' }));
    expect(await screen.findByText('Sent to a new session.')).toBeTruthy();
    expect(redeliver).toHaveBeenCalledWith('ws1', 'new_session');
  });

  it('a server refusal says what happened and refetches', async () => {
    const redeliver = vi.fn(async () => {
      throw new FormsPortError('delivery_refused', 'no', [], 'delivery_not_cancelled');
    });
    const settled = vi.fn();
    render(<DeliveryNote delivery={d({ status: 'cancelled', lastError: 'spawn_failed' })} redeliver={redeliver} onSettled={settled} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send to a new session' }));
    expect(await screen.findByText(/That delivery is no longer cancelled; showing the latest/)).toBeTruthy();
    expect(settled).toHaveBeenCalled();
  });

  it('without the op the door is disabled and says why', () => {
    render(<DeliveryNote delivery={d({ status: 'cancelled', lastError: 'session_deleted' })} />);
    expect((screen.getByRole('button', { name: 'Send to a new session' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/lacks forms\.responses\.redeliver/).length).toBeGreaterThan(0);
  });

  it('a pending row sent to a new session says so, with the old reason, and offers no door', () => {
    render(<DeliveryNote delivery={d({ attempts: 2, lastError: 'redelivered_from: session_deleted' })} redeliver={async () => {}} />);
    expect(screen.getByTestId('delivery-chip').textContent).toBe('Sending to new session');
    expect(screen.getByTestId('delivery-note').textContent).toMatch(/Sending to a new session \(before: the session was deleted\)/);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a redelivered row says so', () => {
    render(<DeliveryNote delivery={d({ status: 'spawned', spawnedSessionId: 'ws3', lastError: 'redelivered_from: ws1' })} />);
    expect(screen.getByTestId('delivery-note').textContent).toMatch(/Re-sent from an earlier delivery/);
  });
});
