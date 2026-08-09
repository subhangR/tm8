import { describe, expect, it } from 'vitest';

import { clearSessionCookie, readTm8SessionCookie, sessionCookie } from '../src/http/session-cookie.js';
import { createPtyAuditLogger } from '../src/pty/audit-logger.js';

describe('browser cookie and secret-free PTY audit records', () => {
  it('uses the __Host cookie contract and parses only the exact cookie name', () => {
    const token = 'tm8s_not-for-a-url';
    const cookie = sessionCookie(token, new Date(Date.now() + 60_000).toISOString());
    expect(cookie).toContain('__Host-tm8-session=');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('Domain=');
    expect(readTm8SessionCookie({ cookie: `foreign=x; __Host-tm8-session=${token}` })).toBe(token);
    expect(readTm8SessionCookie({ cookie: `tm8-session=${token}` })).toBeNull();
    expect(clearSessionCookie()).toContain('Max-Age=0');
  });

  it('drops every field outside the audit allowlist, including errors and grants', () => {
    const lines: string[] = [];
    const logger = createPtyAuditLogger({ info: (line) => lines.push(line), error: (line) => lines.push(line) });
    logger.info('attached', {
      sessionId: 'session-id',
      mode: 'view',
      token: 'tm8g_secret',
      tokenHash: 'hash-secret',
      url: '/v2/ws?token=secret',
    });
    logger.error('failed', new Error('tm8g_error-secret'), { reason: 'credential_refused' });
    const output = lines.join('\n');
    expect(output).toContain('session-id');
    expect(output).toContain('credential_refused');
    expect(output).not.toContain('tm8g_');
    expect(output).not.toContain('hash-secret');
    expect(output).not.toContain('?token=');
  });
});
