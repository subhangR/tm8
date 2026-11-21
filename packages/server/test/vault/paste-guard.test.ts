/**
 * The chat paste guard (Secure Vault brief v2, MSG 6 Journey A step 3, MSG 14 test 20; task 01a1fa87-dd1a,
 * WS-A): which secret-shaped text it redacts, which ordinary text it leaves alone, what it says, and its knob.
 * paste-guard.pg.test.ts runs it on a real node; paste-guard-chat-start.test.ts drives chat.start's handler.
 *
 * Every secret-shaped fixture is assembled at runtime and none is a real credential. Assertions on values are
 * booleans: a failing test prints no fixture.
 */
import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { CollabError, VAULT_PASTE_WARNING_CODE, type InboundFrame, type StartChatInput } from '@tm8/contract';

import { VaultRelayConfigError, vaultPasteGuardFromEnv } from '../../src/vault/config.js';
import {
  CHAT_TITLE_MAX,
  MESSAGE_BODY_MAX,
  createPasteGuard,
  guardChatStart,
  guardInboundFrame,
  type PasteKind,
} from '../../src/vault/paste-guard.js';

const guard = createPasteGuard({ vaultAvailable: true });
const github = () => 'gh' + 'p_' + 'A'.repeat(36);
const aws = () => 'AK' + 'IA' + 'A'.repeat(16);
const pem = () => ['-----BEGIN ' + 'PRIVATE KEY-----', Buffer.alloc(48, 1).toString('base64'), '-----END ' + 'PRIVATE KEY-----'].join('\n');
const jwt = () => [Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'), 'e30', Buffer.alloc(32, 5).toString('base64url')].join('.');
const card = () => ['4111', '1111', '1111', '1111'].join(' ');
const credentialUrl = () => {
  const url = new URL('postgres://db.example.com/app');
  url.username = 'fixture';
  url.password = ['demo', 'value'].join('-');
  return url.toString();
};
/** 31 characters, letters and digits, high entropy. */
const mixed = () => ['aB3dE7gH9k', 'L2mN4pQ6rS', '8tU0vW5xY1z'].join('');
const passwordWord = () => ['Tr0ub', '4dor&3'].join('');

/** Whether the redacted text still holds the value. Never prints it. */
const leaks = (text: string, value: string) => text.includes(value);

describe('TM8_VAULT_PASTE_GUARD', () => {
  it('is off unless it says on, and reads whether the vault runs from TM8_VAULT_MODE', () => {
    expect(vaultPasteGuardFromEnv({})).toBeNull();
    expect(vaultPasteGuardFromEnv({ TM8_VAULT_PASTE_GUARD: 'off' })).toBeNull();
    expect(vaultPasteGuardFromEnv({ TM8_VAULT_PASTE_GUARD: ' off ' })).toBeNull();
    expect(vaultPasteGuardFromEnv({ TM8_VAULT_PASTE_GUARD: 'on' })).toEqual({ vaultAvailable: false });
    expect(vaultPasteGuardFromEnv({ TM8_VAULT_PASTE_GUARD: 'on', TM8_VAULT_MODE: 'off' })).toEqual({ vaultAvailable: false });
    expect(vaultPasteGuardFromEnv({ TM8_VAULT_PASTE_GUARD: 'on', TM8_VAULT_MODE: 'pre_review' })).toEqual({ vaultAvailable: true });
  });

  it('refuses to boot on any other value', () => {
    for (const value of ['', 'ON', 'true', '1', 'yes', 'enabled']) {
      expect(() => vaultPasteGuardFromEnv({ TM8_VAULT_PASTE_GUARD: value })).toThrow(VaultRelayConfigError);
    }
    expect(() => vaultPasteGuardFromEnv({ TM8_VAULT_PASTE_GUARD: 'true' })).toThrow(/TM8_VAULT_PASTE_GUARD must be off or on/);
  });
});

describe('paste guard: what it redacts', () => {
  const highConfidence: { kind: PasteKind; value: () => string }[] = [
    { kind: 'github_token', value: github },
    { kind: 'aws_access_key', value: aws },
    { kind: 'private_key', value: pem },
    { kind: 'jwt', value: jwt },
    { kind: 'card_number', value: card },
    { kind: 'connection_string', value: credentialUrl },
  ];
  for (const fixture of highConfidence) {
    it(`always redacts a ${fixture.kind}, and keeps the words around it`, () => {
      const value = fixture.value();
      const result = guard.redact(`here it is: ${value} thanks`);
      expect(leaks(result.text, value)).toBe(false);
      expect(result.text).toBe(`here it is: [redacted:${fixture.kind}] thanks`);
      expect(result.kinds).toEqual([fixture.kind]);
      expect(result.fits).toBe(true);
    });
  }

  it('redacts an AWS secret key next to its access key', () => {
    const secret = Buffer.alloc(30, 11).toString('base64');
    const result = guard.redact(`${aws()}\n${secret}`);
    expect(leaks(result.text, secret)).toBe(false);
    expect(result.kinds).toEqual(['aws_access_key', 'aws_secret_key']);
  });

  it('redacts an AWS secret key in a secret-named assignment, one that begins with a slash included', () => {
    // A key's 40 characters can begin with a slash and then read like an absolute path: the value gate took
    // 42 of 4,000 random keys for one before it knew the key's shape.
    const secret = ['/Kq7Rz2Lp', 'Xv9Wb4Nt', '/Hm3Jc8Fd', 'Gs5Yk1Pw', 'Ue6Ta0'].join('');
    expect(secret.length).toBe(40);
    for (const text of [`aws_secret_access_key = ${secret}`, `AWS_SECRET_ACCESS_KEY=${secret}`]) {
      const result = guard.redact(text);
      expect(leaks(result.text, secret)).toBe(false);
      expect(result.kinds).toEqual(['generic_secret_assignment']);
    }
  });

  const passwords: { name: string; text: (value: string) => string; value: string }[] = [
    { name: 'password is <value>', text: (v) => `the password is ${v}`, value: passwordWord() },
    { name: 'a quoted value of six or more', text: (v) => `pwd: "${v}"`, value: ['let', 'me', 'in'].join('') },
    { name: 'password=<value with a digit>', text: (v) => `password=${v}`, value: ['hun', 'ter', '2'].join('') },
    { name: 'a quoted passphrase with spaces', text: (v) => `db_password = '${v}'`, value: ['correct', 'horse', 'battery'].join(' ') },
    { name: 'twenty or more letters', text: (v) => `password is ${v}`, value: ['correct', 'horse', 'battery', 'staple'].join('') },
    { name: 'a value in another script with a digit', text: (v) => `password: ${v}`, value: 'పాస్\u200cవర్డ్' + '42' },
    { name: 'a $-leading value that is not a variable', text: (v) => `password: ${v}!`, value: ['$ecr', '3t'].join('') },
    { name: 'a JSON field', text: (v) => `{"password": "${v}", "user": "ops"}`, value: passwordWord() },
  ];
  for (const fixture of passwords) {
    it(`redacts a password: ${fixture.name}`, () => {
      const result = guard.redact(fixture.text(fixture.value));
      expect(leaks(result.text, fixture.value)).toBe(false);
      expect(result.kinds).toEqual(['password_assignment']);
      expect(result.text.includes('[redacted:password_assignment]')).toBe(true);
    });
  }

  const secrets: { name: string; text: (value: string) => string; value: string }[] = [
    { name: 'api_key = "<value>"', text: (v) => `api_key = "${v}"`, value: mixed() },
    { name: 'an exported token', text: (v) => `export DEPLOY_TOKEN=${v}`, value: ['a1b2c3d4', 'e5f6g7h8', 'i9'].join('') },
    { name: 'a YAML secret', text: (v) => `client_secret: ${v}`, value: ['k3y', 'Mat3rial', 'Value9'].join('') },
  ];
  for (const fixture of secrets) {
    it(`redacts a secret value: ${fixture.name}`, () => {
      const result = guard.redact(fixture.text(fixture.value));
      expect(leaks(result.text, fixture.value)).toBe(false);
      expect(result.kinds).toEqual(['generic_secret_assignment']);
    });
  }

  it("redacts a signed URL's signature, and only the signature", () => {
    const signature = 'ab12'.repeat(12);
    const url = new URL('https://storage.example.com/bucket/report.pdf');
    url.searchParams.set('X-Goog-Expires', '600');
    url.searchParams.set('X-Goog-Signature', signature);
    const result = guard.redact(`download: ${url.toString()}`);
    expect(leaks(result.text, signature)).toBe(false);
    expect(result.text.includes('storage.example.com/bucket/report.pdf')).toBe(true);
    expect(result.kinds).toEqual(['generic_secret_assignment']);
  });

  it('redacts every secret in one message, and lists each kind once in order', () => {
    const first = github();
    const second = passwordWord();
    const result = guard.redact(`token ${first}, then password=${second}, and again ${first}`);
    expect(leaks(result.text, first) || leaks(result.text, second)).toBe(false);
    expect(result.kinds).toEqual(['github_token', 'password_assignment']);
  });

  it('answers the same text the same way, so a retried post replays the same body', () => {
    const text = `password=${passwordWord()} and ${github()}`;
    expect(guard.redact(text)).toEqual(guard.redact(text));
  });
});

describe('paste guard: what it leaves alone', () => {
  const ordinary = [
    // Prose about passwords.
    'The password is optional for guests.',
    'password is required',
    'the password is wrong, try again',
    'Your password is 8 characters long.',
    'password is 90-day rotated',
    'password: hidden.',
    'the password is changeme on a fresh install, so rotate it',
    'Set the password to your own value.',
    // Schemas and docs.
    'password: string',
    '`password?: string | null`',
    'token: SecretStr',
    'password=<your password>',
    'password = ******',
    'secret: xxx',
    // References to where the value lives.
    'password = os.getenv("DB_PASSWORD")',
    'password = config.db.password',
    'password: process.env.DB_PASSWORD',
    "password = os.environ['DB_PASSWORD']",
    'password: DB_PASSWORD',
    'api_key: ${API_KEY}',
    'secret = ${{ secrets.DEPLOY_TOKEN }}',
    'password: {{ .Values.db.password }}',
    'password = %DB_PASSWORD%',
    'token: [REDACTED]',
    // Locations, not values.
    'token_url = https://auth.example.com/oauth/token',
    'secret_file: /etc/tm8/vault/relay.key',
    // A path with an AWS secret key's length and alphabet, in one letter case: still a path.
    'token_path = /var/lib/tm8/secrets/tokens/relay/keys01',
    'secret_name: projects/p1/secrets/db-password',
    'api_key: short1',
    'token = abcdefghijklmnopqrstuvwxyz',
    // Ids, hashes and paths, which are high-entropy but never redacted.
    mixed(),
    `commit ${['3f2a9c1e', '8b7d6a5f', '4e3d2c1b', '0a9f8e7d', '6c5b4a39'].join('')} fixed it`,
    'see 01a1fac1-d7f0-7219-9e24-77ac6f4daad8 and packages/vault/src/paste/index.ts',
    'sha256-' + Buffer.alloc(32, 9).toString('base64'),
    // Words in other scripts.
    'పాస్\u200cవర్డ్ మర్చిపోయాను, మళ్ళీ పంపండి',
    'पासवर्ड बदल दिया है',
  ];
  for (const text of ordinary) {
    it(`leaves ${JSON.stringify(text.slice(0, 48))} as it is`, () => {
      const result = guard.redact(text);
      expect(result.text).toBe(text);
      expect(result.kinds).toEqual([]);
      expect(result.fits).toBe(true);
    });
  }

  it('leaves the empty text alone', () => {
    expect(guard.redact('')).toEqual({ text: '', kinds: [], fits: true });
  });
});

describe('paste guard: limits', () => {
  it('compacts the markers when the labelled ones would not fit, and says when even those do not', () => {
    const unit = 'password=ab12 ';
    const compactable = unit.repeat(500);
    expect(compactable.length <= MESSAGE_BODY_MAX).toBe(true);
    const compacted = guard.redact(compactable, MESSAGE_BODY_MAX);
    expect(compacted.fits).toBe(true);
    expect(compacted.text.length <= MESSAGE_BODY_MAX).toBe(true);
    expect(compacted.text.includes('[redacted:')).toBe(false);
    expect(compacted.text.includes('ab12')).toBe(false);

    const tooLong = guard.redact(unit.repeat(600), MESSAGE_BODY_MAX);
    expect(tooLong.fits).toBe(false);
    expect(tooLong.kinds).toEqual(['password_assignment']);
    expect(tooLong.text.includes('ab12')).toBe(false);
  });

  it('scans a full-length adversarial body in well under a second', () => {
    const bodies = [
      'password='.repeat(Math.floor(MESSAGE_BODY_MAX / 9)),
      'a'.repeat(MESSAGE_BODY_MAX),
      '='.repeat(MESSAGE_BODY_MAX),
      ('api_key: ' + mixed() + ' ').repeat(Math.floor(MESSAGE_BODY_MAX / 41)),
      '4'.repeat(MESSAGE_BODY_MAX),
      ('x' + ' '.repeat(31) + 'is').repeat(Math.floor(MESSAGE_BODY_MAX / 34)),
    ];
    for (const body of bodies) {
      const started = performance.now();
      guard.redact(body, MESSAGE_BODY_MAX);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });
});

describe('paste guard: what it says', () => {
  it('warns that the secret is exposed anyway, names the kinds, and points at the capture link and tier a', () => {
    const warning = guard.warning(['password_assignment', 'github_token', 'password_assignment']);
    expect(warning.code).toBe(VAULT_PASTE_WARNING_CODE);
    expect(warning.code).toBe('vault_paste_redacted');
    expect(warning.message.includes('(password, GitHub token)')).toBe(true);
    expect(warning.message.includes('Treat it as exposed anyway')).toBe(true);
    expect(warning.message.includes('Rotate it at the source') || warning.message.includes('rotate it at the source')).toBe(true);
    expect(warning.message.includes('capture link')).toBe(true);
    expect(warning.message.includes('tier a')).toBe(true);
  });

  it('never offers the capture link where the vault does not run', () => {
    const off = createPasteGuard({ vaultAvailable: false });
    for (const text of [off.warning(['jwt']).message, off.editRefusal(['jwt']).message, off.tooLong(['jwt']).message, off.bridgeNotice(['jwt'])]) {
      expect(text.includes('capture link') || text.includes('Secure vault') || text.includes('tier a')).toBe(false);
      expect(text.includes('rotate it at the source')).toBe(true);
    }
  });

  it('refuses an edit and a message that will not fit, as invalid input naming the reason and the kinds', () => {
    for (const error of [guard.editRefusal(['card_number']), guard.tooLong(['card_number'])]) {
      expect(error).toBeInstanceOf(CollabError);
      expect(error.code).toBe('invalid_input');
      expect(error.details).toEqual({ reason: 'vault_paste_redacted', kinds: ['card_number'] });
    }
    expect(guard.editRefusal(['card_number']).message.includes('keeps its previous text')).toBe(true);
  });

  it('tells a bridged chat the message is still with the provider', () => {
    const notice = guard.bridgeNotice(['openai_key']);
    expect(notice.includes('still in this chat and with the chat provider')).toBe(true);
    expect(notice.includes('rotate it at the source')).toBe(true);
  });
});

describe('paste guard: chat.start', () => {
  const start = (body: string, title?: string | null): StartChatInput => ({
    spaceId: '01a1fa87-dd1a-7f7c-b384-e8dc90f576b6',
    teammateId: '01a1783f-b739-7262-aba9-8f94076efdf3',
    model: 'claude-opus-5-5',
    mode: 'ask',
    workdirMode: 'scratch',
    body,
    ...(title !== undefined ? { title } : {}),
    clientMutationId: '01a1fd13-3424-79b0-ab94-7c5c4bb010db',
  });

  it('returns the input itself and no warning when nothing is secret-shaped', () => {
    const input = start('plan the launch', 'Launch');
    const guarded = guardChatStart(guard, input);
    expect(guarded.input).toBe(input);
    expect(guarded.warning).toBeNull();
  });

  it('redacts the opening message and the title', () => {
    const value = github();
    const guarded = guardChatStart(guard, start(`use ${value}`, `deploy with ${value}`));
    expect(leaks(guarded.input.body, value) || leaks(guarded.input.title ?? '', value)).toBe(false);
    expect(guarded.input.title).toBe('deploy with [redacted:github_token]');
    expect(guarded.warning?.code).toBe('vault_paste_redacted');
  });

  it('drops a title its markers push past the limit, so the chat titles itself from the redacted body', () => {
    const title = 'password=ab12 '.repeat(Math.floor(CHAT_TITLE_MAX / 14));
    const guarded = guardChatStart(guard, start('hello', title));
    expect(guarded.input.title).toBeNull();
    expect(guarded.input.body).toBe('hello');
    expect(guarded.warning).not.toBeNull();
  });

  it('refuses a start whose redacted message would not fit', () => {
    expect(() => guardChatStart(guard, start('password=ab12 '.repeat(600)))).toThrow(CollabError);
  });
});

describe('paste guard: bridged messages', () => {
  const frame = (overrides: Partial<InboundFrame> = {}): InboundFrame => ({
    connectionId: 'connection',
    conversationId: 'group',
    externalMessageId: '3EB0GUARD1',
    sender: { externalId: '919800000001@s.whatsapp.net', altId: null, name: 'Rahul', fromMe: false },
    body: 'hello',
    kind: 'text',
    media: [],
    replyTo: null,
    mentions: [],
    ts: 1_790_000_100,
    ...overrides,
  } as InboundFrame);

  it("redacts a person's body, slash command text and media captions", () => {
    const value = github();
    const guarded = guardInboundFrame(guard, frame({
      body: `/work deploy with ${value}`,
      slashCommand: { command: '/tm8', text: `work deploy with ${value}` },
      kind: 'media',
      media: [{ kind: 'image', mime: 'image/png', fileName: 'shot.png', caption: `key ${value}`, size: 10, handle: 'media-1' }],
    }));
    expect(guarded.kinds).toEqual(['github_token']);
    const stored = JSON.stringify(guarded.frame);
    expect(leaks(stored, value)).toBe(false);
    expect(guarded.frame.body).toBe('/work deploy with [redacted:github_token]');
    expect(guarded.frame.slashCommand?.command).toBe('/tm8');
    expect(guarded.frame.media[0]?.fileName).toBe('shot.png');
  });

  it('redacts a caption on a media message with no text, which the store would take as its body', () => {
    const value = jwt();
    const guarded = guardInboundFrame(guard, frame({
      body: '',
      kind: 'media',
      media: [
        { kind: 'image', mime: 'image/png', fileName: 'a.png', caption: null, size: 10, handle: 'media-2' },
        { kind: 'document', mime: 'text/plain', fileName: 'b.txt', caption: `session ${value}`, size: 20, handle: 'media-3' },
      ],
    }));
    expect(guarded.kinds).toEqual(['jwt']);
    expect(leaks(JSON.stringify(guarded.frame), value)).toBe(false);
    expect(guarded.frame.media[1]?.caption).toBe('session [redacted:jwt]');
    expect(guarded.frame.media[0]?.caption).toBeNull();
    expect(guarded.frame.body).toBe('');
  });

  it('reads the captions of a frame that came without a body, against its contract', () => {
    const value = github();
    const received = frame({
      body: undefined as unknown as string,
      kind: 'media',
      media: [{ kind: 'image', mime: 'image/png', fileName: 'c.png', caption: `key ${value}`, size: 10, handle: 'media-4' }],
    });
    const guarded = guardInboundFrame(guard, received);
    expect(guarded.kinds).toEqual(['github_token']);
    expect(leaks(JSON.stringify(guarded.frame), value)).toBe(false);
    expect(guarded.frame.media[0]?.caption).toBe('key [redacted:github_token]');
    expect(guarded.frame.body).toBeUndefined();
  });

  it('redacts an edit the same way', () => {
    const value = passwordWord();
    const guarded = guardInboundFrame(guard, frame({ body: `password is ${value}`, edit: { editedAt: 1_790_000_200 } }));
    expect(leaks(guarded.frame.body, value)).toBe(false);
    expect(guarded.frame.edit).toEqual({ editedAt: 1_790_000_200 });
  });

  it("leaves a bot's message, a deletion and clean text as they are", () => {
    const value = github();
    const bot = frame({ body: `token ${value}`, sender: { externalId: 'B0123', altId: null, name: 'CI', fromMe: false, bot: true } });
    expect(guardInboundFrame(guard, bot).frame).toBe(bot);
    const deleted = frame({ body: '', deleted: true });
    expect(guardInboundFrame(guard, deleted).frame).toBe(deleted);
    const clean = frame({ body: 'see you at 5' });
    expect(guardInboundFrame(guard, clean)).toEqual({ frame: clean, kinds: [] });
  });
});
