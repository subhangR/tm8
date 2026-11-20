import { VaultApi } from './api.js';
import {
  IMPORT_FORMATS, VAULT_IMPORT_PAGE_PATH, VAULT_MAX_CAPTURE_CIPHERTEXT, VAULT_MAX_IMPORT_CIPHERTEXT,
} from './contract.js';
import type {
  CaptureOpen, Challenge, ExposureTier, ImportFormat, ImportPreview, ImportResult, ImportRow,
  ImportSession, ItemType, VaultStatus,
} from './contract.js';
import type { Bytes } from './encoding.js';
import { errorCopy, PageError } from './errors.js';
import { buildPayload, CAPTURE_FIELDS } from './payload.js';
import type { Field } from './payload.js';
import { webCryptoSeal } from './seal.js';
import { tm8Authorization } from './tm8-auth.js';
import { getAssertion, stepUp } from './webauthn.js';

type PageWindow = Window & typeof globalThis;
type Mode = { kind: 'capture'; captureId: string } | { kind: 'import' } | { kind: 'invalid' };
export function pageMode(pathname: string): Mode {
  if (pathname === VAULT_IMPORT_PAGE_PATH) return { kind: 'import' };
  const match = /^\/vault\/capture\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(pathname);
  return match?.[1] ? { kind: 'capture', captureId: match[1] } : { kind: 'invalid' };
}
export interface PageDependencies {
  fetch?: typeof globalThis.fetch;
  authorization?: () => string | null;
  crypto?: Crypto;
  credentials?: Pick<CredentialsContainer, 'get'>;
}

/** Each mounted page owns its token, fields, buffers, timer and abort signal. */
export class CapturePage {
  readonly ready: Promise<void>;
  private readonly root: HTMLElement;
  private readonly api: VaultApi;
  private readonly crypto: Crypto;
  private readonly credentials: Pick<CredentialsContainer, 'get'>;
  private readonly abort: AbortController;
  private credentialAbort: AbortController | null = null;
  private readonly mode: Mode;
  private token: string | null = null;
  private capture: CaptureOpen | null = null;
  private importSession: ImportSession | null = null;
  private status: VaultStatus | null = null;
  private readonly buffers = new Set<Bytes>();
  private timer: number | undefined;
  private expires = Infinity;
  private busy = false;
  private disposed = false;
  private expired = false;
  private epoch = 0;
  private sequence = 0;

  constructor(private readonly win: PageWindow, dependencies: PageDependencies = {}) {
    // Strip the fragment synchronously, before auth reads or a single fetch.
    const fragment = new URLSearchParams(win.location.hash.slice(1));
    const tokens = fragment.getAll('t');
    this.mode = pageMode(win.location.pathname);
    if (this.mode.kind === 'capture' && tokens.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(tokens[0] ?? '')) this.token = tokens[0] ?? null;
    win.history.replaceState(null, '', win.location.pathname);
    fragment.delete('t');
    tokens.fill('');
    this.root = win.document.getElementById('vault-page') ?? win.document.body;
    this.crypto = dependencies.crypto ?? win.crypto;
    this.credentials = dependencies.credentials ?? win.navigator.credentials;
    this.abort = new win.AbortController();
    this.api = new VaultApi(dependencies.fetch ?? win.fetch.bind(win), dependencies.authorization ?? tm8Authorization, this.crypto, this.abort.signal);
    win.addEventListener('pagehide', this.onPageHide);
    this.ready = this.start().catch((error: unknown) => {
      if (!this.disposed) { this.clear(); this.token = null; this.shell('Unable to open vault'); this.message(errorCopy(error), true); }
    });
  }

  private onPageHide = (): void => { this.dispose(); };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    this.abort.abort();
    this.credentialAbort?.abort();
    this.stopTimer();
    this.clear();
    this.token = null;
    this.capture = null;
    this.importSession = null;
    this.status = null;
    this.disable(true);
    this.win.removeEventListener('pagehide', this.onPageHide);
  }

  private clear(): void {
    for (const field of this.root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')) {
      field.value = '';
      if (field instanceof this.win.HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio')) field.checked = false;
      if (field instanceof this.win.HTMLSelectElement) field.selectedIndex = -1;
    }
    for (const bytes of this.buffers) bytes.fill(0);
    this.buffers.clear();
  }

  private disable(disabled: boolean): void {
    for (const field of this.root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('input, textarea, select, button')) {
      // Cancel stays available while an import is in flight or expired.
      field.disabled = field.dataset.cancel === 'true' ? this.disposed : disabled;
    }
  }

  private assertActive(epoch = this.epoch): void {
    if (this.disposed || epoch !== this.epoch) throw new PageError('failed');
    if (this.expired || Date.now() >= this.expires) throw new PageError('expired');
  }

  private async credentialCeremony<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new this.win.AbortController();
    this.credentialAbort?.abort();
    this.credentialAbort = controller;
    const abort = (): void => { controller.abort(); };
    this.abort.signal.addEventListener('abort', abort, { once: true });
    try { return await action(controller.signal); }
    finally {
      this.abort.signal.removeEventListener('abort', abort);
      if (this.credentialAbort === controller) this.credentialAbort = null;
    }
  }

  private element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const node = this.win.document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  private shell(title: string, description?: string): void {
    this.clear();
    this.root.replaceChildren(this.element('h1', title));
    this.root.removeAttribute('aria-busy');
    this.root.dataset.state = 'ready';
    if (description) { const p = this.element('p', description); p.className = 'description'; this.root.append(p); }
    if (this.status?.testSecretsOnly) {
      const p = this.element('p', 'Test items only. This vault is awaiting independent security review.');
      p.className = 'notice'; this.root.append(p);
    }
    const message = this.element('p');
    message.className = 'status'; message.id = 'vault-status'; message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    this.root.append(message);
  }

  private message(copy: string, error = false): void {
    const node = this.root.querySelector<HTMLElement>('#vault-status');
    if (node) { node.textContent = copy; node.dataset.error = String(error); }
    this.root.dataset.state = error ? 'error' : 'ready';
  }

  private button(copy: string, action?: () => void, secondary = false): HTMLButtonElement {
    const button = this.element('button', copy);
    button.type = action ? 'button' : 'submit';
    if (secondary) button.className = 'secondary';
    if (action) button.addEventListener('click', action);
    return button;
  }

  private field(field: Field, parent: HTMLElement): HTMLInputElement | HTMLTextAreaElement {
    const label = this.element('label', field.label); label.className = 'field';
    const input = field.kind === 'textarea' ? this.element('textarea') : this.element('input');
    if (input instanceof this.win.HTMLInputElement) input.type = field.kind === 'textarea' ? 'text' : field.kind ?? 'text';
    input.name = field.key;
    input.id = `vault-field-${this.sequence++}`;
    input.autocomplete = field.kind === 'password' ? 'new-password' : 'off';
    input.spellcheck = false;
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('autocapitalize', 'off');
    input.required = field.required === true;
    input.maxLength = field.max;
    if (input instanceof this.win.HTMLInputElement) {
      if (field.kind === 'number') { input.min = String(field.min ?? 0); input.max = String(field.upper ?? field.max); input.step = '1'; }
      else if (field.min !== undefined) input.minLength = field.min;
      if (field.pattern) input.pattern = field.pattern;
    }
    label.append(input); parent.append(label);
    return input;
  }

  private form(submit: (form: HTMLFormElement, epoch: number) => Promise<void>): HTMLFormElement {
    const form = this.element('form');
    form.autocomplete = 'off';
    form.noValidate = true;
    form.addEventListener('submit', (event) => { event.preventDefault(); void this.run((epoch) => submit(form, epoch)); });
    this.root.append(form);
    return form;
  }

  private async run(action: (epoch: number) => Promise<void>): Promise<void> {
    if (this.busy || this.disposed || this.expired) return;
    const epoch = this.epoch;
    this.busy = true; this.disable(true); this.message('Working securely…');
    try { this.assertActive(epoch); await action(epoch); }
    catch (error) {
      if (!this.disposed && epoch === this.epoch) { this.clear(); this.message(errorCopy(error), true); }
    } finally {
      if (!this.disposed && epoch === this.epoch) { this.busy = false; this.disable(this.expired); }
    }
  }

  private async start(): Promise<void> {
    if (this.mode.kind === 'invalid' || (this.mode.kind === 'capture' && !this.token)) throw new PageError('invalid_link');
    this.status = await this.api.call<VaultStatus>('vault.status');
    this.assertActive();
    if (this.status.mode === 'off') throw new PageError('vault_disabled');
    if (!this.status.features[this.mode.kind === 'import' ? 'import' : 'capture']) throw new PageError(this.mode.kind === 'import' ? 'import_disabled' : 'vault_disabled');
    if (!this.status.viewer.vaultSession || Date.parse(this.status.viewer.vaultSession.expiresAt) <= Date.now()) {
      this.shell('Verify it’s you', 'Use your vault passkey to continue.');
      this.root.append(this.button('Sign in with a passkey', () => { void this.run(async (epoch) => {
        const challenge = await this.api.call<Challenge>('vault.webauthn.challenge', {}, { ...this.api.command(), purpose: 'sign_in' });
        this.assertActive(epoch);
        if (challenge.purpose !== 'sign_in') throw new PageError('passkey_failed');
        const assertion = await this.credentialCeremony((signal) => getAssertion(challenge, this.credentials, signal));
        this.assertActive(epoch);
        await this.api.call('vault.session.begin', {}, { ...this.api.command(), challengeId: challenge.challengeId, assertion });
        this.assertActive(epoch);
        await this.openMode(epoch);
      }); }));
    } else { await this.openMode(this.epoch); }
  }

  private async openMode(epoch: number): Promise<void> {
    if (this.mode.kind === 'capture') {
      this.capture = await this.api.call<CaptureOpen>('vault.captures.open', { captureId: this.mode.captureId }, { ...this.api.command(), linkToken: this.token });
      this.assertActive(epoch);
      if (this.capture.captureId !== this.mode.captureId || !Object.hasOwn(CAPTURE_FIELDS, this.capture.itemType)) throw new PageError('invalid_link');
      this.renderCapture(this.capture);
      this.countdown(this.capture.expiresAt);
    } else { this.renderImportStart(); }
  }

  private countdown(expiresAt: string): void {
    this.stopTimer();
    this.expires = Date.parse(expiresAt);
    if (!Number.isFinite(this.expires)) throw new PageError('expired');
    const node = this.element('p'); node.className = 'countdown'; node.id = 'vault-countdown';
    this.root.append(node);
    const update = (): void => {
      const seconds = Math.max(0, Math.ceil((this.expires - Date.now()) / 1000));
      node.textContent = `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      if (!seconds) {
        this.expired = true; this.epoch += 1; this.credentialAbort?.abort(); this.clear(); this.token = null;
        this.disable(true); this.message(errorCopy(new PageError('expired')), true); this.stopTimer();
      }
    };
    update();
    if (!this.expired) this.timer = this.win.setInterval(update, 250);
  }

  private stopTimer(): void { if (this.timer !== undefined) this.win.clearInterval(this.timer); this.timer = undefined; }

  private renderCapture(capture: CaptureOpen): void {
    this.shell(capture.purpose === 'replace' ? 'Replace an item' : 'Store an item', 'Enter the value here. After storing it, only its name and other metadata can be shown.');
    const form = this.form(async (current, epoch) => {
      let bytes: Bytes | undefined;
      try {
        bytes = new TextEncoder().encode(JSON.stringify(buildPayload(current, capture.itemType)));
        this.buffers.add(bytes);
        this.clearFields();
        const sealed = await webCryptoSeal(bytes, capture.publicKey, capture.captureId, this.crypto, Math.min(capture.maxCiphertextBytes, VAULT_MAX_CAPTURE_CIPHERTEXT));
        bytes.fill(0); this.buffers.delete(bytes); bytes = undefined;
        this.assertActive(epoch);
        if (!this.token) throw new PageError('invalid_link');
        const path = { captureId: capture.captureId };
        const body = { ...this.api.command(), linkToken: this.token, sealed };
        const proof = await this.credentialCeremony((signal) => stepUp(this.api, this.credentials, signal, 'vault.captures.submit', path, body, () => this.assertActive(epoch)));
        this.assertActive(epoch);
        const result = await this.api.call<{ name: string }>('vault.captures.submit', path, { ...body, stepUp: proof });
        this.assertActive(epoch);
        this.token = null; this.capture = null; this.stopTimer();
        this.shell('Stored');
        this.root.append(this.element('p', result.name));
        this.root.dataset.state = 'stored';
      } finally { bytes?.fill(0); if (bytes) this.buffers.delete(bytes); this.clearFields(current); }
    });
    for (const field of CAPTURE_FIELDS[capture.itemType]) this.field(field, form);
    const name = form.elements.namedItem('name') as HTMLInputElement | null;
    if (name && capture.itemName) name.value = capture.itemName;
    if (capture.itemType === 'card') form.append(this.element('p', 'Card number and expiry only. Never enter a card verification code.'));
    if (capture.itemType === 'identity') this.identityFields(form);
    form.append(this.button('Encrypt and store'));
  }

  private clearFields(container: ParentNode = this.root): void {
    // Unlike clear(), this leaves an active crypto operation's bytes intact.
    for (const field of container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')) {
      field.value = '';
      if (field instanceof this.win.HTMLInputElement && field.type === 'checkbox') field.checked = false;
      if (field instanceof this.win.HTMLSelectElement) field.selectedIndex = -1;
    }
  }

  private identityFields(form: HTMLFormElement): void {
    const container = this.element('div');
    const add = (): void => {
      if (container.children.length >= 50) return;
      const row = this.element('fieldset'); row.dataset.identityRow = 'true'; row.className = 'identity-row';
      row.append(this.element('legend', `Identity field ${container.children.length + 1}`));
      this.field({ key: `identityKey${this.sequence}`, label: 'Field name', required: true, max: 64 }, row).dataset.identityKey = 'true';
      this.field({ key: `identityValue${this.sequence}`, label: 'Field value', kind: 'password', max: 4096 }, row).dataset.identityValue = 'true';
      row.append(this.button('Remove field', () => {
        for (const input of row.querySelectorAll('input')) input.value = '';
        row.remove();
      }, true));
      container.append(row);
    };
    form.append(container); add(); form.append(this.button('Add identity field', add, true));
  }

  private renderImportStart(): void {
    this.shell('Import into your vault', 'Choose a browser or password manager export. The file is encrypted locally before upload.');
    const form = this.form(async (current, epoch) => {
      const value = (current.elements.namedItem('format') as HTMLSelectElement).value;
      const format = IMPORT_FORMATS.includes(value as ImportFormat) ? value as ImportFormat : undefined;
      this.clearFields();
      const session = await this.api.call<ImportSession>('vault.imports.begin', {}, { ...this.api.command(), ...(format ? { format } : {}) });
      // Cancel may arrive while begin is pending. Revoke the new empty session
      // as soon as its id becomes known, without reopening the cancelled UI.
      if (!this.disposed && epoch !== this.epoch) {
        await this.api.call('vault.imports.cancel', { importId: session.importId }, this.api.command());
        return;
      }
      this.assertActive(epoch); this.importSession = session;
      this.renderImportFile(session); this.countdown(session.expiresAt);
    });
    const label = this.element('label', 'Export format'); label.className = 'field';
    const select = this.element('select'); select.name = 'format'; select.autocomplete = 'off'; select.setAttribute('spellcheck', 'false');
    const auto = this.element('option', 'Detect automatically'); auto.value = ''; select.append(auto);
    for (const format of IMPORT_FORMATS) { const option = this.element('option', format.replaceAll('_', ' ')); option.value = format; select.append(option); }
    label.append(select); form.append(label, this.button('Start import'));
    this.cancelButton(form);
  }

  private renderImportFile(session: ImportSession): void {
    this.shell('Choose your export', 'The export is plaintext on your device. Keep it private and delete the source copy after import.');
    const form = this.form(async (current, epoch) => {
      const input = current.elements.namedItem('export') as HTMLInputElement;
      const file = input.files?.[0];
      const max = Math.min(session.maxCiphertextBytes, VAULT_MAX_IMPORT_CIPHERTEXT);
      if (!file) throw new PageError('invalid_payload');
      if (file.size < 1 || file.size + 16 > max) throw new PageError('too_large');
      this.clearFields();
      let bytes: Bytes | undefined;
      try {
        bytes = new Uint8Array(await this.readFile(file));
        this.buffers.add(bytes); this.assertActive(epoch);
        if (bytes.length + 16 > max) throw new PageError('too_large');
        const sealed = await webCryptoSeal(bytes, session.publicKey, session.importId, this.crypto, max);
        bytes.fill(0); this.buffers.delete(bytes); bytes = undefined;
        this.assertActive(epoch);
        const preview = await this.api.call<ImportPreview>('vault.imports.upload', { importId: session.importId }, { ...this.api.command(), sealed });
        this.assertActive(epoch);
        if (preview.importId !== session.importId) throw new PageError('failed');
        this.renderPreview(preview); this.countdown(preview.expiresAt);
      } finally { bytes?.fill(0); if (bytes) this.buffers.delete(bytes); this.clearFields(current); }
    });
    const label = this.element('label', 'Export file'); label.className = 'field';
    const input = this.element('input'); input.type = 'file'; input.name = 'export'; input.accept = '.csv,.json,text/csv,application/json'; input.autocomplete = 'off'; input.setAttribute('spellcheck', 'false');
    label.append(input); form.append(label, this.button('Encrypt and preview'));
    this.cancelButton(form);
  }

  private async readFile(file: File): Promise<ArrayBuffer> {
    if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new this.win.FileReader();
      const abort = (): void => { reader.abort(); reject(new PageError('failed')); };
      this.abort.signal.addEventListener('abort', abort, { once: true });
      reader.onload = () => {
        this.abort.signal.removeEventListener('abort', abort);
        if (reader.result instanceof this.win.ArrayBuffer) resolve(reader.result);
        else reject(new PageError('failed'));
      };
      reader.onerror = reader.onabort = () => { this.abort.signal.removeEventListener('abort', abort); reject(new PageError('failed')); };
      if (this.abort.signal.aborted) abort(); else reader.readAsArrayBuffer(file);
    });
  }

  private renderPreview(preview: ImportPreview): void {
    this.shell('Review your import', `${preview.candidates.length} candidates · ${preview.skipped.length} skipped`);
    this.root.append(
      this.element('p', 'a · Confirmed exposed: rotate at the source. Imported items stay blocked until rotated.'),
      this.element('p', 'b · Plaintext under your control: import, then schedule rotation.'),
      this.element('p', 'c · Unknown exposure: treated as b and noted in the audit.'),
      this.element('p', 'Names and origin overrides are metadata. Never enter a secret in these fields.'),
    );
    const form = this.form(async (current, epoch) => {
      const rows = this.importRows(current);
      const session = this.importSession;
      if (!session || !rows.length || rows.length > 5000) throw new PageError('invalid_payload');
      const path = { importId: session.importId };
      const body = { ...this.api.command(), rows };
      this.clearFields();
      const proof = await this.credentialCeremony((signal) => stepUp(this.api, this.credentials, signal, 'vault.imports.commit', path, body, () => this.assertActive(epoch)));
      this.assertActive(epoch);
      const result = await this.api.call<ImportResult>('vault.imports.commit', path, { ...body, stepUp: proof });
      this.assertActive(epoch);
      this.stopTimer(); this.importSession = null;
      this.shell('Import complete', `${result.created.length} stored · ${result.skipped.length} skipped`);
      if (result.deleteSourceAdvice) this.root.append(this.element('p', 'Delete the source export from your device. Export files are plaintext. Deletion may leave copies; rotate exposed credentials at the source.'));
      this.root.dataset.state = 'imported';
    });
    for (const candidate of preview.candidates) {
      const row = this.element('fieldset'); row.dataset.importIndex = String(candidate.index);
      row.append(this.element('legend', candidate.name));
      const metadata = this.element('p', `${candidate.type}${candidate.origin ? ` · ${candidate.origin}` : ''}${candidate.username ? ` · ${candidate.username}` : ''}`); metadata.className = 'metadata'; row.append(metadata);
      if (candidate.duplicateOf !== null) row.append(this.element('p', `Duplicate of row ${candidate.duplicateOf + 1}. Excluded by default.`));
      if (candidate.originError) row.append(this.element('p', 'Origin refused. Supply an exact HTTPS origin before including this row.'));
      for (const warning of candidate.warnings) row.append(this.element('p', warningCopy(warning)));
      const label = this.element('label', 'Include'); label.className = 'include-label';
      const include = this.element('input'); include.type = 'checkbox'; include.name = 'include'; include.checked = candidate.duplicateOf === null && !candidate.originError; include.autocomplete = 'off'; include.setAttribute('spellcheck', 'false'); label.prepend(include); row.append(label);
      const tierLabel = this.element('label', 'Exposure tier'); tierLabel.className = 'field';
      const tier = this.element('select'); tier.name = 'tier'; tier.autocomplete = 'off'; tier.setAttribute('spellcheck', 'false');
      for (const value of ['a', 'b', 'c']) { const option = this.element('option', value); option.value = value; tier.append(option); }
      tier.value = 'b'; tierLabel.append(tier); row.append(tierLabel);
      this.field({ key: 'overrideName', label: 'Name override (metadata only, optional)', max: 200 }, row);
      this.field({ key: 'overrideOrigin', label: 'Origin override (metadata only, optional)', max: 2048 }, row);
      form.append(row);
    }
    if (preview.skipped.length) {
      const list = this.element('ul');
      for (const item of preview.skipped) list.append(this.element('li', `Row ${item.index + 1}: ${warningCopy(item.reason)}`));
      this.root.append(list);
    }
    if (preview.candidates.length) form.append(this.button('Verify and import'));
    this.cancelButton(form);
  }

  private importRows(form: HTMLFormElement): ImportRow[] {
    return Array.from(form.querySelectorAll<HTMLElement>('[data-import-index]'), (row) => {
      const include = row.querySelector<HTMLInputElement>('[name="include"]')?.checked === true;
      const exposureTier = row.querySelector<HTMLSelectElement>('[name="tier"]')?.value ?? '';
      const name = row.querySelector<HTMLInputElement>('[name="overrideName"]')?.value ?? '';
      const originOverride = row.querySelector<HTMLInputElement>('[name="overrideOrigin"]')?.value ?? '';
      if (!['a', 'b', 'c'].includes(exposureTier) || name.length > 200 || (name && name.trim() !== name) || originOverride.length > 2048) throw new PageError('invalid_payload');
      return {
        index: Number(row.dataset.importIndex), include, exposureTier: exposureTier as ExposureTier,
        ...(name ? { name } : {}), ...(originOverride ? { originOverride } : {}),
      };
    });
  }

  private cancelButton(parent: HTMLElement): void {
    const button = this.button('Cancel import', () => { void this.cancelImport(); }, true);
    button.dataset.cancel = 'true'; parent.append(button);
  }

  private async cancelImport(): Promise<void> {
    if (this.disposed) return;
    this.credentialAbort?.abort();
    this.epoch += 1; const epoch = this.epoch;
    this.clear(); this.disable(true); this.busy = true;
    try {
      if (this.importSession) await this.api.call('vault.imports.cancel', { importId: this.importSession.importId }, this.api.command());
      if (this.disposed || epoch !== this.epoch) return;
      this.stopTimer(); this.importSession = null;
      this.shell('Import cancelled'); this.root.dataset.state = 'cancelled';
    } catch (error) {
      if (!this.disposed && epoch === this.epoch) { this.clear(); this.message(errorCopy(error), true); }
    } finally { if (!this.disposed && epoch === this.epoch) { this.busy = false; this.disable(this.expired); } }
  }
}

function warningCopy(code: string): string {
  const warnings: Record<string, string> = {
    http_origin: 'The source origin uses HTTP. Choose an exact HTTPS origin.',
    notes_present: 'This item includes encrypted notes.',
    cvv_column_dropped: 'Card verification codes were discarded.',
    duplicate: 'Duplicate item.',
    invalid_origin: 'The source origin was refused.',
    missing_password: 'No password was found.',
    unsupported_type: 'This item type is not supported for import.',
    empty_row: 'This row was empty.',
  };
  return Object.hasOwn(warnings, code) ? warnings[code] ?? 'Review this item.' : 'Review this item.';
}

export function mountCapturePage(win: PageWindow, dependencies: PageDependencies = {}): CapturePage {
  return new CapturePage(win, dependencies);
}
