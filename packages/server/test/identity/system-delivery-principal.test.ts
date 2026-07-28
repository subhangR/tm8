/**
 * W0 B1 — the delivery adapter has one non-public, single-execution principal.
 *
 * These tests intentionally exercise the negative boundary first: ordinary
 * authenticated principals, public request-shaped data, and serialized copies
 * must never become a delivery principal merely by matching its object shape.
 */

import { describe, expect, it } from 'vitest';
import {
  isSystemDeliveryPrincipalFor,
  mintSystemDeliveryPrincipal,
  type SystemDeliveryPrincipalBinding,
  type SystemDeliveryPrincipalClaims,
} from '../../src/identity/index.js';

const NOW = Date.parse('2026-07-26T12:00:00.000Z');

const claims = (): SystemDeliveryPrincipalClaims => ({
  deliveryId: 'delivery-1',
  messageId: 'message-1',
  targetWorkSessionId: 'session-target-1',
  reservationVersion: 7,
  expiresAt: '2026-07-26T12:15:00.000Z',
});

const binding = (): SystemDeliveryPrincipalBinding => ({
  deliveryId: 'delivery-1',
  messageId: 'message-1',
  targetWorkSessionId: 'session-target-1',
  reservationVersion: 7,
});

describe('system delivery principal (W0 B1)', () => {
  it('accepts only an internally minted principal for its exact live reservation tuple', () => {
    const principal = mintSystemDeliveryPrincipal(claims());

    expect(isSystemDeliveryPrincipalFor(principal, binding(), NOW)).toBe(true);
    expect(principal.principalType).toBe('system_delivery_adapter');
    expect(Object.keys(principal).sort()).toEqual(['claims', 'principalType']);
    expect(Object.keys(principal.claims).sort()).toEqual([
      'deliveryId',
      'expiresAt',
      'messageId',
      'reservationVersion',
      'targetWorkSessionId',
    ]);
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal.claims)).toBe(true);
  });

  it('rejects Member, Teammate, session bearer, owner/admin, and act-as-shaped data', () => {
    const ordinaryPrincipals: unknown[] = [
      { principalType: 'member', actorId: 'member-1' },
      { principalType: 'team_member', actorId: 'teammate-1' },
      {
        principalType: 'session',
        sessionId: 'auth-session-1',
        actorId: 'teammate-1',
      },
      {
        principalType: 'member',
        actorId: 'member-owner',
        role: 'owner',
        isNodeAdmin: true,
      },
      {
        principalType: 'member',
        actorId: 'teammate-1',
        actingAsTeamMemberId: 'teammate-1',
      },
    ];

    for (const candidate of ordinaryPrincipals) {
      expect(isSystemDeliveryPrincipalFor(candidate, binding(), NOW)).toBe(false);
    }
  });

  it('rejects structurally identical records, HTTP/header/actor data, and serialized copies', () => {
    const principal = mintSystemDeliveryPrincipal(claims());
    const forged = {
      principalType: 'system_delivery_adapter',
      claims: claims(),
    };
    const publicShapes: unknown[] = [
      forged,
      JSON.parse(JSON.stringify(principal)),
      { body: forged },
      { headers: { 'x-tm8-principal': JSON.stringify(forged) } },
      { actorId: 'system_delivery_adapter', claims: claims() },
      'system_delivery_adapter',
    ];

    for (const candidate of publicShapes) {
      expect(isSystemDeliveryPrincipalFor(candidate, binding(), NOW)).toBe(false);
    }

    const serialized = JSON.stringify(principal);
    expect(serialized).not.toMatch(/token|secret|nonce|accountId|actorId|role/i);
  });

  it('binds all four reservation coordinates', () => {
    const principal = mintSystemDeliveryPrincipal(claims());
    const mismatches: SystemDeliveryPrincipalBinding[] = [
      { ...binding(), deliveryId: 'delivery-other' },
      { ...binding(), messageId: 'message-other' },
      { ...binding(), targetWorkSessionId: 'session-other' },
      { ...binding(), reservationVersion: 8 },
    ];

    for (const mismatch of mismatches) {
      expect(isSystemDeliveryPrincipalFor(principal, mismatch, NOW)).toBe(false);
    }
  });

  it('fails closed at expiry and for an invalid validation clock', () => {
    const principal = mintSystemDeliveryPrincipal(claims());
    const expiresAt = Date.parse(principal.claims.expiresAt);

    expect(isSystemDeliveryPrincipalFor(principal, binding(), expiresAt - 1)).toBe(true);
    expect(isSystemDeliveryPrincipalFor(principal, binding(), expiresAt)).toBe(false);
    expect(isSystemDeliveryPrincipalFor(principal, binding(), Number.NaN)).toBe(false);
    expect(isSystemDeliveryPrincipalFor(principal, binding(), Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('validates constructor input without leaking supplied values in errors', () => {
    const invalidInputs: unknown[] = [
      { ...claims(), actorId: 'should-never-be-a-claim' },
      { ...claims(), deliveryId: '' },
      { ...claims(), messageId: '   ' },
      { ...claims(), targetWorkSessionId: null },
      { ...claims(), reservationVersion: -1 },
      { ...claims(), reservationVersion: 1.5 },
      { ...claims(), expiresAt: 'not-a-date' },
    ];

    for (const input of invalidInputs) {
      expect(() => mintSystemDeliveryPrincipal(input as SystemDeliveryPrincipalClaims)).toThrow(
        'invalid system delivery principal claims',
      );
    }

    try {
      mintSystemDeliveryPrincipal({
        ...claims(),
        deliveryId: 'sensitive-delivery-value',
        expiresAt: 'not-a-date',
      });
      throw new Error('expected mint to fail');
    } catch (error) {
      expect(String(error)).not.toContain('sensitive-delivery-value');
    }
  });
});
