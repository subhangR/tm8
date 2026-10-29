/**
 * Shared fixtures for the push tests: NotificationItems in the shapes the
 * inbox assembler produces, and a sealed-token stub.
 *
 * The stub stands in for S1's `openDeviceToken` (392 seals tokens with
 * AES-256-GCM under the node key). It is NOT the real binding: it proves the
 * worker routes through the injected opener and survives one that throws. The
 * real helper is swapped in at the composition root once 392 is on main.
 */
import { createHash } from 'node:crypto';

import type { ActorSummary, EntitySummary, NotificationItem } from '@tm8/contract';

import type { OpenDeviceToken, PushDevice, SealedDeviceToken } from '../../src/push/types.js';

export const ORIGIN = 'https://tm8.acme.dev';
export const SPACE = '01a0fb3d-558e-7d92-b370-d0601112607a';
export const CHANNEL = '01a1867c-76d4-717a-ba18-cef48e00d469';
export const TASK = '01a1867c-d1bf-7dbd-a158-3a49377518b7';
export const MESSAGE = '01a18782-3187-7de4-bebb-45dc44bcdfb3';

let counter = 0;
export function uuid(): string {
  counter += 1;
  return `01a18800-0000-7000-8000-${counter.toString(16).padStart(12, '0')}`;
}

export function actor(displayName: string, kind: ActorSummary['kind'] = 'member'): ActorSummary {
  return { id: uuid(), kind, displayName, isAgent: kind !== 'member' };
}

export function target(kind: string, title: string, id: string = uuid()): EntitySummary {
  return { id, spaceId: SPACE, kind, title } as unknown as EntitySummary;
}

export function notification(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: uuid(),
    spaceId: SPACE,
    kind: 'mention',
    actor: actor('Priya'),
    target: target('channel', 'mobile', CHANNEL),
    message: '@subhang can you look at the tablet overflow?',
    recipient: actor('Subhang'),
    readAt: null,
    createdAt: '2026-10-29T12:00:00.000Z',
    ...overrides,
  };
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A stub seal: the "ciphertext" is the token's bytes, bound to its identity. */
export function stubSeal(identityId: string, token: string): SealedDeviceToken {
  return {
    tokenHash: sha256(token),
    ciphertext: Buffer.from(`${identityId}|${token}`, 'utf8'),
    nonce: Buffer.alloc(12, 7),
  };
}

/** Opens what `stubSeal` sealed; refuses a row moved to another identity or re-hashed. */
export const stubOpen: OpenDeviceToken = (identityId, sealed) => {
  const text = sealed.ciphertext.toString('utf8');
  const prefix = `${identityId}|`;
  if (!text.startsWith(prefix)) throw new Error('device token binding mismatch');
  const token = text.slice(prefix.length);
  if (sha256(token) !== sealed.tokenHash) throw new Error('device token hash mismatch');
  return token;
};

export function expoToken(n: number): string {
  return `ExponentPushToken[${String(n).padStart(22, 'x')}]`;
}

export function device(overrides: Partial<PushDevice> & { token?: string } = {}): PushDevice & { token: string } {
  const identityId = overrides.identityId ?? 'subhang';
  const token = overrides.token ?? expoToken(Math.floor(Math.random() * 1e9));
  return {
    deviceId: uuid(),
    identityId,
    platform: 'ios',
    previews: 'full',
    locale: 'en-GB',
    quietUntil: null,
    sealed: stubSeal(identityId, token),
    ...overrides,
    token,
  };
}
