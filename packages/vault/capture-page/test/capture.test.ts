import { afterEach, describe, expect, it, vi } from 'vitest';
import { vaultStepUpBoundParams } from '../../../contract/src/vault.js';
import { parseCapturePayload } from '../../src/capture/payload.js';
import { payloadFixture } from './fixtures.js';
import { assertNoCanaries, fillCapture, harness, leakageSinks, response, state, submit } from './page-harness.js';
import type { Harness } from './page-harness.js';

const pages: Harness[] = [];
const make = (options: Parameters<typeof harness>[0] = {}) => { const h = harness(options); pages.push(h); return h; };
afterEach(() => { for (const h of pages.splice(0)) h.close(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('capture page', () => {
  it.each(['login', 'api_key', 'card', 'note', 'identity'] as const)('seals every %s field, binds step-up and clears fields', async (itemType) => {
    const h = make({ itemType });
    const sinks = leakageSinks(h);
    await h.mount().ready;
    const fixture = payloadFixture(itemType);
    const fields = fillCapture(h, fixture);
    for (const input of fields) {
      expect(input.autocomplete).toBe(input.type === 'password' ? 'new-password' : 'off');
      expect(input.getAttribute('spellcheck')).toBe('false');
    }
    submit(h);
    await state(h, 'stored');
    for (const input of fields) expect(input.value).toBe('');
    const challenge = h.requests.find((request) => request.body.purpose === 'step_up')!;
    const submitted = h.requests.find((request) => request.operation === 'vault.captures.submit')!;
    expect(challenge.body.pathParams).toEqual({ captureId: h.captureId });
    expect(vaultStepUpBoundParams(challenge.body.pathParams, challenge.body.body)).toEqual(vaultStepUpBoundParams({ captureId: h.captureId }, submitted.body));
    expect(challenge.body.body.sealed).toEqual(submitted.body.sealed);
    expect(submitted.body.linkToken).toBe(h.linkToken);
    const opened = h.broker.open(submitted.body.sealed, h.captureId);
    try {
      expect(JSON.parse(opened.toString())).toEqual(fixture);
      const parsed = parseCapturePayload(opened, itemType);
      try { expect(parsed.metadata.type).toBe(itemType); } finally { parsed.secret.dispose(); }
    } finally { opened.fill(0); }
    assertNoCanaries(h.requests, fixture);
    sinks.assertClean();
    expect(h.win.document.querySelector('h1')?.textContent).toBe('Stored');
    expect(h.win.document.querySelector('#vault-page')?.textContent).toContain('Stored fixture');
    expect(h.credentials.get).toHaveBeenCalledTimes(1);
  });

  it('strips the token before the first fetch and never sends it in a URL or referrer', async () => {
    const h = make();
    const replace = vi.spyOn(h.win.history, 'replaceState');
    await h.mount().ready;
    expect(replace).toHaveBeenCalledWith(null, '', `/vault/capture/${h.captureId}`);
    expect(replace.mock.invocationCallOrder[0]).toBeLessThan(h.fetch.mock.invocationCallOrder[0]!);
    expect(h.requests[0]?.operation).toBe('vault.status');
    expect(h.requests[0]?.init).not.toHaveProperty('body');
    for (const request of h.requests) { expect(request.url).not.toContain(h.linkToken); expect(request.init).not.toHaveProperty('referrer'); }
  });

  it('signs in using the injected authenticator before opening a capture', async () => {
    const h = make({ session: false });
    await h.mount().ready;
    expect(h.requests.map((request) => request.operation)).toEqual(['vault.status']);
    h.win.document.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(h.win.document.querySelector('[name="password"]')).not.toBeNull());
    expect(h.requests.map((request) => request.operation)).toEqual(['vault.status', 'vault.webauthn.challenge', 'vault.session.begin', 'vault.captures.open']);
    const options = h.credentials.get.mock.calls[0]![0] as CredentialRequestOptions;
    expect(options.publicKey?.userVerification).toBe('required');
    expect(options.publicKey?.challenge).toBeInstanceOf(Uint8Array);
    expect(options.signal).toBeDefined();
    expect(h.requests[1]?.body.purpose).toBe('sign_in');
  });

  it.each(['capture_link_invalid', 'capture_key_rotated', 'step_up_invalid', 'unknown_upstream_value'])(
    'clears every field on %s without showing upstream data', async (reason) => {
      const h = make({ fail: 'vault.captures.submit', reason });
      const sinks = leakageSinks(h);
      await h.mount().ready;
      const fixture = payloadFixture('login');
      const fields = fillCapture(h, fixture);
      submit(h); await state(h, 'error');
      for (const input of fields) expect(input.value).toBe('');
      if (reason.startsWith('capture_')) expect(h.win.document.querySelector('#vault-status')?.textContent).toContain('Ask for a new link');
      expect(h.win.document.body.textContent).not.toContain('Untrusted upstream error');
      expect(h.win.document.body.textContent).not.toContain(reason);
      assertNoCanaries(h.requests, fixture); sinks.assertClean();
    },
  );

  it('clears invalid local payloads before any submit or challenge', async () => {
    const h = make(); await h.mount().ready;
    const fields = fillCapture(h, { ...payloadFixture('login'), origin: 'not an origin' });
    submit(h); await state(h, 'error');
    for (const input of fields) expect(input.value).toBe('');
    expect(h.requests).toHaveLength(2);
    expect(h.credentials.get).not.toHaveBeenCalled();
  });

  it('zeroes the capture plaintext bytes before requesting step-up', async () => {
    const plaintextBuffers: Uint8Array[] = [];
    const fixture = payloadFixture('login');
    const encode = TextEncoder.prototype.encode;
    vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (value?: string) {
      const bytes = encode.call(this, value);
      if (value?.includes(String(fixture.password))) plaintextBuffers.push(bytes);
      return bytes;
    });
    const h = make({ onRequest: (request) => {
      if (request.body.purpose === 'step_up') {
        expect(plaintextBuffers).toHaveLength(1);
        expect(plaintextBuffers[0]!.every((byte) => byte === 0)).toBe(true);
      }
      return undefined;
    } });
    await h.mount().ready; fillCapture(h, fixture); submit(h); await state(h, 'stored');
    expect(plaintextBuffers).toHaveLength(1);
    expect(plaintextBuffers[0]!.every((byte) => byte === 0)).toBe(true);
  });

  it('clears every field on pagehide, disables the form and aborts requests', async () => {
    const h = make(); await h.mount().ready;
    const fixture = payloadFixture('login');
    const fields = fillCapture(h, fixture);
    const count = h.requests.length;
    h.win.dispatchEvent(new h.win.Event('pagehide'));
    for (const input of fields) { expect(input.value).toBe(''); expect(input.disabled).toBe(true); }
    submit(h); await Promise.resolve();
    expect(h.requests).toHaveLength(count);
    expect(h.requests[0]?.init.signal?.aborted).toBe(true);
  });

  it('expires the form, clears values and stops submission', async () => {
    vi.useFakeTimers();
    const h = make({ expiresAt: new Date(Date.now() + 2000).toISOString() });
    await h.mount().ready;
    const fields = fillCapture(h, payloadFixture('login'));
    expect(h.win.document.querySelector('#vault-countdown')?.textContent).toContain('0:02');
    await vi.advanceTimersByTimeAsync(2250);
    for (const input of fields) { expect(input.value).toBe(''); expect(input.disabled).toBe(true); }
    expect(h.win.document.querySelector('#vault-status')?.textContent).toContain('expired');
    submit(h); await Promise.resolve(); expect(h.requests).toHaveLength(2);
  });

  it('drops an in-flight capture when pagehide happens during a challenge', async () => {
    let release: ((value: Response) => void) | undefined;
    const h = make({ onRequest: (request) => request.body.purpose === 'step_up' ? new Promise<Response>((resolve) => { release = resolve; }) : undefined });
    await h.mount().ready;
    fillCapture(h, payloadFixture('login')); submit(h);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    h.win.dispatchEvent(new h.win.Event('pagehide'));
    release!(response({ purpose: 'step_up', action: 'vault.captures.submit' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.requests.some((request) => request.operation === 'vault.captures.submit')).toBe(false);
  });

  it.each(['/vault/capture/nope', '/vault/capture/import/extra', '/vault/capture/', '/other/import'])(
    'makes no requests from invalid path %s', async (path) => {
      const h = make({ path }); await h.mount().ready;
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.win.document.body.textContent).toContain('Invalid link');
    },
  );

  it('makes no requests from a UUID link missing the fragment token', async () => {
    const h = make(); h.win.history.replaceState(null, '', h.win.location.pathname);
    await h.mount().ready;
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('has no card verification control and supports removable identity fields', async () => {
    const h = make({ itemType: 'card' }); await h.mount().ready;
    expect(h.win.document.querySelector('[name="cvv"], [name="cvc"], [name="securityCode"]')).toBeNull();
    const identity = make({ itemType: 'identity' }); await identity.mount().ready;
    const buttons = Array.from(identity.win.document.querySelectorAll('button'));
    buttons.find((button) => button.textContent === 'Add identity field')!.click();
    expect(identity.win.document.querySelectorAll('[data-identity-row]')).toHaveLength(2);
    const input = identity.win.document.querySelector<HTMLInputElement>('[data-identity-value]')!;
    input.value = 'synthetic-removal-canary';
    identity.win.document.querySelector<HTMLButtonElement>('[data-identity-row] button')!.click();
    expect(input.value).toBe('');
    expect(identity.win.document.querySelectorAll('[data-identity-row]')).toHaveLength(1);
  });
});
