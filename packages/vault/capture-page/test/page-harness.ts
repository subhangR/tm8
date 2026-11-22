import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { expect, vi } from 'vitest';
import { VAULT_INPUT_SCHEMAS, VAULT_OPERATIONS as CONTRACT_OPERATIONS } from '../../../contract/src/vault.js';
import { CaptureKeyPair } from '../../src/capture/seal.js';
import { mountCapturePage } from '../src/page.js';
import type { CapturePage } from '../src/page.js';
import { TM8_CLIENT_HEADER, VAULT_OPERATIONS, VAULT_PAGE_CLIENT_LABEL, VAULT_SPACE_HEADER } from '../src/contract.js';
import type { ItemType, Operation } from '../src/contract.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
export interface RequestRecord { operation: Operation; url: string; init: RequestInit; body: Record<string, any> }
export interface HarnessOptions {
  mode?: 'capture' | 'import'; itemType?: ItemType; path?: string; session?: boolean;
  /** The space the default link names; null leaves it out. */
  space?: string | null;
  expiresAt?: string; maxCiphertextBytes?: number; fail?: Operation; reason?: string;
  candidates?: Record<string, unknown>[];
  skipped?: { index: number; reason: string }[];
  onRequest?: (request: RequestRecord) => Response | Promise<Response> | undefined;
}
export function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status, headers: { 'Content-Type': 'application/json' } });
}

export function harness(options: HarnessOptions = {}) {
  const captureId = randomUUID();
  const importId = randomUUID();
  const linkToken = randomBytes(32).toString('base64url');
  const spaceId = options.space === undefined ? randomUUID() : options.space;
  const spaceFragment = spaceId === null ? '' : `s=${spaceId}`;
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 600_000).toISOString();
  const path = options.path ?? (options.mode === 'import'
    ? `/vault/capture/import${spaceFragment ? `#${spaceFragment}` : ''}`
    : `/vault/capture/${captureId}#t=${linkToken}${spaceFragment ? `&${spaceFragment}` : ''}`);
  const dom = new JSDOM(html, { url: `https://vault.example${path}` });
  const win = dom.window as unknown as Window & typeof globalThis;
  const broker = CaptureKeyPair.generate();
  const requests: RequestRecord[] = [];
  const assertionId = randomBytes(16).toString('base64url');
  const credentials = { get: vi.fn(async (_options: CredentialRequestOptions): Promise<unknown> => ({
    id: assertionId, rawId: Uint8Array.from([1, 2, 3]).buffer, type: 'public-key',
    response: {
      clientDataJSON: Uint8Array.from([4, 5, 6]).buffer,
      authenticatorData: Uint8Array.from([7, 8, 9]).buffer,
      signature: Uint8Array.from([10, 11, 12]).buffer, userHandle: null,
    },
    getClientExtensionResults: () => ({}), authenticatorAttachment: 'platform',
  })) };
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    expect(win.location.hash).toBe('');
    expect(String(input)).not.toContain(linkToken);
    expect(init).not.toHaveProperty('referrer');
    expect(init.credentials).toBe('same-origin');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(init.redirect).toBe('error');
    // The tm8 session cookie is the only credential; the space is the link's own.
    const headers = new Headers(init.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.get(VAULT_SPACE_HEADER)).toBe(spaceId);
    expect(headers.get(TM8_CLIENT_HEADER)).toBe(VAULT_PAGE_CLIENT_LABEL);
    expect([...headers.keys()].sort()).toEqual(['content-type', TM8_CLIENT_HEADER, ...(spaceId === null ? [] : [VAULT_SPACE_HEADER])].sort());
    const url = String(input);
    const operation = (Object.keys(VAULT_OPERATIONS) as Operation[]).find((name) => {
      const row = CONTRACT_OPERATIONS.find((entry) => entry.name === name)!;
      return row.path.replace(':captureId', captureId).replace(':importId', importId) === url && row.method === init.method;
    });
    expect(operation).toBeDefined();
    if (!operation) throw new Error('Unexpected operation');
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, any> : {};
    expect(VAULT_INPUT_SCHEMAS[operation].safeParse(body).success).toBe(true);
    const record = { operation, url, init, body };
    requests.push(record);
    const overridden = options.onRequest?.(record);
    if (overridden) return overridden;
    if (operation === options.fail) return response({ message: 'Untrusted upstream error', details: { reason: options.reason ?? 'capture_link_invalid' } }, 400);
    switch (operation) {
      case 'vault.status': return response({
        mode: 'pre_review', reviewGate: 'open', testSecretsOnly: true,
        features: { capture: true, import: true },
        viewer: { vaultSession: options.session === false ? null : { sessionId: randomUUID(), expiresAt } },
      });
      case 'vault.webauthn.challenge': return response({
        challengeId: randomUUID(), purpose: body.purpose, action: body.action ?? null,
        intentHash: body.purpose === 'step_up' ? 'a'.repeat(64) : null, expiresAt,
        publicKey: { challenge: randomBytes(32).toString('base64url'), rpId: 'vault.example', timeout: 60_000, userVerification: 'required', allowCredentials: [] },
      });
      case 'vault.session.begin': return response({});
      case 'vault.captures.open': return response({
        captureId, itemType: options.itemType ?? 'login', purpose: 'create', itemId: null, itemName: null,
        expiresAt, publicKey: broker.publicKey(), maxCiphertextBytes: options.maxCiphertextBytes ?? 64 * 1024,
      });
      case 'vault.captures.submit': return response({ name: 'Stored fixture' });
      case 'vault.imports.begin': return response({
        importId, expiresAt, publicKey: broker.publicKey(), maxCiphertextBytes: options.maxCiphertextBytes ?? 8 * 1024 * 1024,
      });
      case 'vault.imports.upload': return response({
        importId, format: 'generic_csv', expiresAt,
        candidates: options.candidates ?? [
          { index: 0, type: 'login', name: 'Primary fixture', origin: 'https://service.example', username: 'fixture-user', originError: null, hasPassword: true, hasTotp: false, duplicateOf: null, warnings: ['notes_present'] },
          { index: 1, type: 'login', name: 'Duplicate fixture', origin: 'https://service.example', username: 'fixture-user', originError: null, hasPassword: true, hasTotp: true, duplicateOf: 0, warnings: [] },
          { index: 2, type: 'login', name: 'Origin fixture', origin: null, username: null, originError: 'origin_refused', hasPassword: true, hasTotp: false, duplicateOf: null, warnings: ['http_origin'] },
        ], skipped: options.skipped ?? [{ index: 3, reason: 'unsupported_type' }],
      });
      case 'vault.imports.commit': return response({
        importId, created: [{ index: 0, itemId: randomUUID(), state: 'active' }], skipped: [], deleteSourceAdvice: true,
      });
      case 'vault.imports.cancel': return response({ importId, state: 'cancelled' });
    }
  });
  let page: CapturePage | undefined;
  return {
    dom, win, broker, fetch, credentials, requests, captureId, importId, linkToken, spaceId,
    mount() {
      page = mountCapturePage(win, {
        fetch: fetch as typeof globalThis.fetch, credentials: credentials as unknown as CredentialsContainer,
        crypto: webcrypto as unknown as Crypto,
      });
      return page;
    },
    close() { page?.dispose(); broker.destroy(); win.close(); },
  };
}
export type Harness = ReturnType<typeof harness>;

export function submit(h: Harness): void {
  const form = h.win.document.querySelector('form');
  expect(form).not.toBeNull();
  form!.dispatchEvent(new h.win.Event('submit', { cancelable: true, bubbles: true }));
}
export async function state(h: Harness, value: string): Promise<void> {
  await vi.waitFor(() => expect(h.win.document.getElementById('vault-page')?.dataset.state).toBe(value));
}
export function fillCapture(h: Harness, fixture: Record<string, unknown>): (HTMLInputElement | HTMLTextAreaElement)[] {
  for (const [key, value] of Object.entries(fixture)) {
    if (key === 'type') continue;
    if (key === 'fields') {
      const [name, fieldValue] = Object.entries(value as Record<string, string>)[0]!;
      (h.win.document.querySelector('[data-identity-key]') as HTMLInputElement).value = name;
      (h.win.document.querySelector('[data-identity-value]') as HTMLInputElement).value = fieldValue;
    } else {
      const input = h.win.document.querySelector(`[name="${key}"]`) as HTMLInputElement;
      expect(input).not.toBeNull(); input.value = String(value);
    }
  }
  return Array.from(h.win.document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea'));
}

export function leakageSinks(h: Harness) {
  const consoleSpies = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'].flatMap((method) => [
    vi.spyOn(console, method as 'log').mockImplementation(() => undefined),
    vi.spyOn(h.win.console, method as 'log').mockImplementation(() => undefined),
  ]);
  const storageSpies = ['setItem', 'removeItem', 'clear'].map((method) => vi.spyOn(h.win.Storage.prototype, method as 'setItem'));
  const cookieSpy = vi.spyOn(h.win.document, 'cookie', 'set');
  const historySpies = [vi.spyOn(h.win.history, 'pushState'), vi.spyOn(h.win.history, 'replaceState')];
  const indexedDB = { open: vi.fn(), deleteDatabase: vi.fn() };
  const clipboard = { writeText: vi.fn(), write: vi.fn(), readText: vi.fn(), read: vi.fn() };
  Object.defineProperty(h.win, 'indexedDB', { value: indexedDB, configurable: true });
  Object.defineProperty(h.win.navigator, 'clipboard', { value: clipboard, configurable: true });
  return {
    assertClean() {
      for (const spy of [...consoleSpies, ...storageSpies, cookieSpy, ...Object.values(indexedDB), ...Object.values(clipboard)]) expect(spy).not.toHaveBeenCalled();
      for (const spy of historySpies) {
        for (const args of spy.mock.calls) expect(args[2]).toBe(h.win.location.pathname);
      }
      expect(h.win.location.hash).toBe(''); expect(h.win.location.search).toBe('');
    },
  };
}

/** Strip ONLY authenticated ciphertext, then compare each typed primitive. */
export function assertNoCanaries(requests: RequestRecord[], fixture: Record<string, unknown>) {
  const scalars: unknown[] = [];
  const flatten = (value: unknown): void => {
    if (value && typeof value === 'object') Object.values(value).forEach(flatten);
    else scalars.push(value);
  };
  for (const [key, value] of Object.entries(fixture)) if (key !== 'type') flatten(value);
  if (fixture.fields) scalars.push(...Object.keys(fixture.fields));
  const walk = (value: unknown): void => {
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) if (key !== 'ct') walk(child);
    } else {
      for (const canary of scalars) {
        expect(value).not.toEqual(canary);
        if (typeof value === 'string' && typeof canary === 'string') expect(value).not.toContain(canary);
      }
    }
  };
  for (const request of requests) {
    walk(request.body);
    for (const canary of scalars) if (typeof canary === 'string') expect(request.url).not.toContain(canary);
  }
}
