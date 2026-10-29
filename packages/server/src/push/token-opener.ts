/**
 * THE JOIN WITH S1, in TypeScript: the one place the push worker learns how to
 * open a device token. It is S1's `openDeviceToken` (devices/device-token.ts,
 * 392) bound to this node's credential key, and nothing else in push/ knows
 * how tokens are sealed.
 *
 * Until 392 is on this branch the opener refuses every token, so a node built
 * from this branch alone can send nothing even with push configured.
 */
import type { OpenDeviceToken } from './types.js';

export function nodeDeviceTokenOpener(_key: Buffer): OpenDeviceToken {
  return () => {
    throw new Error('device tokens cannot be opened on this build: 392 (S1, devices/device-token.ts) is not on it');
  };
}
