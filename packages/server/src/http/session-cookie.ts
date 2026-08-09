import type { IncomingHttpHeaders } from 'node:http';

/** __Host- forbids Domain and requires Secure + Path=/ in supporting browsers. */
export const TM8_SESSION_COOKIE = '__Host-tm8-session';

export function readTm8SessionCookie(headers: IncomingHttpHeaders): string | null {
  const header = headers.cookie;
  if (header === undefined) return null;
  const raw = Array.isArray(header) ? header.join(';') : header;
  for (const pair of raw.split(';')) {
    const equals = pair.indexOf('=');
    if (equals < 0) continue;
    if (pair.slice(0, equals).trim() !== TM8_SESSION_COOKIE) continue;
    const value = pair.slice(equals + 1).trim();
    return value.length > 0 && value.length <= 512 ? value : null;
  }
  return null;
}

export function sessionCookie(token: string, expiresAt: string): string {
  const expires = new Date(expiresAt);
  const maxAge = Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000));
  return [
    `${TM8_SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    `Expires=${expires.toUTCString()}`,
  ].join('; ');
}

export function clearSessionCookie(): string {
  return [
    `${TM8_SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ].join('; ');
}
