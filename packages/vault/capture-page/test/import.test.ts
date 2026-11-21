import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { vaultStepUpBoundParams } from '../../../contract/src/vault.js';
import { assertNoCanaries, harness, leakageSinks, response, state, submit } from './page-harness.js';
import type { Harness } from './page-harness.js';

const pages: Harness[] = [];
const make = (options: Parameters<typeof harness>[0] = {}) => { const h = harness({ ...options, mode: 'import' }); pages.push(h); return h; };
afterEach(() => { for (const h of pages.splice(0)) h.close(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function begin(h: Harness, format?: string) {
  await h.mount().ready;
  if (format) h.win.document.querySelector<HTMLSelectElement>('[name="format"]')!.value = format;
  submit(h);
  await vi.waitFor(() => expect(h.win.document.querySelector('[name="export"]')).not.toBeNull());
}
function file(h: Harness, text: string) {
  const bytes = new TextEncoder().encode(text);
  const file = new h.win.File([bytes.buffer], 'synthetic-export.csv', { type: 'text/csv' });
  const read = vi.fn(async () => bytes.buffer);
  Object.defineProperty(file, 'arrayBuffer', { value: read });
  const input = h.win.document.querySelector<HTMLInputElement>('[name="export"]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  return { bytes, file, input, read };
}
async function upload(h: Harness, text = `synthetic export ${randomUUID()}`) {
  const selected = file(h, text);
  submit(h);
  await vi.waitFor(() => expect(h.win.document.querySelector('[data-import-index]')).not.toBeNull());
  return selected;
}

describe('import page', () => {
  it('begins with an optional format, seals locally, zeroes bytes, previews and commits exact rows', async () => {
    const h = make(); const sinks = leakageSinks(h);
    await begin(h, 'bitwarden_json');
    expect(h.requests.find((request) => request.operation === 'vault.imports.begin')?.body.format).toBe('bitwarden_json');
    const fileCanary = ['synthetic export', randomUUID(), ['gh', 'p_', 'B'.repeat(36)].join('')].join(',');
    const selected = await upload(h, fileCanary);
    expect(selected.read).toHaveBeenCalledTimes(1);
    expect(selected.bytes.every((byte) => byte === 0)).toBe(true);
    expect(selected.input.value).toBe('');
    const uploaded = h.requests.find((request) => request.operation === 'vault.imports.upload')!;
    const opened = h.broker.open(uploaded.body.sealed, h.importId, 8 * 1024 * 1024);
    try { expect(opened.toString()).toBe(fileCanary); } finally { opened.fill(0); }
    expect(() => h.broker.open(uploaded.body.sealed, h.captureId)).toThrow();
    expect(h.win.document.body.textContent).toContain('3 candidates · 1 skipped');
    expect(h.win.document.body.textContent).toContain('Duplicate of row 1');
    expect(h.win.document.body.textContent).toContain('encrypted notes');
    expect(h.win.document.body.textContent).toContain('rotate at the source');
    expect(h.win.document.body.textContent).toContain('Unknown exposure');
    const rows = Array.from(h.win.document.querySelectorAll<HTMLElement>('[data-import-index]'));
    expect(rows.map((row) => row.querySelector<HTMLInputElement>('[name="include"]')!.checked)).toEqual([true, false, false]);
    const name = `Metadata ${randomUUID()}`;
    const origin = `https://metadata-${randomUUID()}.example.com`;
    rows[0]!.querySelector<HTMLInputElement>('[name="overrideName"]')!.value = name;
    rows[2]!.querySelector<HTMLInputElement>('[name="overrideOrigin"]')!.value = origin;
    rows[2]!.querySelector<HTMLInputElement>('[name="include"]')!.checked = true;
    rows.forEach((row, index) => { row.querySelector<HTMLSelectElement>('[name="tier"]')!.value = ['a', 'b', 'c'][index]!; });
    const inputs = Array.from(h.win.document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select'));
    for (const input of inputs.filter((input) => input.name.startsWith('override'))) expect(input.type).toBe('text');
    submit(h); await state(h, 'imported');
    const challenge = h.requests.find((request) => request.body.purpose === 'step_up')!;
    const commit = h.requests.find((request) => request.operation === 'vault.imports.commit')!;
    expect(vaultStepUpBoundParams(challenge.body.pathParams, challenge.body.body)).toEqual(vaultStepUpBoundParams({ importId: h.importId }, commit.body));
    expect(commit.body.rows).toEqual([
      { index: 0, include: true, exposureTier: 'a', name },
      { index: 1, include: false, exposureTier: 'b' },
      { index: 2, include: true, exposureTier: 'c', originOverride: origin },
    ]);
    for (const request of h.requests) {
      expect(request.url).not.toContain(name); expect(request.url).not.toContain(origin);
      if (request !== challenge && request !== commit) { expect(JSON.stringify(request.body)).not.toContain(name); expect(JSON.stringify(request.body)).not.toContain(origin); }
    }
    for (const input of inputs) expect(input.value).toBe('');
    assertNoCanaries(h.requests, { body: fileCanary });
    sinks.assertClean();
    expect(h.win.document.body.textContent).toContain('Delete the source export');
    expect(h.win.document.body.textContent).not.toContain(name);
    expect(h.win.document.body.textContent).not.toContain(origin);
  });

  it('detects an export format when no override is provided', async () => {
    const h = make(); await begin(h);
    expect(h.requests.find((request) => request.operation === 'vault.imports.begin')?.body).not.toHaveProperty('format');
  });

  it('rejects a file whose ciphertext plus tag exceeds the advertised cap without reading it', async () => {
    const h = make({ maxCiphertextBytes: 64 }); await begin(h);
    const selected = file(h, 'x'.repeat(49)); submit(h); await state(h, 'error');
    expect(selected.read).not.toHaveBeenCalled();
    expect(h.requests.some((request) => request.operation === 'vault.imports.upload')).toBe(false);
    expect(selected.input.value).toBe('');
    expect(h.win.document.querySelector<HTMLButtonElement>('[data-cancel]')?.disabled).toBe(false);
  });

  it('enforces the 8 MiB cap even if the broker advertises a larger maximum', async () => {
    const h = make({ maxCiphertextBytes: 16 * 1024 * 1024 }); await begin(h);
    const selected = file(h, 'synthetic');
    Object.defineProperty(selected.file, 'size', { value: 8 * 1024 * 1024 - 15 });
    submit(h); await state(h, 'error'); expect(selected.read).not.toHaveBeenCalled();
  });

  it('checks the actual read size and zeroes bytes even on size failure', async () => {
    const h = make({ maxCiphertextBytes: 64 }); await begin(h);
    const selected = file(h, 'x'.repeat(49)); Object.defineProperty(selected.file, 'size', { value: 1 });
    submit(h); await state(h, 'error');
    expect(selected.bytes.every((byte) => byte === 0)).toBe(true);
    expect(h.requests.some((request) => request.operation === 'vault.imports.upload')).toBe(false);
  });

  it('zeroes file bytes before upload and on a failed upload', async () => {
    let fileBytes: Uint8Array | undefined;
    const h = make({
      fail: 'vault.imports.upload', reason: 'capture_key_rotated',
      onRequest: (request) => {
        if (request.operation === 'vault.imports.upload') expect(fileBytes?.every((byte) => byte === 0)).toBe(true);
        return undefined;
      },
    });
    await begin(h);
    const selected = file(h, `private file ${randomUUID()}`); fileBytes = selected.bytes;
    submit(h); await state(h, 'error');
    expect(selected.bytes.every((byte) => byte === 0)).toBe(true);
    expect(selected.input.value).toBe('');
    expect(h.win.document.body.textContent).toContain('Ask for a new link');
  });

  it('clears override fields on a commit error and keeps cancel available', async () => {
    const h = make({ fail: 'vault.imports.commit', reason: 'secret_in_metadata' });
    const sinks = leakageSinks(h); await begin(h); await upload(h);
    const input = h.win.document.querySelector<HTMLInputElement>('[name="overrideName"]')!;
    input.value = `test-only-${randomUUID()}`;
    submit(h); await state(h, 'error');
    expect(input.value).toBe('');
    expect(h.win.document.body.textContent).toContain('stored as plain metadata');
    expect(h.win.document.querySelector<HTMLButtonElement>('[data-cancel]')?.disabled).toBe(false);
    sinks.assertClean();
  });

  it('cancels an import from the file screen', async () => {
    const h = make(); await begin(h);
    h.win.document.querySelector<HTMLButtonElement>('[data-cancel]')!.click(); await state(h, 'cancelled');
    expect(h.requests.at(-1)?.operation).toBe('vault.imports.cancel');
  });

  it('offers cancel after expiry and still calls the cancel operation', async () => {
    vi.useFakeTimers();
    const h = make({ expiresAt: new Date(Date.now() + 2000).toISOString() });
    const page = h.mount(); await page.ready; submit(h);
    await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(10);
    expect(h.win.document.querySelector('[name="export"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2250);
    expect(h.win.document.querySelector<HTMLInputElement>('[name="export"]')?.disabled).toBe(true);
    const cancel = h.win.document.querySelector<HTMLButtonElement>('[data-cancel]')!;
    expect(cancel.disabled).toBe(false); cancel.click();
    await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(10);
    expect(h.requests.at(-1)?.operation).toBe('vault.imports.cancel');
  });

  it('zeroes a pending file read after pagehide and sends no upload', async () => {
    const h = make(); await begin(h);
    const selected = file(h, `delayed ${randomUUID()}`);
    let release: ((buffer: ArrayBuffer) => void) | undefined;
    selected.read.mockImplementation(() => new Promise<ArrayBuffer>((resolve) => { release = resolve; }));
    submit(h); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    h.win.dispatchEvent(new h.win.Event('pagehide'));
    release!(selected.bytes.buffer);
    await vi.waitFor(() => expect(selected.bytes.every((byte) => byte === 0)).toBe(true));
    expect(h.requests.some((request) => request.operation === 'vault.imports.upload')).toBe(false);
  });

  it('cancels during an upload and ignores its eventual preview', async () => {
    let release: ((value: Response) => void) | undefined;
    const h = make({ onRequest: (request) => request.operation === 'vault.imports.upload' ? new Promise<Response>((resolve) => { release = resolve; }) : undefined });
    await begin(h); file(h, `pending ${randomUUID()}`); submit(h);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    h.win.document.querySelector<HTMLButtonElement>('[data-cancel]')!.click(); await state(h, 'cancelled');
    release!(response({ importId: h.importId, candidates: [], skipped: [], expiresAt: new Date(Date.now() + 10000).toISOString() }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.win.document.querySelector<HTMLElement>('#vault-page')?.dataset.state).toBe('cancelled');
    expect(h.requests.some((request) => request.operation === 'vault.imports.commit')).toBe(false);
  });

  it('cancels a session whose begin response arrives after cancellation', async () => {
    let release: ((value: Response) => void) | undefined;
    const h = make({ onRequest: (request) => request.operation === 'vault.imports.begin' ? new Promise<Response>((resolve) => { release = resolve; }) : undefined });
    await h.mount().ready; submit(h);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    h.win.document.querySelector<HTMLButtonElement>('[data-cancel]')!.click(); await state(h, 'cancelled');
    release!(response({ importId: h.importId, expiresAt: new Date(Date.now() + 10000).toISOString(), publicKey: h.broker.publicKey(), maxCiphertextBytes: 8 * 1024 * 1024 }));
    await vi.waitFor(() => expect(h.requests.at(-1)?.operation).toBe('vault.imports.cancel'));
    expect(h.win.document.querySelector<HTMLElement>('#vault-page')?.dataset.state).toBe('cancelled');
  });

  it('aborts a pending authenticator when the owner cancels the import', async () => {
    const h = make(); await begin(h); await upload(h);
    let signal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    h.credentials.get.mockImplementation((options: CredentialRequestOptions) => new Promise((_resolve, reject) => {
      signal = options.signal;
      release = () => reject(new Error('Synthetic authenticator cancellation'));
    }));
    submit(h); await vi.waitFor(() => expect(signal).toBeDefined());
    h.win.document.querySelector<HTMLButtonElement>('[data-cancel]')!.click(); await state(h, 'cancelled');
    expect(signal!.aborted).toBe(true); release!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.requests.some((request) => request.operation === 'vault.imports.commit')).toBe(false);
    expect(h.win.document.querySelector<HTMLElement>('#vault-page')?.dataset.state).toBe('cancelled');
  });
});
