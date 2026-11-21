import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VAULT_IMPORT_FORMATS, VAULT_IMPORT_PAGE_PATH as CONTRACT_IMPORT_PATH,
  VAULT_MAX_CAPTURE_CIPHERTEXT as CONTRACT_MAX_CAPTURE, VAULT_MAX_IMPORT_CIPHERTEXT as CONTRACT_MAX_IMPORT,
  VAULT_OPERATIONS as CONTRACT_OPERATIONS, VAULT_ITEM_TYPES, VAULT_SPACE_HEADER as CONTRACT_SPACE_HEADER,
} from '../../../contract/src/vault.js';
import { CAPTURE_RESPONSE_HEADERS } from '../src/headers.js';
import { CAPTURE_FIELDS } from '../src/payload.js';
import { IMPORT_FORMATS, VAULT_IMPORT_PAGE_PATH, VAULT_MAX_CAPTURE_CIPHERTEXT, VAULT_MAX_IMPORT_CIPHERTEXT, VAULT_OPERATIONS, VAULT_SPACE_HEADER } from '../src/contract.js';
import { harness, response } from './page-harness.js';
import type { Harness } from './page-harness.js';
import { PageError, errorCopy, remoteError } from '../src/errors.js';

const doms: JSDOM[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const dom of doms.splice(0)) dom.window.close(); });

describe('standalone assets and contract parity', () => {
  it('exports the complete strict response headers without wildcards or unsafe directives', () => {
    expect(CAPTURE_RESPONSE_HEADERS).toEqual({
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    const values = Object.values(CAPTURE_RESPONSE_HEADERS).join(';');
    expect(values).not.toContain('unsafe-'); expect(values).not.toContain('*');
    expect(Object.isFrozen(CAPTURE_RESPONSE_HEADERS)).toBe(true);
  });

  it('has only absolute same-origin URLs and no inline script, style or event handler', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const dom = new JSDOM(html); doms.push(dom);
    const document = dom.window.document;
    expect(document.querySelectorAll('script')).toHaveLength(1);
    expect(document.querySelector('script')?.getAttribute('type')).toBe('module');
    expect(document.querySelector('script')?.getAttribute('src')).toBe('/vault/capture/assets/capture.js');
    expect(document.querySelector('script')?.textContent?.trim()).toBe('');
    expect(document.querySelector('link')?.getAttribute('href')).toBe('/vault/capture/assets/capture.css');
    expect(document.querySelector('style, [style], base, iframe')).toBeNull();
    for (const node of document.querySelectorAll('*')) {
      for (const attribute of node.attributes) {
        expect(attribute.name).not.toMatch(/^on/i);
        if (attribute.name === 'src' || attribute.name === 'href') expect(attribute.value).toMatch(/^\/vault\/capture\/assets\/[a-z.]+$/);
      }
    }
    const css = readFileSync(new URL('../capture.css', import.meta.url), 'utf8');
    expect(css).not.toMatch(/@import|url\(/i);
  });

  it('matches every browser route, item type, format and limit to the authoritative contract', () => {
    for (const [name, row] of Object.entries(VAULT_OPERATIONS)) {
      const authoritative = CONTRACT_OPERATIONS.find((operation) => operation.name === name);
      expect(authoritative).toBeDefined();
      expect(row).toEqual({ method: authoritative?.method, path: authoritative?.path });
    }
    expect(VAULT_IMPORT_PAGE_PATH).toBe(CONTRACT_IMPORT_PATH);
    expect(VAULT_SPACE_HEADER).toBe(CONTRACT_SPACE_HEADER);
    expect(IMPORT_FORMATS).toEqual(VAULT_IMPORT_FORMATS);
    expect(Object.keys(CAPTURE_FIELDS)).toEqual([...VAULT_ITEM_TYPES]);
    expect(VAULT_MAX_CAPTURE_CIPHERTEXT).toBe(CONTRACT_MAX_CAPTURE);
    expect(VAULT_MAX_IMPORT_CIPHERTEXT).toBe(CONTRACT_MAX_IMPORT);
  });

  it('emits capture.js and local ES modules with no runtime package imports', () => {
    const dist = new URL('../dist/', import.meta.url);
    const names = readdirSync(dist);
    expect(names).toContain('capture.js');
    // Only modules built from src: a stale module would still be served.
    expect(names.filter((name) => name.endsWith('.js')).sort()).toEqual(readdirSync(new URL('../src/', import.meta.url)).filter((name) => name.endsWith('.ts')).map((name) => name.replace(/\.ts$/, '.js')).sort());
    for (const name of names.filter((name) => name.endsWith('.js'))) {
      const source = readFileSync(new URL(name, dist), 'utf8');
      for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) expect(match[1]).toMatch(/^\.\/[a-z0-9-]+\.js$/);
      // No web storage or cookie access at all, and no bearer: the HttpOnly tm8 session cookie is the only credential.
      expect(source).not.toMatch(/\bconsole\s*[.[]|\b(?:localStorage|sessionStorage)\b|\bindexedDB\b|\bclipboard\b|\bdocument\.cookie\b|\bauthorization\b/i);
    }
    expect(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dependencies).toBeUndefined();
  });
});

describe('cookie-only tm8 authentication and the link space', () => {
  const pages: Harness[] = [];
  const make = (options: Parameters<typeof harness>[0] = {}) => { const h = harness(options); pages.push(h); return h; };
  afterEach(() => { for (const h of pages.splice(0)) h.close(); });
  const pass = () => ['tm8', 's_', randomUUID(), '.', randomBytes(32).toString('base64url')].join('');

  it('never reads web storage, so a bearer the SPA keeps there never leaves the page', async () => {
    const h = make();
    const token = pass();
    h.win.localStorage.setItem('tm8ui.auth.passes.v1', JSON.stringify({ [h.win.location.origin]: { token, account: { handle: '@fixture' } } }));
    const reads = [vi.spyOn(h.win.Storage.prototype, 'getItem'), vi.spyOn(h.win.Storage.prototype, 'key')];
    await h.mount().ready;
    expect(h.requests.map((request) => request.operation)).toEqual(['vault.status', 'vault.captures.open']);
    for (const spy of reads) expect(spy).not.toHaveBeenCalled();
    for (const request of h.requests) {
      expect(new Headers(request.init.headers).has('authorization')).toBe(false);
      expect(JSON.stringify([request.url, [...new Headers(request.init.headers)], request.body])).not.toContain(token);
    }
  });

  it('sends the space the link names on every call and strips it with the token', async () => {
    const h = make();
    await h.mount().ready;
    expect(h.win.location.hash).toBe('');
    expect(h.requests.length).toBeGreaterThan(0);
    for (const request of h.requests) expect(new Headers(request.init.headers).get(VAULT_SPACE_HEADER)).toBe(h.spaceId);
  });

  it.each([
    ['no space', (h: Harness) => `#t=${h.linkToken}`],
    ['an empty space', (h: Harness) => `#t=${h.linkToken}&s=`],
    ['an upper-case space', (h: Harness) => `#t=${h.linkToken}&s=${randomUUID().toUpperCase()}`],
    ['two spaces', (h: Harness) => `#t=${h.linkToken}&s=${randomUUID()}&s=${randomUUID()}`],
    ['a space that is not a UUID', (h: Harness) => `#t=${h.linkToken}&s=space-a`],
  ])('makes no request from a capture link with %s', async (_label, fragment) => {
    const h = make();
    h.win.history.replaceState(null, '', `${h.win.location.pathname}${fragment(h)}`);
    await h.mount().ready;
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.win.location.hash).toBe('');
    expect(h.win.document.body.textContent).toContain('Invalid link');
  });

  it('opens the import page with no space, sending none, so the relay needs a single membership', async () => {
    const h = make({ mode: 'import', space: null });
    await h.mount().ready;
    expect(h.requests.length).toBeGreaterThan(0);
    for (const request of h.requests) expect(new Headers(request.init.headers).has(VAULT_SPACE_HEADER)).toBe(false);
  });

  it('opens the import page in the space it names, and refuses a malformed one', async () => {
    const named = make({ mode: 'import' });
    await named.mount().ready;
    for (const request of named.requests) expect(new Headers(request.init.headers).get(VAULT_SPACE_HEADER)).toBe(named.spaceId);
    const malformed = make({ mode: 'import', path: `/vault/capture/import#s=${randomUUID()}&s=${randomUUID()}` });
    await malformed.mount().ready;
    expect(malformed.fetch).not.toHaveBeenCalled();
    expect(malformed.win.document.body.textContent).toContain('Invalid link');
  });

  it.each([
    ['a tm8 401', () => response({ message: 'Untrusted upstream error' }, 401), 'Sign in to tm8 in this browser'],
    ['a proxy 401 page', () => new Response('<html>401</html>', { status: 401, headers: { 'Content-Type': 'text/html' } }), 'Sign in to tm8 in this browser'],
    ['a proxy 502 page', () => new Response('<html>502</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }), 'The vault is unavailable'],
  ])('maps %s on the first call to fixed copy', async (_label, reply, copy) => {
    const h = make({ onRequest: (request) => request.operation === 'vault.status' ? reply() : undefined });
    await h.mount().ready;
    expect(h.win.document.getElementById('vault-page')?.dataset.state).toBe('error');
    expect(h.win.document.body.textContent).toContain(copy);
    expect(h.win.document.body.textContent).not.toContain('<html>');
  });
});

describe('fixed error copy', () => {
  it('accepts the integrated secret_in_metadata reason without echoing arbitrary reasons', () => {
    expect(errorCopy(remoteError('secret_in_metadata', 400))).toContain('stored as plain metadata');
    const canary = `synthetic-error-${randomUUID()}`;
    expect(errorCopy(remoteError(canary, 400))).not.toContain(canary);
    expect(errorCopy(new Error(canary))).not.toContain(canary);
    expect(remoteError('__proto__', 400)).toEqual(new PageError('failed'));
    expect(remoteError(null, 501)).toEqual(new PageError('unavailable'));
  });
});
