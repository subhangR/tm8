/**
 * events/ — the WorkspaceEvent stream (T-L10: one socket for the whole
 * workspace) and the seams the W2 implementation plugs into.
 *
 * The codec is exported alongside the rest so it can be unit-tested directly;
 * nothing outside this directory should need it.
 */
export * from './ws-frame.js';
export * from './ws-connection.js';
export * from './ws-server.js';
export * from './seq.js';
export * from './subscriptions.js';
export * from './emitter.js';
export * from './projector.js';
export * from './mapper.js';
export * from './poll.js';
export * from './handlers.js';
