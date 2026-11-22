/**
 * What the tm8 server's vault relay links against (@tm8/vault/relay): it signs
 * each forwarded request and strips and decodes the alerts header, and the
 * retired-key denylist both the relay and the broker check (review F03). Nothing
 * here opens a store, a key or a socket.
 */
export * from './attestation.js';
export * from './alerts.js';
export * from './routes.js';
export * from './retired-keys.js';
// The relay passes back only the broker's own two cookies, in the broker's exact shape,
// and 451's internal.vault_notify accepts exactly the broker's alert kinds.
export { VAULT_ALERT_KINDS, VAULT_COOKIE_NAMES } from '../core-types.js';
