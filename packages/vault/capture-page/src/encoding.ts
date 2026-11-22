import { PageError } from './errors.js';

export type Bytes = Uint8Array<ArrayBuffer>;
export function base64url(bytes: Uint8Array): string {
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 0x4000) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + 0x4000));
  }
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unbase64url(value: string, length?: number): Bytes {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new PageError('invalid_key');
    const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
    const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
    if ((length !== undefined && bytes.length !== length) || base64url(bytes) !== value) throw new PageError('invalid_key');
    return bytes;
  } catch { throw new PageError('invalid_key'); }
}
