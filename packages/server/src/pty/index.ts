/**
 * pty/ — the live terminal WebSocket for the browser session view.
 *
 * Separate from events/ on purpose: that directory carries the workspace event
 * stream as JSON text frames, this one carries raw PTY bytes as binary frames.
 * They share only the RFC 6455 codec. See pty-ws-server.ts for the protocol and
 * why the two sockets are kept apart.
 */
export * from './pty-ws-connection.js';
export * from './pty-ws-server.js';
