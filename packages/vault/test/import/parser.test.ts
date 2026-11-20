import { describe, expect, it } from 'vitest';
import { createImportParser, ImportParseError } from '../../src/import/index.js';
import { CapturePayloadSchema } from '../../src/capture/payload.js';
import { MAX_IMPORT_CIPHERTEXT } from '../../src/capture/seal.js';
import type { ImportFormat, ImportParseResult } from '../../src/types.js';

const parser = createImportParser();
const secrets = () => ({
  password: ['fixture', 'password', '29a7'].join('-'),
  totp: ['JBSW', 'Y3DP', 'EHPK', '3PXP'].join(''),
  notes: ['fixture private note', 'with a newline and "quotes"'].join('\n'),
  pan: ['4111', '1111', '1111', '1111'].join(''),
  cvv: ['3', '1', '4'].join(''),
  url: 'https://EXAMPLE.com:443/sign-in?credential=' + ['fixture', 'query', 'secret'].join('-'),
});
const csv = (rows: string[][], newline = '\n') => rows.map((row) => row.map((field) => '"' + field.replaceAll('"', '""') + '"').join(',')).join(newline);
const fixedWarnings = new Set(['http_origin', 'missing_password', 'missing_url', 'cvv_column_dropped', 'totp_present', 'notes_present', 'long_field_truncated']);

function assertSafe(result: ImportParseResult, values: string[]) {
  const metadata = JSON.stringify({ candidates: result.candidates, skipped: result.skipped });
  for (const value of values) {
    if (!value) continue;
    const variants = [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'),
      Buffer.from(value).toString('hex'), encodeURIComponent(value)];
    for (const variant of variants) expect(metadata.includes(variant)).toBe(false);
  }
  expect(result.payloads).toHaveLength(result.candidates.length);
  for (const payload of result.payloads) expect(CapturePayloadSchema.safeParse(payload).success).toBe(true);
  for (const candidate of result.candidates) for (const warning of candidate.warnings) expect(fixedWarnings.has(warning)).toBe(true);
}

type Fixture = { format: ImportFormat; headers: string[]; row: (values: ReturnType<typeof secrets>) => string[]; warnings: string[] };
const fixtures: Fixture[] = [
  { format: 'chrome_csv', headers: ['name', 'url', 'username', 'password', 'note'], row: (s) => ['Example, "login"', s.url, 'fixture-user', s.password, s.notes], warnings: ['notes_present'] },
  { format: 'firefox_csv', headers: ['url', 'username', 'password', 'httpRealm', 'formActionOrigin', 'guid', 'timeCreated', 'timeLastUsed', 'timePasswordChanged'],
    row: (s) => [s.url, 'fixture-user', s.password, '', 'https://example.com', '{fixture-guid}', '1', '2', '3'], warnings: [] },
  { format: 'safari_csv', headers: ['Title', 'URL', 'Username', 'Password', 'Notes', 'OTPAuth'], row: (s) => ['Example', s.url, 'fixture-user', s.password, s.notes, s.totp], warnings: ['notes_present', 'totp_present'] },
  { format: 'bitwarden_csv', headers: ['folder', 'favorite', 'type', 'name', 'notes', 'fields', 'reprompt', 'login_uri', 'login_username', 'login_password', 'login_totp'],
    row: (s) => ['', '0', 'login', 'Example', s.notes, '', '0', s.url, 'fixture-user', s.password, s.totp], warnings: ['notes_present', 'totp_present'] },
  { format: 'onepassword_csv', headers: ['Title', 'Url', 'Username', 'Password', 'OTPAuth', 'Favorite', 'Archived', 'Tags', 'Notes'],
    row: (s) => ['Example', s.url, 'fixture-user', s.password, s.totp, 'false', 'false', '', s.notes], warnings: ['notes_present', 'totp_present'] },
  { format: 'generic_csv', headers: ['Account', 'Website', 'User', 'Pass', 'Comments', 'TOTP'], row: (s) => ['Example', s.url, 'fixture-user', s.password, s.notes, s.totp], warnings: ['notes_present', 'totp_present'] },
];

describe('password-manager imports', () => {
  for (const fixture of fixtures) {
    it(`parses ${fixture.format} with safe metadata, duplicates and fixed skips`, () => {
      const s = secrets();
      const row = fixture.row(s);
      const result = parser.parse(Buffer.from('\uFEFF' + csv([fixture.headers, row, row, row.slice(0, -1)], '\r\n') + '\r\n'));
      expect(result.format).toBe(fixture.format);
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0]).toMatchObject({ index: 0, type: 'login', origin: 'https://example.com', username: 'fixture-user', hasPassword: true, warnings: fixture.warnings });
      expect(result.candidates[1]?.duplicateOf).toBe(0);
      expect(result.skipped).toEqual([{ index: 2, reason: 'ragged_row' }]);
      expect(result.payloads[0]).toMatchObject({ type: 'login', password: s.password });
      if (fixture.warnings.includes('notes_present')) expect(result.payloads[0]).toHaveProperty('notes', s.notes);
      assertSafe(result, Object.values(s).filter((value) => value !== s.cvv));
    });
  }

  it('parses unencrypted Bitwarden JSON logins, notes and cards; skips identities', () => {
    const s = secrets();
    const login = { type: 1, name: 'Example', notes: s.notes, login: { uris: [{ uri: null }, { uri: s.url }], username: 'fixture-user', password: s.password, totp: s.totp } };
    const result = parser.parse(Buffer.from('\uFEFF' + JSON.stringify({ encrypted: false, items: [login, login,
      { type: 2, name: 'Private note', notes: s.notes },
      { type: 3, name: 'Card', card: { number: s.pan, expMonth: '12', expYear: '2031', cardholderName: 'Fixture Cardholder', code: s.cvv } },
      { type: 4, name: 'Identity', identity: { passportNumber: s.password } }, { type: 99, name: s.password }, null] })));
    expect(result.format).toBe('bitwarden_json');
    expect(result.candidates.map((candidate) => candidate.type)).toEqual(['login', 'login', 'note', 'card']);
    expect(result.candidates[1]?.duplicateOf).toBe(0);
    expect(result.candidates[2]?.warnings).toEqual(['notes_present']);
    expect(result.candidates[3]?.warnings).toEqual(['cvv_column_dropped']);
    expect(result.skipped).toEqual([{ index: 4, reason: 'unsupported_identity' }, { index: 5, reason: 'unsupported_type' }, { index: 6, reason: 'invalid_row' }]);
    expect(result.payloads[3]).toEqual({ type: 'card', name: 'Card', pan: s.pan, cardholder: 'Fixture Cardholder', expMonth: 12, expYear: 2031 });
    assertSafe(result, Object.values(s));
    expect(JSON.stringify(result.payloads).includes('"code"')).toBe(false);
  });

  it('obeys a hint even when the header detects another format', () => {
    const fixture = fixtures[2]!;
    const s = secrets();
    expect(parser.parse(Buffer.from(csv([fixture.headers, fixture.row(s)])), 'onepassword_csv').format).toBe('onepassword_csv');
  });

  it('handles RFC 4180 escaped quotes, embedded newlines, BOM, CRLF and LF', () => {
    const s = secrets();
    for (const newline of ['\n', '\r\n']) {
      const result = parser.parse(Buffer.from('\uFEFF' + csv([['name', 'url', 'username', 'password', 'note'], ['A, "quoted" name', s.url, 'fixture-user', s.password, s.notes]], newline)));
      expect(result.candidates[0]?.name).toBe('A, "quoted" name');
      expect(result.payloads[0]).toHaveProperty('notes', s.notes);
      assertSafe(result, Object.values(s));
    }
  });

  it('drops every card verification column and warns once', () => {
    const s = secrets();
    const headers = ['type', 'name', 'pan', 'exp_month', 'exp_year', 'CVV', 'security-code', 'card verification value', 'cvc2', 'code'];
    const row = ['card', 'Fixture card', s.pan, '2', '2030', s.cvv, s.cvv, s.cvv, s.cvv, s.cvv];
    const result = parser.parse(Buffer.from(csv([headers, row])));
    expect(result.candidates[0]?.warnings).toEqual(['cvv_column_dropped']);
    expect(Object.keys(result.payloads[0]!).sort()).toEqual(['expMonth', 'expYear', 'name', 'pan', 'type']);
    expect(JSON.stringify(result.payloads).includes(s.cvv)).toBe(false);
    assertSafe(result, Object.values(s));
  });

  it('retains refused origins only on the secret side and uses fixed missing-field skips', () => {
    const s = secrets();
    const result = parser.parse(Buffer.from(csv([['name', 'url', 'username', 'password'],
      ['HTTP', 'http://example.com/login?secret=' + s.password, 'fixture-user', s.password],
      ['IP', 'https://127.0.0.1/login?secret=' + s.password, 'fixture-user', s.password],
      ['Invalid', 'bad-origin-' + s.password, 'fixture-user', s.password],
      ['No URL', '', 'fixture-user', s.password], ['No password', s.url, 'fixture-user', '']])));
    expect(result.candidates.map((candidate) => candidate.origin)).toEqual([null, null, null]);
    expect(result.candidates.map((candidate) => candidate.originError)).toEqual(['scheme_not_https', 'ip_literal', 'invalid_url']);
    expect(result.candidates[0]?.warnings).toEqual(['http_origin']);
    expect(result.skipped).toEqual([{ index: 3, reason: 'missing_url' }, { index: 4, reason: 'missing_password' }]);
    assertSafe(result, Object.values(s));
  });

  it('redacts secrets copied into preview metadata in every encoding and across rows', () => {
    const s = secrets();
    const encodings = [s.password, Buffer.from(s.password).toString('base64'), Buffer.from(s.password).toString('hex'), encodeURIComponent(s.notes)];
    const rows = encodings.map((encoded, index) => [encoded, 'https://example.com', 'fixture-' + index, 'different-fixture-password']);
    rows.push(['Source', s.url, 'fixture-source', s.password]);
    const result = parser.parse(Buffer.from(csv([['name', 'url', 'username', 'password', 'notes'],
      ...rows.map((row, index) => [...row, index === rows.length - 1 ? s.notes : ''])])));
    expect(result.candidates.slice(0, encodings.length).every((candidate) => candidate.name === '[redacted]')).toBe(true);
    assertSafe(result, [...Object.values(s), 'different-fixture-password']);
  });

  it('truncates display names with the fixed warning and preserves caller-owned input', () => {
    const s = secrets();
    const bytes = Buffer.from(csv([['name', 'url', 'username', 'password'], ['N'.repeat(201), s.url, 'fixture-user', s.password]]));
    const saved = Buffer.from(bytes);
    const result = parser.parse(bytes);
    expect(bytes.equals(saved)).toBe(true);
    bytes.fill(0);
    expect(result.candidates[0]?.name).toHaveLength(200);
    expect(result.candidates[0]?.warnings).toEqual(['long_field_truncated']);
    expect(result.payloads[0]).toHaveProperty('password', s.password);
    saved.fill(0);
  });

  it('skips schema-invalid rows without returning schema messages', () => {
    const s = secrets();
    const result = parser.parse(Buffer.from(JSON.stringify({ items: [
      { type: 3, name: 'Bad expiry', card: { number: s.pan, code: s.cvv } },
      { type: 1, name: 'Long password', login: { uris: [{ uri: s.url }], password: s.password.repeat(400) } },
      { type: 2, name: 'Empty note', notes: '' },
    ] })));
    expect(result.candidates).toEqual([]);
    expect(result.skipped.map((row) => row.reason)).toEqual(['invalid_payload', 'invalid_payload', 'invalid_payload']);
    assertSafe(result, Object.values(s));
  });
});

function expectRefusal(bytes: Buffer, code: string) {
  try { parser.parse(bytes); throw new Error('expected refusal'); }
  catch (error) {
    expect(error).toBeInstanceOf(ImportParseError);
    expect((error as ImportParseError).code).toBe(code);
    expect((error as Error).message).toBe('import refused: ' + code);
    const metadata = JSON.stringify(error);
    for (const secret of Object.values(secrets())) expect(metadata.includes(secret)).toBe(false);
  }
}

describe('fixed import refusals and limits', () => {
  it('rejects malformed CSV without quoting its fields', () => {
    const s = secrets();
    for (const suffix of ['"' + s.password, '"' + s.password + '"junk', s.password + '"', s.password + '\r']) {
      expectRefusal(Buffer.from('name,url,password\n' + suffix), 'malformed_csv');
    }
  });
  it('rejects malformed JSON, invalid UTF-8 and encrypted exports', () => {
    expectRefusal(Buffer.from('{"items":[' + secrets().password), 'invalid_json');
    expectRefusal(Buffer.from([0xff, 0xfe]), 'invalid_encoding');
    expectRefusal(Buffer.from(JSON.stringify({ encrypted: true, items: [] })), 'encrypted_export');
  });
  it('rejects unsupported formats and ambiguous headers', () => {
    expectRefusal(Buffer.from('unrelated,fields\n1,2'), 'unsupported_format');
    expectRefusal(Buffer.from('password,Password\n1,2'), 'invalid_header');
    expectRefusal(Buffer.from(''), 'unsupported_format');
  });
  it('refuses beyond 8 MiB without reading input content', () => {
    expect(MAX_IMPORT_CIPHERTEXT).toBe(8 * 1024 * 1024);
    expectRefusal(Buffer.alloc(MAX_IMPORT_CIPHERTEXT + 1), 'too_large');
  });
  it('enforces 10,000 data rows for CSV and JSON, including skipped rows', () => {
    const row = 'Example,https://example.com,fixture-user,fixture-long-password';
    const header = 'name,url,username,password\n';
    expect(parser.parse(Buffer.from(header + Array(10000).fill(row).join('\n'))).candidates).toHaveLength(10000);
    expectRefusal(Buffer.from(header + Array(10001).fill(row).join('\n')), 'too_many_rows');
    expectRefusal(Buffer.from(JSON.stringify({ items: Array(10001).fill(null) })), 'too_many_rows');
  });
  it('enforces a UTF-8 byte limit of 64 KiB per field, including unknown JSON fields', () => {
    const note = 'N'.repeat(65536);
    const accepted = parser.parse(Buffer.from(JSON.stringify({ items: [{ type: 2, name: 'Note', notes: note }] })));
    expect(accepted.payloads[0]).toHaveProperty('body', note);
    expectRefusal(Buffer.from(csv([['type', 'name', 'notes'], ['note', 'Note', note + 'N']])), 'field_too_large');
    expectRefusal(Buffer.from(csv([['type', 'name', 'notes'], ['note', 'Note', 'é'.repeat(32769)]])), 'field_too_large');
    expectRefusal(Buffer.from(JSON.stringify({ items: [], unused: note + 'N' })), 'field_too_large');
  });
});
