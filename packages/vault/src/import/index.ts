import { CapturePayloadSchema, type CapturePayload } from '../capture/payload.js';
import { MAX_IMPORT_CIPHERTEXT } from '../capture/seal.js';
import { normalizeOrigin, OriginRefusal } from '../origin/normalize.js';
import type { ImportCandidate, ImportFormat, ImportParser, ImportParseResult } from '../types.js';
import { readCsv } from './csv.js';
import { previewGuard } from './preview.js';

export type ImportRefusalCode = 'too_large' | 'too_many_rows' | 'field_too_large'
  | 'malformed_csv' | 'invalid_json' | 'invalid_encoding' | 'unsupported_format'
  | 'invalid_header' | 'encrypted_export';

export class ImportParseError extends Error {
  constructor(readonly code: ImportRefusalCode) {
    super(`import refused: ${code}`);
    this.name = 'ImportParseError';
  }
}

function refuse(code: ImportRefusalCode): never { throw new ImportParseError(code); }
const normalized = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const FORMATS: readonly ImportFormat[] = ['chrome_csv', 'firefox_csv', 'safari_csv', 'bitwarden_csv', 'bitwarden_json', 'onepassword_csv', 'generic_csv'];
const CVV = /^(?:code|cvv2?|cvc2?|csc|cid|cav2|cvn|cardverification(?:value|code)?|securitycode|cardcode)$/;

type Row = {
  index: number; type: 'login' | 'note' | 'card' | 'identity' | 'unknown';
  name: string; url: string; username: string; password: string; notes: string; totp: string;
  pan: string; cardholder: string; month: string; year: string; cvv: boolean;
};

function detect(headers: string[]): ImportFormat {
  const has = (...fields: string[]) => fields.every((field) => headers.includes(normalized(field)));
  if (has('folder', 'type', 'login_uri', 'login_password')) return 'bitwarden_csv';
  if (has('httpRealm', 'formActionOrigin', 'guid', 'timePasswordChanged')) return 'firefox_csv';
  if (has('Title', 'Url', 'Favorite', 'Archived', 'Tags')) return 'onepassword_csv';
  if (has('Title', 'URL', 'Username', 'Password', 'Notes', 'OTPAuth')) return 'safari_csv';
  if (has('name', 'url', 'username', 'password')) return 'chrome_csv';
  return 'generic_csv';
}

function csvRows(text: string, hint?: ImportFormat): { format: ImportFormat; rows: Row[]; skipped: ImportParseResult['skipped'] } {
  const parsed = readCsv(text, refuse);
  const header = parsed.shift();
  if (!header || header.length === 0) refuse('unsupported_format');
  const headers = header.map(normalized);
  if (headers.some((key) => key === '') || new Set(headers).size !== headers.length) refuse('invalid_header');
  const format = hint ?? detect(headers);
  const find = (...aliases: string[]) => {
    for (const alias of aliases) { const index = headers.indexOf(normalized(alias)); if (index !== -1) return index; }
    return -1;
  };
  const columns = {
    name: find('name', 'title', 'account', 'label'), url: find('url', 'website', 'uri', 'login_uri', 'login_url', 'website_url', 'site'),
    username: find('username', 'user_name', 'user', 'login_username', 'email', 'login'),
    password: find('password', 'pass', 'passwd', 'pwd', 'login_password'), notes: find('notes', 'note', 'comments', 'body', 'extra'),
    totp: find('totp', 'otpauth', 'otp', 'login_totp', 'totp_secret', 'one_time_password'), type: find('type', 'item_type'),
    pan: find('pan', 'card_number', 'number', 'cc_number', 'card.number'), cardholder: find('cardholder', 'cardholder_name', 'name_on_card'),
    month: find('exp_month', 'expiry_month', 'expiration_month', 'card.expMonth'), year: find('exp_year', 'expiry_year', 'expiration_year', 'card.expYear'),
  };
  if (columns.password === -1 && columns.notes === -1 && columns.pan === -1) refuse('unsupported_format');
  const cvv = headers.some((name) => CVV.test(name) || CVV.test(name.replace(/^card/, '')));
  const rows: Row[] = [];
  const skipped: ImportParseResult['skipped'] = [];
  parsed.forEach((fields, index) => {
    if (fields.length !== headers.length) { skipped.push({ index, reason: 'ragged_row' }); return; }
    const get = (name: keyof typeof columns) => fields[columns[name]] ?? '';
    const kind = get('type').trim().toLowerCase();
    const type = kind === '2' || ['note', 'securenote', 'secure_note'].includes(kind) ? 'note'
      : kind === '3' || kind === 'card' ? 'card' : kind === '4' || kind === 'identity' ? 'identity'
        : kind === '' || kind === '1' || kind === 'login' ? 'login' : 'unknown';
    rows.push({ index, type, name: get('name'), url: get('url'), username: get('username'), password: get('password'),
      notes: get('notes'), totp: get('totp'), pan: get('pan'), cardholder: get('cardholder'), month: get('month'), year: get('year'), cvv });
  });
  return { format, rows, skipped };
}

function checkJsonFields(root: unknown): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') { if (Buffer.byteLength(value, 'utf8') > 65536) refuse('field_too_large'); }
    else if (Array.isArray(value)) { for (const child of value) stack.push(child); }
    else if (object(value)) {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (Buffer.byteLength(key, 'utf8') > 65536) refuse('field_too_large');
        stack.push(child);
      }
    }
  }
}

function jsonRows(text: string): { format: 'bitwarden_json'; rows: Row[]; skipped: ImportParseResult['skipped'] } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { refuse('invalid_json'); }
  const root = object(raw);
  if (!root) refuse('unsupported_format');
  if (root.encrypted === true) refuse('encrypted_export');
  if (!Array.isArray(root.items)) refuse('unsupported_format');
  if (root.items.length > 10000) refuse('too_many_rows');
  checkJsonFields(root);
  const rows: Row[] = [];
  const skipped: ImportParseResult['skipped'] = [];
  root.items.forEach((value: unknown, index: number) => {
    const item = object(value);
    if (!item) { skipped.push({ index, reason: 'invalid_row' }); return; }
    const login = object(item.login);
    const card = object(item.card);
    const uris = Array.isArray(login?.uris) ? login.uris : [];
    const uri = uris.map(object).find((entry) => typeof entry?.uri === 'string' && entry.uri !== '');
    const type = item.type === 1 ? 'login' : item.type === 2 ? 'note' : item.type === 3 ? 'card' : item.type === 4 ? 'identity' : 'unknown';
    rows.push({ index, type, name: string(item.name), url: string(uri?.uri), username: string(login?.username), password: string(login?.password),
      notes: string(item.notes), totp: string(login?.totp), pan: string(card?.number), cardholder: string(card?.cardholderName),
      month: typeof card?.expMonth === 'number' ? String(card.expMonth) : string(card?.expMonth),
      year: typeof card?.expYear === 'number' ? String(card.expYear) : string(card?.expYear),
      cvv: card !== undefined && Object.keys(card).some((key) => CVV.test(normalized(key))) });
  });
  return { format: 'bitwarden_json', rows, skipped };
}

/** Force a fresh string allocation; no payload substring retains the export. */
function detached(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  try { return bytes.toString('utf8'); } finally { bytes.fill(0); }
}

function previewText(value: string, fallback: string, max: number, warnings: string[]): string {
  const clean = value.trim().replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted]');
  if (clean.length > max) warnings.push('long_field_truncated');
  let truncated = clean.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(truncated)) truncated = truncated.slice(0, -1);
  return detached(truncated || fallback);
}

export function createImportParser(): ImportParser {
  return {
    parse(bytes, hint) {
      if (bytes.length > MAX_IMPORT_CIPHERTEXT) refuse('too_large');
      if (hint !== undefined && !FORMATS.includes(hint)) refuse('unsupported_format');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { refuse('invalid_encoding'); }
      const first = text.trimStart()[0];
      const parsed = hint === 'bitwarden_json' || (hint === undefined && (first === '{' || first === '[')) ? jsonRows(text) : csvRows(text, hint);
      const candidates: ImportCandidate[] = [];
      const payloads: CapturePayload[] = [];
      const skipped = parsed.skipped;
      const duplicates = new Map<string, number>();
      const sensitive = new Set<string>();
      for (const row of parsed.rows) {
        for (const value of [row.password, row.notes, row.totp, row.pan]) if (value) sensitive.add(value);
        if (row.pan) sensitive.add(row.pan.replace(/[\s-]/g, ''));
        if (row.url.includes('?') || row.url.includes('#')) sensitive.add(row.url);
        if (row.type === 'identity' || row.type === 'unknown') {
          skipped.push({ index: row.index, reason: row.type === 'identity' ? 'unsupported_identity' : 'unsupported_type' }); continue;
        }
        const warnings: string[] = [];
        const name = previewText(row.name, `Imported ${row.type}`, 200, warnings);
        const username = row.type === 'login' && row.username !== '' ? previewText(row.username, '', 512, warnings) : null;
        const candidate: ImportCandidate = { index: row.index, type: row.type, name, origin: null, username, hasPassword: row.password !== '', hasTotp: row.totp !== '', warnings };
        if (row.notes) warnings.push('notes_present');
        if (row.totp) warnings.push('totp_present');
        let payload: unknown;
        if (row.type === 'login') {
          if (row.password === '') { skipped.push({ index: row.index, reason: 'missing_password' }); continue; }
          if (row.url === '') { skipped.push({ index: row.index, reason: 'missing_url' }); continue; }
          if (/^http:/i.test(row.url)) warnings.push('http_origin');
          try { candidate.origin = normalizeOrigin(row.url, { allowPath: true }).origin; }
          catch (error) { candidate.originError = error instanceof OriginRefusal ? error.code : 'invalid_url'; }
          payload = { type: 'login', name, origin: detached(candidate.origin ?? row.url), password: detached(row.password),
            ...(row.username !== '' ? { username: detached(row.username) } : {}),
            ...(row.totp !== '' ? { totp: detached(row.totp) } : {}), ...(row.notes !== '' ? { notes: detached(row.notes) } : {}) };
        } else if (row.type === 'note') {
          candidate.hasPassword = false;
          candidate.hasTotp = false;
          payload = { type: 'note', name, body: detached(row.notes) };
        } else {
          candidate.hasPassword = false;
          candidate.hasTotp = false;
          if (row.cvv) warnings.push('cvv_column_dropped');
          const cardholder = previewText(row.cardholder, '', 200, warnings);
          payload = { type: 'card', name, pan: detached(row.pan), expMonth: Number(row.month), expYear: Number(row.year),
            ...(cardholder ? { cardholder } : {}) };
        }
        const checked = CapturePayloadSchema.safeParse(payload);
        if (!checked.success) { skipped.push({ index: row.index, reason: 'invalid_payload' }); continue; }
        if (candidate.origin !== null && row.type === 'login') {
          const pair = JSON.stringify([candidate.origin, row.username]);
          const prior = duplicates.get(pair);
          if (prior !== undefined) candidate.duplicateOf = prior;
          else duplicates.set(pair, candidate.index);
        }
        candidate.warnings = [...new Set(warnings)];
        candidates.push(candidate);
        payloads.push(checked.data);
      }
      const containsSecret = previewGuard(sensitive);
      for (const candidate of candidates) {
        if (containsSecret(candidate.name)) candidate.name = '[redacted]';
        if (candidate.username !== null && containsSecret(candidate.username)) candidate.username = '[redacted]';
        if (candidate.origin !== null && containsSecret(candidate.origin)) { candidate.origin = null; candidate.originError = 'invalid_url'; }
      }
      skipped.sort((a, b) => a.index - b.index);
      return { format: parsed.format, candidates, payloads, skipped };
    },
  };
}
