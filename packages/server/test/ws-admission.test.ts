import type { IncomingMessage } from 'node:http';

import { describe, expect, it } from 'vitest';

import { WsAdmissionController, wsClientKey } from '../src/http/ws-admission.js';

describe('WebSocket admission limits', () => {
  it('limits upgrade attempts per client and resets the bounded window', () => {
    let now = 1_000;
    const controller = new WsAdmissionController(
      { maxUpgradeAttempts: 2, upgradeWindowMs: 1_000 },
      () => now,
    );
    expect(controller.preflight('client')).toBeUndefined();
    expect(controller.preflight('client')).toBeUndefined();
    expect(controller.preflight('client')).toEqual({ status: 429, message: 'upgrade refused' });
    now += 1_001;
    expect(controller.preflight('client')).toBeUndefined();
  });

  it('caps total, per-client and per-identity leases and releases idempotently', () => {
    const controller = new WsAdmissionController({
      maxConnections: 2,
      maxConnectionsPerClient: 1,
      maxConnectionsPerIdentity: 1,
    });
    const first = controller.admit('client-a', 'identity-a');
    expect('ok' in first).toBe(true);
    expect(controller.admit('client-a', 'identity-b')).toEqual({
      status: 429,
      message: 'upgrade refused',
    });
    expect(controller.admit('client-b', 'identity-a')).toEqual({
      status: 429,
      message: 'upgrade refused',
    });
    const second = controller.admit('client-b', 'identity-b');
    expect('ok' in second).toBe(true);
    expect(controller.admit('client-c', 'identity-c')).toEqual({
      status: 503,
      message: 'upgrade refused',
    });
    if ('ok' in first) {
      first.release();
      first.release();
    }
    expect(controller.connectionCount()).toBe(1);
    expect('ok' in controller.admit('client-c', 'identity-c')).toBe(true);
  });

  it('uses X-Real-IP only behind the actual loopback proxy peer', () => {
    const request = (remoteAddress: string, realIp: string) => ({
      socket: { remoteAddress },
      headers: { 'x-real-ip': realIp },
    }) as unknown as IncomingMessage;
    expect(wsClientKey(request('127.0.0.1', '203.0.113.7'))).toBe('203.0.113.7');
    expect(wsClientKey(request('198.51.100.4', '203.0.113.7'))).toBe('198.51.100.4');
    expect(wsClientKey(request('127.0.0.1', 'not-an-ip'))).toBe('127.0.0.1');
  });
});
