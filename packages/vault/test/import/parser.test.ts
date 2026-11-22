import { describe, expect, it } from 'vitest';
import { VAULT_MAX_IMPORT_ITEMS } from '@tm8/contract';
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
const fixedWarnings = new Set(['http_origin', 'missing_password', 'missing_url', 'cvv_column_dropped', 'totp_present', 'notes_present', 'long_field_truncated', 'unsafe_characters_replaced']);

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

  it('keeps sealed metadata in step with the preview: names redacted, repeated usernames refused', () => {
    const s = secrets();
    const other = (suffix: string) => ['different', 'fixture', 'password', suffix].join('-');
    const result = parser.parse(Buffer.from(csv([['name', 'url', 'username', 'password'],
      ['Name copy ' + s.password, 'https://example.com', 'fixture-a', other('a')],
      ['Username copy', 'https://example.org', 'user-' + s.password, other('b')],
      ['Same as password', 'https://example.net', other('c'), other('c')],
      ['Source', 'https://example.com', 'fixture-a', s.password],
      ['Duplicate', 'https://example.com', 'fixture-a', other('d')]])));
    expect(result.candidates.map((candidate) => candidate.index)).toEqual([0, 3, 4]);
    expect(result.skipped).toEqual([{ index: 1, reason: 'secret_in_metadata' }, { index: 2, reason: 'secret_in_metadata' }]);
    expect(result.candidates[0]?.name).toBe('[redacted]');
    expect(result.payloads[0]?.name).toBe('[redacted]');
    expect(result.candidates.map((candidate) => candidate.duplicateOf)).toEqual([undefined, 0, 0]);
    // Name, username and origin are what the commit split turns into agent-readable metadata.
    const metadata = JSON.stringify(result.payloads.map((payload) => payload.type === 'login'
      ? [payload.name, payload.username, payload.origin] : [payload.name]));
    for (const secret of [s.password, other('a'), other('b'), other('c'), other('d')]) expect(metadata.includes(secret)).toBe(false);
    assertSafe(result, [...Object.values(s), other('a'), other('b'), other('c'), other('d')]);
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
    const importable = 'Example,https://example.com,fixture-user,fixture-long-password';
    const skippable = 'Example,,fixture-user,fixture-long-password';
    const header = 'name,url,username,password\n';
    // C6: 10,000 rows parse when no more than VAULT_MAX_IMPORT_ITEMS of them are importable.
    const mixed = parser.parse(Buffer.from(header + [...Array(5000).fill(importable), ...Array(5000).fill(skippable)].join('\n')));
    expect(mixed.candidates).toHaveLength(5000);
    expect(mixed.skipped).toHaveLength(5000);
    expect(mixed.skipped.every((entry) => entry.reason === 'missing_url')).toBe(true);
    expectRefusal(Buffer.from(header + Array(10001).fill(skippable).join('\n')), 'too_many_rows');
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

/** Text from code points, so this file holds no invisible character and no escape a tool could rewrite. */
const cp = (...points: number[]) => String.fromCodePoint(...points);
/** A JSON escape for one UTF-16 code unit, built from its number. */
const jsonEscape = (unit: number) => String.fromCharCode(92) + 'u' + unit.toString(16).padStart(4, '0');

describe('import content checks (review addendum 2, C6)', () => {
  const header = ['name', 'url', 'username', 'password'];
  // Synthetic, and assembled so the source holds no credential-shaped literal.
  const loginValue = ['fixture', 'long', 'value'].join('-');
  const loginRow = (name: string, username = 'fixture-user') => [name, 'https://example.com', username, loginValue];
  const exported = { type: 1, name: 'Example', login: { uris: [{ uri: 'https://example.com' }], username: 'fixture-user', password: loginValue } };

  it('refuses an export with more importable rows than one commit takes', () => {
    expect(VAULT_MAX_IMPORT_ITEMS).toBe(5000);
    const row = `Example,https://example.com,fixture-user,${loginValue}`;
    const head = 'name,url,username,password\n';
    expect(parser.parse(Buffer.from(head + Array(VAULT_MAX_IMPORT_ITEMS).fill(row).join('\n'))).candidates).toHaveLength(VAULT_MAX_IMPORT_ITEMS);
    expectRefusal(Buffer.from(head + Array(VAULT_MAX_IMPORT_ITEMS + 1).fill(row).join('\n')), 'too_many_rows');
    const note = { type: 2, name: 'Note', notes: 'synthetic' };
    expect(parser.parse(Buffer.from(JSON.stringify({ items: Array(VAULT_MAX_IMPORT_ITEMS).fill(note) }))).candidates).toHaveLength(VAULT_MAX_IMPORT_ITEMS);
    expectRefusal(Buffer.from(JSON.stringify({ items: Array(VAULT_MAX_IMPORT_ITEMS + 1).fill(note) })), 'too_many_rows');
  });

  it.each([
    ['TAB', 0x9], ['LF', 0xa], ['ESC', 0x1b], ['DEL', 0x7f], ['NEL', 0x85], ['CSI', 0x9b],
    ['LINE SEPARATOR', 0x2028], ['PARAGRAPH SEPARATOR', 0x2029], ['RLO', 0x202e], ['LRI', 0x2066], ['PDI', 0x2069],
    ['TAG LATIN SMALL G', 0xe0067], ['CANCEL TAG', 0xe007f],
  ] as const)('replaces %s inside an item name with a space and says so, on both preview and payload', (_label, point) => {
    for (const name of [`Pay${cp(point)}lap`, `Pay${cp(point, 0x202e, point)}lap`]) {
      const result = parser.parse(Buffer.from(csv([header, loginRow(name)])));
      expect(result.candidates[0]).toMatchObject({ name: 'Pay lap', warnings: ['unsafe_characters_replaced'] });
      expect(result.payloads[0]).toMatchObject({ name: 'Pay lap' });
      assertSafe(result, []);
    }
  });

  it('replaces unsafe characters in a JSON name, and falls back when nothing readable is left', () => {
    const result = parser.parse(Buffer.from(JSON.stringify({ items: [
      { ...exported, name: `${cp(0x202e)}moc.elpmaxe` },
      { type: 2, name: cp(0x202e, 0x2066, 0x1b), notes: 'synthetic' },
    ] })));
    expect(result.candidates.map((candidate) => [candidate.name, candidate.warnings])).toEqual([
      ['moc.elpmaxe', ['unsafe_characters_replaced']],
      ['Imported note', ['unsafe_characters_replaced', 'notes_present']],
    ]);
    expect(result.payloads.map((payload) => payload.name)).toEqual(['moc.elpmaxe', 'Imported note']);
  });

  it('drops text hidden in tag characters from a name, and degrades a subdivision flag to the plain flag', () => {
    // A page title a password manager saved as the name: "Bank" and then tag characters spelling "ignore".
    const hidden = cp(...[...'ignore'].map((letter) => 0xe0000 + letter.charCodeAt(0)));
    const flagged = `${cp(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f)} Club`;
    const result = parser.parse(Buffer.from(JSON.stringify({ items: [{ ...exported, name: `Bank${hidden}` }, { ...exported, name: flagged }] })));
    expect(result.candidates[0]).toMatchObject({ name: 'Bank', warnings: ['unsafe_characters_replaced'] });
    expect(result.payloads[0]).toMatchObject({ name: 'Bank' });
    const repaired = result.candidates[1]!;
    expect(repaired.warnings).toContain('unsafe_characters_replaced');
    expect(repaired.name.startsWith(cp(0x1f3f4))).toBe(true);
    expect(repaired.name.endsWith('Club')).toBe(true);
    for (const text of [repaired.name, result.payloads[1]!.name]) expect(/[\u{e0000}-\u{e007f}]/u.test(text)).toBe(false);
  });

  it('leaves a name alone when only its surrounding whitespace is unusual', () => {
    const result = parser.parse(Buffer.from(csv([header, loginRow(`${cp(0x9)}Example${cp(0xa)}`)])));
    expect(result.candidates[0]).toMatchObject({ name: 'Example', warnings: [] });
  });

  it('keeps names and usernames with direction marks, joiners and non-Latin scripts unchanged', () => {
    const labels = [
      cp(0xc24, 0xc46, 0xc32, 0xc41, 0xc17, 0xc41),
      `${cp(0xc15, 0xc4d, 0x200c)}x`,
      cp(0x645, 0x631, 0x62d, 0x628, 0x627),
      `GitHub ${cp(0x200e)}(${cp(0x200f)})`,
      cp(0x1f469, 0x200d, 0x1f4bb),
    ];
    for (const label of labels) {
      const result = parser.parse(Buffer.from(csv([header, loginRow(label, label)])));
      expect(result.candidates[0]).toMatchObject({ name: label, username: label, warnings: [] });
      expect(result.payloads[0]).toMatchObject({ name: label, username: label });
    }
  });

  it('skips a login whose username holds a control or text-direction character instead of changing a value it fills', () => {
    for (const username of [`octo${cp(0x202e)}cat`, `octo${cp(0x9)}cat`, `${cp(0x9)}octocat`, `octo${cp(0x2028)}`, `octo${cp(0x85)}`,
      `octo${cp(0xe0041)}cat`]) {
      const result = parser.parse(Buffer.from(csv([header, loginRow('Example', username), loginRow('Example')])));
      expect(result.skipped).toEqual([{ index: 0, reason: 'unsafe_username' }]);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({ index: 1, username: 'fixture-user' });
      assertSafe(result, [username]);
    }
  });

  it('refuses a JSON export holding a lone surrogate in any value or key, used or not', () => {
    const lone = String.fromCharCode(0xd800);
    for (const value of [
      { items: [{ ...exported, name: `Example${lone}` }] },
      { items: [{ ...exported, login: { ...exported.login, password: `fixture${lone}` } }] },
      { items: [exported], unused: String.fromCharCode(0xdfff) },
      { items: [exported], [`key${lone}`]: 'value' },
    ]) {
      const bytes = Buffer.from(JSON.stringify(value));
      // JSON.stringify writes a lone surrogate as an ASCII escape, so the bytes are valid UTF-8.
      expect(bytes.every((byte) => byte < 0x80)).toBe(true);
      expectRefusal(bytes, 'invalid_encoding');
    }
    const escaped = (units: number[]) => Buffer.from(`{"items":[{"type":2,"name":"${units.map(jsonEscape).join('')}","notes":"synthetic"}]}`);
    expectRefusal(escaped([0xd83d]), 'invalid_encoding');
    expectRefusal(escaped([0xde00, 0xd83d]), 'invalid_encoding');
    expect(parser.parse(escaped([0xd83d, 0xde00])).candidates[0]?.name).toBe(cp(0x1f600));
  });

  it('refuses CSV bytes that encode a surrogate', () => {
    expectRefusal(Buffer.concat([Buffer.from('name,url,username,password\nExample'), Buffer.from([0xed, 0xa0, 0x80]),
      Buffer.from(',https://example.com,fixture-user,fixture-long-password')]), 'invalid_encoding');
  });
});
