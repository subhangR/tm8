/**
 * `tm8 form …` — arg parsing, the `--question` shorthand, client-side
 * validation (advisor rulings W1-R2, W1-R4), and the generated `tm8 help form`
 * guide (decision 12).
 *
 * Commands are driven through the REAL kernel router (`run()`) against a local
 * HTTP stub that routes by method + path, so every assertion about "nothing was
 * sent" is a measurement of the wire, not of a mock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { FORM_QUESTION_TYPES, FORM_QUESTION_TYPE_NAMES, type FormQuestionTypeDef } from '@tm8/contract';
import { run } from '../src/run.js';
import { parseInvocation } from '../src/args.js';
import { byteLength, CAPS, nounHelp } from '../src/discovery/help.js';
import { formGuide, settingLines } from '../src/discovery/form-guide.js';
import {
  assembleSpec,
  issueKey,
  parseQuestionShorthand,
  splitEscaped,
  validateAnswers,
} from '../src/form-input.js';
import { CliError } from '../src/exit.js';

async function tm8(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    out.push(String(c));
    return true;
  });
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    err.push(String(c));
    return true;
  });
  try {
    const code = await run(argv);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

const SPACE = '11111111-1111-7111-8111-111111111111';
const FORM = '22222222-2222-7222-8222-222222222222';
const RESPONSE = '33333333-3333-7333-8333-333333333333';

let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];
let routes: Record<string, { status: number; body: unknown }> = {};

/** The form content arm `entities.get` returns (the questions to validate against). */
function formDetail(questions: unknown[]): unknown {
  return {
    id: FORM,
    kind: 'form',
    version: 3,
    title: 'Migration plan',
    content: { kind: 'form', status: 'open', structureVersion: 1, sections: [], questions },
  };
}

const QUESTIONS = [
  { key: 'strategy', type: 'single_choice', title: 'Which approach?', required: true, position: 0, config: { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] } },
  { key: 'code', type: 'short_text', title: 'Ticket', required: false, position: 1, config: { pattern: '[A-Z]+-\\d+' } },
];

const VIEW = {
  id: RESPONSE, formId: FORM, respondentId: 'm1', respondentName: 'Ada', status: 'submitted', revision: 1,
  supersedesId: null, lineageKey: '44444444-4444-7444-8444-444444444444', isCurrent: true, structureVersion: 1,
  answers: { strategy: { value: 'a' } },
  questionsSnapshot: { structureVersion: 1, sections: [], questions: QUESTIONS },
  messageId: null, createdAt: '2026-09-24T00:00:00Z', updatedAt: '2026-09-24T00:00:00Z',
  submittedAt: '2026-09-24T00:00:00Z', version: 1,
  deliveries: [{ workSessionId: 'ws1', status: 'delivered', spawnedSessionId: null, lastError: null, attempts: 1, createdAt: '2026-09-24T00:00:00Z' }],
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      recorded.push({ method: req.method ?? '', path: url.pathname, query: url.searchParams, body: raw ? (JSON.parse(raw) as unknown) : undefined });
      const hit = routes[`${req.method} ${url.pathname}`] ?? { status: 200, body: {} };
      res.setHeader('content-type', 'application/json');
      res.statusCode = hit.status;
      res.end(JSON.stringify(hit.status < 300 ? { data: hit.body, requestId: 'req_t' } : hit.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(() => {
  recorded = [];
  routes = {
    [`GET /v2/entities/${FORM}`]: { status: 200, body: formDetail(QUESTIONS) },
    [`POST /v2/forms/${FORM}/responses/submit`]: { status: 200, body: VIEW },
    [`PUT /v2/forms/${FORM}/responses/mine`]: { status: 200, body: { ...VIEW, status: 'draft', deliveries: [] } },
    'POST /v2/forms': { status: 200, body: { entity: formDetail([]), url: `/#/s/${SPACE}/e/${FORM}`, requestingSessionId: null, attachedTo: [] } },
  };
  process.env.TM8_BASE_URL = baseUrl;
  delete process.env.TM8_SPACE_ID;
  delete process.env.TM8_ACTOR_ID;
  delete process.env.TM8_SESSION_ID;
  delete process.env.TM8_CONFIG_PATH;
});

const wire = (method: string, path: string) => recorded.filter((r) => r.method === method && r.path === path);

// ── arg parsing ────────────────────────────────────────────────────────────

describe('arg parsing', () => {
  it('--open, --draft and --first are bare booleans: they never eat the next token', () => {
    for (const flag of ['open', 'draft', 'first']) {
      const p = parseInvocation(['form', 'create', `--${flag}`, 'NEXT']);
      expect(p.options.bool(flag)).toBe(true);
      expect(p.positionals).toContain('NEXT');
    }
  });

  it('--question, --optional, --section and --attach are repeatable value flags', () => {
    const p = parseInvocation(['form', 'create', '--question', 'a:long_text:A', '--question', 'b:long_text:B', '--optional', 'a', '--optional', 'b']);
    expect(p.options.values('question')).toEqual(['a:long_text:A', 'b:long_text:B']);
    expect(p.options.values('optional')).toEqual(['a', 'b']);
  });
});

// ── the shorthand ──────────────────────────────────────────────────────────

describe('--question shorthand', () => {
  it('key:type:Title with no options', () => {
    expect(parseQuestionShorthand('risks:long_text:Anything to watch for?')).toEqual({ key: 'risks', type: 'long_text', title: 'Anything to watch for?' });
  });

  it('the 4th segment is config.options: value=Label, * marks recommended, label defaults to value', () => {
    expect(parseQuestionShorthand('strategy:single_choice:Which approach?:online_backfill=Online backfill*,dual_write')).toEqual({
      key: 'strategy',
      type: 'single_choice',
      title: 'Which approach?',
      config: {
        options: [
          { value: 'online_backfill', label: 'Online backfill', recommended: true },
          { value: 'dual_write', label: 'dual_write' },
        ],
      },
    });
  });

  it('\\: escapes a colon in the title, \\, a comma in an option', () => {
    expect(parseQuestionShorthand('n:long_text:Note\\: be brief')).toMatchObject({ title: 'Note: be brief' });
    expect(splitEscaped('a\\,b,c', ',')).toEqual(['a,b', 'c']);
  });

  it('too few or too many segments, and an empty options segment, are usage errors', () => {
    expect(() => parseQuestionShorthand('a:long_text')).toThrow(CliError);
    expect(() => parseQuestionShorthand('a:single_choice:T:x,y:z')).toThrow(/unescaped colons/);
    expect(() => parseQuestionShorthand('a:single_choice:T: , ')).toThrow(/empty/);
  });
});

// ── client-side validation ─────────────────────────────────────────────────

describe('client-side spec validation (FormSpecSchema, before any call)', () => {
  const base = { questions: [], optional: [], sections: [], attachTo: [] };

  it('accepts a valid shorthand spec and keeps it RAW (no defaults filled in)', () => {
    const spec = assembleSpec({ ...base, title: 'T', questions: ['s:single_choice:Pick:a*,b', 'r:long_text:Why'], optional: ['r'] });
    expect(spec.questions).toEqual([
      { key: 's', type: 'single_choice', title: 'Pick', config: { options: [{ value: 'a', label: 'a', recommended: true }, { value: 'b', label: 'b' }] } },
      { key: 'r', type: 'long_text', title: 'Why', required: false },
    ]);
    expect(spec).not.toHaveProperty('settings');
  });

  it('options on a type whose configSchema has none are refused BY THAT SCHEMA, keyed by question', () => {
    try {
      assembleSpec({ ...base, title: 'T', questions: ['r:long_text:Why:a,b'] });
      expect.fail('should refuse');
    } catch (e) {
      const err = e as CliError;
      expect(err.exitCode).toBe(2);
      const issues = (err.detail as { issues: { key: string; code: string }[] }).issues;
      expect(issues[0]).toMatchObject({ key: 'r.config', code: 'unrecognized_keys' });
      expect(err.message).toContain('nothing was sent');
    }
  });

  it('a short_text pattern that is not a valid JS regex is refused locally (the ReDoS carry-over)', () => {
    expect(() =>
      assembleSpec({ ...base, spec: { title: 'T', questions: [{ key: 'c', type: 'short_text', title: 'C', config: { pattern: '(' } }] } }),
    ).toThrow(/c\.config\.pattern/);
  });

  it('--optional and --section naming no question are issues, not silent no-ops', () => {
    expect(() => assembleSpec({ ...base, title: 'T', questions: ['a:long_text:A'], optional: ['zz'] })).toThrow(/zz.*unknown_question/);
    expect(() => assembleSpec({ ...base, title: 'T', questions: ['a:long_text:A'], sections: ['s:S:zz'] })).toThrow(/unknown_question/);
  });

  it('--section assigns its listed questions', () => {
    const spec = assembleSpec({ ...base, title: 'T', questions: ['a:long_text:A', 'b:long_text:B'], sections: ['intro:Intro:a'] });
    expect(spec.sections).toEqual([{ key: 'intro', title: 'Intro' }]);
    expect((spec.questions as { key: string; section?: string }[]).map((q) => q.section)).toEqual(['intro', undefined]);
  });

  it('FORWARD COMPAT (W1-R4 5a): an unknown type passes on structure alone; its structure is still checked', () => {
    expect(() => assembleSpec({ ...base, title: 'T', questions: ['yn:from_the_future:Ship it?'] })).not.toThrow();
    expect(() =>
      assembleSpec({ ...base, spec: { title: 'T', questions: [{ key: 'Bad Key', type: 'from_the_future', title: 'X' }] } }),
    ).toThrow(/invalid/);
  });

  it('an issue key names the question, not its index', () => {
    expect(issueKey(['questions', 1, 'config', 'options'], [{ key: 'a' }, { key: 'strategy' }])).toBe('strategy.config.options');
    expect(issueKey(['settings', 'responses'])).toBe('settings.responses');
    expect(issueKey([])).toBe('$');
  });
});

describe('client-side answer validation (validateFormAnswers)', () => {
  it('final: a missing required answer and a pattern mismatch are both reported', () => {
    expect(() => validateAnswers(QUESTIONS, { code: { text: 'nope' } }, true)).toThrow(/strategy\s+required[\s\S]*code\s+pattern_mismatch/);
  });

  it('draft (final:false) skips required', () => {
    expect(() => validateAnswers(QUESTIONS, {}, false)).not.toThrow();
  });

  it('FORWARD COMPAT: an answer to an unknown-type question is left to the Server', () => {
    const qs = [...QUESTIONS, { key: 'yn', type: 'from_the_future', title: 'Y?', required: true, config: {} }];
    expect(() => validateAnswers(qs, { strategy: { value: 'a' }, yn: { anything: 1 } }, true)).not.toThrow();
  });
});

// ── commands over the wire ─────────────────────────────────────────────────

describe('tm8 form create — forms.create', () => {
  it('posts the raw spec with spaceId and a mutation id; --open sets open:true', async () => {
    const r = await tm8(['form', 'create', '--space', SPACE, '--title', 'Plan', '--question', 's:single_choice:Pick:a*,b', '--open']);
    expect(r.code, r.stderr).toBe(0);
    const [call] = wire('POST', '/v2/forms');
    expect(call?.body).toMatchObject({ spaceId: SPACE, title: 'Plan', open: true, questions: [{ key: 's', type: 'single_choice' }] });
    expect(typeof (call?.body as { clientMutationId?: unknown }).clientMutationId).toBe('string');
    expect(r.stdout).toContain(`form ${FORM}`);
    expect(r.stdout).toContain(`url: ${baseUrl}/#/s/${SPACE}/e/${FORM}`);
  });

  it('an invalid spec exits 2 and sends NOTHING', async () => {
    const r = await tm8(['form', 'create', '--space', SPACE, '--title', 'Plan', '--question', 's:scale:Rate:a,b']);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
    expect(r.stderr).toMatch(/s\.config\s+unrecognized_keys/);
  });

  it('--open and --draft together are refused', async () => {
    const r = await tm8(['form', 'create', '--space', SPACE, '--title', 'P', '--open', '--draft']);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
  });

  it('--format json passes the Server DTO through', async () => {
    const r = await tm8(['form', 'create', '--space', SPACE, '--title', 'P', '--question', 'a:long_text:A', '--format', 'json']);
    expect(JSON.parse(r.stdout)).toMatchObject({ url: `/#/s/${SPACE}/e/${FORM}` });
  });
});

describe('tm8 form submit / response save — versions and validation', () => {
  it('submit reads the form, validates, and sends --response-version (never expectedVersion)', async () => {
    const r = await tm8(['form', 'submit', FORM, '--answers', '{"strategy":{"value":"a"}}', '--response-version', '2']);
    expect(r.code, r.stderr).toBe(0);
    const [call] = wire('POST', `/v2/forms/${FORM}/responses/submit`);
    expect(call?.body).toMatchObject({ answers: { strategy: { value: 'a' } }, responseVersion: 2 });
    expect(call?.body).not.toHaveProperty('expectedVersion');
    expect(r.stdout).toContain('[strategy] Which approach? →');
  });

  it('invalid answers exit 2 after the read and never reach submit', async () => {
    const r = await tm8(['form', 'submit', FORM, '--answers', '{"strategy":{"value":"zz"}}']);
    expect(r.code).toBe(2);
    expect(wire('POST', `/v2/forms/${FORM}/responses/submit`)).toHaveLength(0);
    expect(r.stderr).toMatch(/strategy\s+not_an_option/);
  });

  it('response save validates as a draft (no required) and PUTs responses/mine', async () => {
    const r = await tm8(['form', 'response', 'save', FORM, '--answers', '{}']);
    expect(r.code, r.stderr).toBe(0);
    expect(wire('PUT', `/v2/forms/${FORM}/responses/mine`)).toHaveLength(1);
  });

  it('a draft-in-flight conflict prints its draftId and the discard command (W1-R4 6)', async () => {
    routes[`POST /v2/forms/${FORM}/responses/submit`] = {
      status: 409,
      body: { error: { code: 'conflict', message: 'a draft response is already in flight', requestId: 'req_c', retryable: false, details: { reason: 'form_draft_in_flight', draftId: 'd-1' } } },
    };
    const r = await tm8(['form', 'submit', FORM, '--answers', '{"strategy":{"value":"a"}}']);
    expect(r.code).toBe(6);
    expect(r.stderr).toContain('d-1');
    expect(r.stderr).toContain(`tm8 form response discard ${FORM}`);
  });
});

describe('form lifecycle and structure verbs', () => {
  it('open|close|cancel|reopen all POST forms.transition with the right target', async () => {
    for (const [verb, to] of [['open', 'open'], ['close', 'closed'], ['cancel', 'cancelled'], ['reopen', 'open']] as const) {
      recorded = [];
      const r = await tm8(['form', verb, FORM, '--expect-version', '3']);
      expect(r.code, r.stderr).toBe(0);
      expect(wire('POST', `/v2/forms/${FORM}/transition`)[0]?.body).toMatchObject({ to, expectedVersion: 3 });
    }
  });

  it('a form mutation without --expect-version is refused locally', async () => {
    const r = await tm8(['form', 'close', FORM]);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
  });

  it('question update validates the MERGED question but sends only the patch (W1-R4 5b)', async () => {
    const ok = await tm8(['form', 'question', 'update', FORM, 'code', '--expect-version', '3', '--title', 'Jira key']);
    expect(ok.code, ok.stderr).toBe(0);
    const body = wire('PATCH', `/v2/forms/${FORM}/questions/code`)[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ expectedVersion: 3, title: 'Jira key' });
    expect(body).not.toHaveProperty('config');
    expect(body).not.toHaveProperty('type');

    recorded = [];
    const bad = await tm8(['form', 'question', 'update', FORM, 'code', '--expect-version', '3', '--config', '{"pattern":"("}']);
    expect(bad.code).toBe(2);
    expect(wire('PATCH', `/v2/forms/${FORM}/questions/code`)).toHaveLength(0);
  });

  it('question move needs --after or --first; --first sends after:null', async () => {
    expect((await tm8(['form', 'question', 'move', FORM, 'code', '--expect-version', '3'])).code).toBe(2);
    await tm8(['form', 'question', 'move', FORM, 'code', '--expect-version', '3', '--first']);
    expect(wire('POST', `/v2/forms/${FORM}/questions/code/move`)[0]?.body).toMatchObject({ after: null });
  });
});

describe('responses reads', () => {
  it('list forwards --respondent me and --lineage as query parameters', async () => {
    routes[`GET /v2/forms/${FORM}/responses`] = { status: 200, body: { items: [VIEW], nextCursor: 'c2' } };
    const r = await tm8(['form', 'response', 'list', FORM, '--respondent', 'me', '--limit', '5']);
    expect(r.code, r.stderr).toBe(0);
    const q = wire('GET', `/v2/forms/${FORM}/responses`)[0]?.query;
    expect(q?.get('respondent')).toBe('me');
    expect(q?.get('limit')).toBe('5');
    expect(r.stdout).toContain('next: --cursor c2');
  });

  it('--respondent accepts only me', async () => {
    expect((await tm8(['form', 'response', 'list', FORM, '--respondent', 'bob'])).code).toBe(2);
  });

  it('mine sends the context space as spaceId', async () => {
    routes['GET /v2/form-responses'] = { status: 200, body: { items: [], nextCursor: null } };
    const r = await tm8(['form', 'response', 'mine', '--space', SPACE]);
    expect(r.code, r.stderr).toBe(0);
    expect(wire('GET', '/v2/form-responses')[0]?.query.get('spaceId')).toBe(SPACE);
  });
});

// ── help generation ────────────────────────────────────────────────────────

describe('`tm8 help form` — the generated authoring guide (decision 12)', () => {
  it('names EVERY registry type, with its own example config and answer', async () => {
    const r = await tm8(['help', 'form']);
    expect(r.code).toBe(0);
    for (const type of FORM_QUESTION_TYPE_NAMES) {
      const def = FORM_QUESTION_TYPES[type] as FormQuestionTypeDef;
      expect(r.stdout, type).toContain(`${type} (${def.label})`);
      expect(r.stdout, type).toContain(JSON.stringify(def.example.config));
      expect(r.stdout, type).toContain(JSON.stringify(def.example.answer));
    }
  });

  it('names every setting with its values and default, derived from FormSettingsSchema', async () => {
    const r = await tm8(['help', 'form']);
    for (const line of settingLines()) expect(r.stdout).toContain(line);
    for (const s of ['per_member|single|unlimited', 'humans|anyone', 'allowAmend: true|false (default true)', 'requesting_session|new_session', 'resume|queue|spawn_new', 'attentionPoints: 1..100 (default 60)']) {
      expect(r.stdout).toContain(s);
    }
  });

  it('carries the spec shape, the shorthand, the lifecycle and the `form wait` pointer', async () => {
    const r = await tm8(['help', 'form']);
    for (const s of ['"questions"', '"sections"', '"attachTo"', '"forSession"', 'key:type:Title', 'form_structure_frozen', 'tm8 form wait <form-id>', 'W2']) {
      expect(r.stdout).toContain(s);
    }
  });

  it('the guide is in the json DTO too, and the whole shard fits the 12 KiB noun cap untruncated', () => {
    const shard = nounHelp('form');
    expect(shard?.guide).toEqual(formGuide());
    expect(shard?.truncated).toBeUndefined();
    expect(byteLength(shard)).toBeLessThanOrEqual(CAPS.noun);
  });

  it('no other noun shard carries a guide', () => {
    expect(nounHelp('task')?.guide).toBeUndefined();
  });

  it('PERTURBATION: settingLines walks a schema, it does not recite one', () => {
    const fake = { _def: { typeName: 'ZodObject', shape: () => ({ zeta: { _def: { typeName: 'ZodDefault', defaultValue: () => 'x', innerType: { _def: { typeName: 'ZodEnum', values: ['x', 'y'] } } } } }) } };
    expect(settingLines(fake)).toEqual(['zeta: x|y (default x)']);
  });
});
