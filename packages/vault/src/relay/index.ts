/**
 * What the tm8 server's vault relay links against (@tm8/vault/relay): it signs
 * each forwarded request and strips and decodes the alerts header. Nothing here
 * opens a store, a key or a socket.
 */
export * from './attestation.js';
export * from './alerts.js';
