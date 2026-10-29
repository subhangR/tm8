/**
 * devices.* (TM8 Mobile S1, migration 392): the catalog rows and the wire
 * schemas. The push token is a credential, so the rules pinned here are that
 * no body may name an owner, a bad token is refused without its value in the
 * refusal, and a response carrying a token field does not parse.
 */
import { describe, expect, it } from 'vitest';

import {
  DeviceViewSchema,
  DeviceWriteResultSchema,
  DevicesRegisterInputSchema,
  DevicesUnregisterInputSchema,
  DevicesUpdateInputSchema,
  EXPO_PUSH_TOKEN_RE,
  OPERATIONS,
  getOperation,
} from '../src/index.js';

const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxx1]';
const REGISTER = {
  clientMutationId: '01J0000000000000000000000A',
  platform: 'ios',
  relay: 'expo',
  token: TOKEN,
  appVersion: '1.0.0 (42)',
  locale: 'en-US',
  previews: 'sender',
  label: 'TM8 Mobile · iPhone',
  quietUntil: '2026-10-30T07:00:00+02:00',
};
const VIEW = {
  id: '01a1867c-76d4-717a-ba18-cef48e00d469',
  platform: 'android',
  relay: 'expo',
  appVersion: '1.0.0',
  locale: 'de',
  previews: 'none',
  label: 'TM8 Mobile · Pixel',
  quietUntil: null,
  version: 2,
  createdAt: '2026-10-29T08:00:00.000Z',
  updatedAt: '2026-10-29T08:05:00.000Z',
};

describe('devices catalog rows', () => {
  it('binds POST/PUT/DELETE /v2/devices, all v1 human-only commands', () => {
    expect(getOperation('devices.register')).toEqual({
      name: 'devices.register', method: 'POST', path: '/v2/devices', kind: 'command', status: 'v1', humanOnly: true,
    });
    expect(getOperation('devices.update')).toMatchObject({ method: 'PUT', path: '/v2/devices/:deviceId', humanOnly: true });
    expect(getOperation('devices.unregister')).toMatchObject({ method: 'DELETE', path: '/v2/devices/:deviceId', humanOnly: true });
    // No read of devices exists, so no read can return a token.
    expect(OPERATIONS.filter((op) => op.name.startsWith('devices.')).map((op) => op.kind)).toEqual(['command', 'command', 'command']);
  });
});

describe('devices.register input', () => {
  it('accepts the design body, with previews and quietUntil optional', () => {
    expect(DevicesRegisterInputSchema.parse(REGISTER)).toEqual(REGISTER);
    const { previews: _p, quietUntil: _q, ...minimal } = REGISTER;
    expect(DevicesRegisterInputSchema.safeParse(minimal).success).toBe(true);
    // Register only SETS a quiet window; clearing one is devices.update's.
    expect(DevicesRegisterInputSchema.safeParse({ ...REGISTER, quietUntil: null }).success).toBe(false);
  });

  it('refuses any field that names an owner, a session or an actor', () => {
    for (const key of ['accountId', 'identityId', 'actorId', 'authSessionId', 'tokenHash']) {
      expect(DevicesRegisterInputSchema.safeParse({ ...REGISTER, [key]: 'x' }).success).toBe(false);
    }
  });

  it('refuses an unknown platform, relay or previews value', () => {
    expect(DevicesRegisterInputSchema.safeParse({ ...REGISTER, platform: 'web' }).success).toBe(false);
    expect(DevicesRegisterInputSchema.safeParse({ ...REGISTER, relay: 'fcm' }).success).toBe(false);
    expect(DevicesRegisterInputSchema.safeParse({ ...REGISTER, previews: 'all' }).success).toBe(false);
    expect(DevicesRegisterInputSchema.safeParse({ ...REGISTER, locale: 'en US' }).success).toBe(false);
    expect(DevicesRegisterInputSchema.safeParse({ ...REGISTER, label: '   ' }).success).toBe(false);
    expect(DevicesRegisterInputSchema.safeParse({ ...REGISTER, quietUntil: 'tomorrow' }).success).toBe(false);
  });

  it('takes Expo token shapes only, and never puts the refused value in the refusal', () => {
    for (const ok of [TOKEN, 'ExpoPushToken[abc_DEF-123]', '3f2504e0-4f89-11d3-9a0c-0305e82c3301']) {
      expect(EXPO_PUSH_TOKEN_RE.test(ok)).toBe(true);
    }
    const refused = [
      'exponentpushtoken[lowercase-prefix]',
      'ExponentPushToken[has space]',
      'ExponentPushToken["quote"]',
      'fcm:AAAA-secret-looking-value-1234',
      `ExponentPushToken[${'a'.repeat(300)}]`,
    ];
    for (const token of refused) {
      const parsed = DevicesRegisterInputSchema.safeParse({ ...REGISTER, token });
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).not.toContain(token);
    }
  });
});

describe('devices.update and devices.unregister input', () => {
  it('update needs expectedVersion and at least one change; quietUntil null clears', () => {
    const base = { clientMutationId: 'u1', expectedVersion: 3 };
    expect(DevicesUpdateInputSchema.safeParse({ ...base, token: TOKEN }).success).toBe(true);
    expect(DevicesUpdateInputSchema.safeParse({ ...base, quietUntil: null }).success).toBe(true);
    expect(DevicesUpdateInputSchema.safeParse(base).success).toBe(false);
    expect(DevicesUpdateInputSchema.safeParse({ clientMutationId: 'u1', previews: 'full' }).success).toBe(false);
    expect(DevicesUpdateInputSchema.safeParse({ ...base, platform: 'android' }).success).toBe(false);
  });

  it('unregister takes a mutation id and an optional version, nothing else', () => {
    expect(DevicesUnregisterInputSchema.safeParse({ clientMutationId: 'd1' }).success).toBe(true);
    expect(DevicesUnregisterInputSchema.safeParse({ clientMutationId: 'd1', expectedVersion: 2 }).success).toBe(true);
    expect(DevicesUnregisterInputSchema.safeParse({ clientMutationId: 'd1', token: TOKEN }).success).toBe(false);
  });
});

describe('device results', () => {
  it('parse a token-free view, and refuse one that carries any token field', () => {
    expect(DeviceWriteResultSchema.parse({ deviceId: VIEW.id, device: VIEW })).toEqual({ deviceId: VIEW.id, device: VIEW });
    for (const leak of [{ token: TOKEN }, { tokenHash: 'a'.repeat(64) }, { tokenCiphertext: 'x' }]) {
      expect(DeviceViewSchema.safeParse({ ...VIEW, ...leak }).success).toBe(false);
    }
  });
});
