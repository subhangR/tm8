import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VAULT_IMPORT_FORMATS, VAULT_IMPORT_PAGE_PATH as CONTRACT_IMPORT_PATH,
  VAULT_MAX_CAPTURE_CIPHERTEXT as CONTRACT_MAX_CAPTURE, VAULT_MAX_IMPORT_CIPHERTEXT as CONTRACT_MAX_IMPORT,
  VAULT_OPERATIONS as CONTRACT_OPERATIONS, VAULT_ITEM_TYPES,
} from '../../../contract/src/vault.js';
import { CAPTURE_RESPONSE_HEADERS } from '../src/headers.js';
import { CAPTURE_FIELDS } from '../src/payload.js';
import { IMPORT_FORMATS, VAULT_IMPORT_PAGE_PATH, VAULT_MAX_CAPTURE_CIPHERTEXT, VAULT_MAX_IMPORT_CIPHERTEXT, VAULT_OPERATIONS } from '../src/contract.js';
import { tm8Authorization } from '../src/tm8-auth.js';
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
    expect(IMPORT_FORMATS).toEqual(VAULT_IMPORT_FORMATS);
    expect(Object.keys(CAPTURE_FIELDS)).toEqual([...VAULT_ITEM_TYPES]);
    expect(VAULT_MAX_CAPTURE_CIPHERTEXT).toBe(CONTRACT_MAX_CAPTURE);
    expect(VAULT_MAX_IMPORT_CIPHERTEXT).toBe(CONTRACT_MAX_IMPORT);
  });

  it('emits capture.js and local ES modules with no runtime package imports', () => {
    const dist = new URL('../dist/', import.meta.url);
    const names = readdirSync(dist);
    expect(names).toContain('capture.js');
    for (const name of names.filter((name) => name.endsWith('.js'))) {
      const source = readFileSync(new URL(name, dist), 'utf8');
      for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) expect(match[1]).toMatch(/^\.\/[a-z0-9-]+\.js$/);
      expect(source).not.toMatch(/\bconsole\s*[.[]|\b(?:localStorage|sessionStorage)\.(?:setItem|removeItem|clear)|\bindexedDB\b|\bclipboard\b|document\.cookie\s*=/);
    }
    expect(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dependencies).toBeUndefined();
  });
});

describe('read-only same-origin tm8 authorization', () => {
  function setup(value?: string) {
    const dom = new JSDOM('', { url: 'https://vault.example/vault/capture/import' }); doms.push(dom);
    if (value !== undefined) dom.window.localStorage.setItem('tm8ui.auth.passes.v1', value);
    vi.stubGlobal('window', dom.window);
    const writes = ['setItem', 'removeItem', 'clear'].map((key) => vi.spyOn(dom.window.Storage.prototype, key as 'setItem'));
    return { dom, writes };
  }

  it('reads only the pass for this origin, independent of a different active SPA server', () => {
    const token = ['tm8', 's_', randomUUID(), '.', randomBytes(32).toString('base64url')].join('');
    const { dom, writes } = setup(JSON.stringify({
      'https://vault.example': { token, account: { handle: '@fixture' } },
      'https://another.example': { token: 'other-synthetic-pass', account: { handle: '@other' } },
    }));
    dom.window.localStorage.setItem('tm8ui.servers.active.v1', 'another-server');
    writes.forEach((spy) => spy.mockClear());
    expect(tm8Authorization()).toBe(`Bearer ${token}`);
    for (const spy of writes) expect(spy).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'broken JSON', '[]', '{}', '{"https://vault.example":{"token":"synthetic"}}'])(
    'fails closed on missing or corrupt pass records', (value) => {
      const { writes } = setup(value);
      expect(tm8Authorization()).toBeNull();
      for (const spy of writes) expect(spy).not.toHaveBeenCalled();
    },
  );

  it('fails closed if storage is blocked and never includes exception data', () => {
    const { dom, writes } = setup();
    vi.spyOn(dom.window.Storage.prototype, 'getItem').mockImplementation(() => { throw new Error(`synthetic-${randomUUID()}`); });
    expect(tm8Authorization()).toBeNull();
    for (const spy of writes) expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a stored pass with header control characters', () => {
    setup(JSON.stringify({ 'https://vault.example': { token: 'synthetic\r\nheader', account: { handle: '@fixture' } } }));
    expect(tm8Authorization()).toBeNull();
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
