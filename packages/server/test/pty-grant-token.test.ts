import { describe, expect, it } from 'vitest';

import {
  hashPtyGrantToken,
  issuePtyGrantToken,
  ptyGrantFromProtocolHeader,
  PTY_GRANT_PROTOCOL_PREFIX,
  PTY_PROTOCOL,
} from '../src/pty/index.js';

describe('PTY grant token format and protocol carrier', () => {
  it('mints independent 256-bit base64url capabilities and hashes deterministically', () => {
    const first = issuePtyGrantToken();
    const second = issuePtyGrantToken();
    expect(first.token).toMatch(/^tm8g_[A-Za-z0-9_-]{43}$/);
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.tokenHash).toBe(hashPtyGrantToken(first.token));
    expect(first.tokenHash).not.toContain(first.token);
  });

  it('requires the public protocol plus exactly one well-formed carrier', () => {
    const issued = issuePtyGrantToken();
    const carrier = `${PTY_GRANT_PROTOCOL_PREFIX}${issued.token}`;
    expect(ptyGrantFromProtocolHeader(`${PTY_PROTOCOL}, ${carrier}`)?.token).toBe(issued.token);
    expect(ptyGrantFromProtocolHeader(carrier)).toBeNull();
    expect(ptyGrantFromProtocolHeader(`${PTY_PROTOCOL}, ${carrier}, ${carrier}`)).toBeNull();
    expect(ptyGrantFromProtocolHeader(`${PTY_PROTOCOL}, tm8-grant.invalid`)).toBeNull();
    expect(ptyGrantFromProtocolHeader('x'.repeat(513))).toBeNull();
  });
});
