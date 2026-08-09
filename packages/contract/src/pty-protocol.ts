/**
 * Public names used by every PTY WebSocket client and by the server handshake.
 *
 * The grant carrier is an OFFER only. The server selects PTY_WS_PROTOCOL and
 * must never echo the carrier (which contains the short-lived bearer secret).
 */
export const PTY_WS_PROTOCOL = 'tm8-pty-v1';
export const PTY_GRANT_PROTOCOL_PREFIX = 'tm8-grant.';
