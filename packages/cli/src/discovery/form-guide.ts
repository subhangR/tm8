/**
 * The `form` noun's authoring guide — decision 12: `tm8 help form` ALONE must
 * be enough to author a form.
 *
 * GENERATED FROM THE CONTRACT, NOT RESTATED. The per-type section walks
 * `FORM_QUESTION_TYPES` and prints each entry's own `example` (config and
 * answer) and the keys of its own `configSchema`, so a new registry entry
 * appears here with no change to this file. The settings section walks
 * `FormSettingsSchema` for every key, its values and its default. Nothing here
 * switches on a question type or names one.
 *
 * It rides on the noun shard as `guide`, inside the 12 KiB cap
 * (`CAPS.noun`); `test/form.test.ts` measures it.
 */
import { FORM_QUESTION_TYPES, FORM_TRANSITIONS, FormSettingsSchema, type FormQuestionTypeDef } from '@tm8/contract';
import { QUESTION_SHORTHAND } from '../form-input.js';

export interface GuideSection {
  title: string;
  lines: readonly string[];
}

/** The duck-typed slice of a Zod schema this walker reads. No zod import. */
interface ZodLike {
  _def: {
    typeName?: string;
    schema?: ZodLike;
    innerType?: ZodLike;
    defaultValue?: () => unknown;
    values?: readonly string[];
    checks?: readonly { kind: string; value?: number }[];
    shape?: () => Record<string, ZodLike>;
    options?: readonly ZodLike[];
  };
}

/** Peel effects/optional/default wrappers off to the object underneath. */
function objectShape(schema: unknown): Record<string, ZodLike> | undefined {
  let t = schema as ZodLike | undefined;
  for (let i = 0; i < 8 && t?._def; i++) {
    if (t._def.typeName === 'ZodObject' && t._def.shape) return t._def.shape();
    t = t._def.schema ?? t._def.innerType;
  }
  return undefined;
}

/** `a|b|c`, `true|false`, `1..100` — the values a setting accepts. */
function valuesOf(t: ZodLike): string {
  const d = t._def;
  if (d.typeName === 'ZodEnum' && d.values) return d.values.join('|');
  if (d.typeName === 'ZodBoolean') return 'true|false';
  if (d.typeName === 'ZodNumber') {
    const min = d.checks?.find((c) => c.kind === 'min')?.value;
    const max = d.checks?.find((c) => c.kind === 'max')?.value;
    return `${min ?? ''}..${max ?? ''}`;
  }
  return d.typeName ?? '?';
}

/** Every leaf setting as `path: values (default x)`, nested objects dotted. */
export function settingLines(schema: unknown = FormSettingsSchema, prefix = ''): string[] {
  const shape = objectShape(schema);
  if (shape === undefined) return [];
  const out: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    let t = field;
    let dflt: unknown;
    while (t._def.typeName === 'ZodDefault' || t._def.typeName === 'ZodOptional') {
      if (t._def.typeName === 'ZodDefault' && dflt === undefined) dflt = t._def.defaultValue?.();
      t = t._def.innerType as ZodLike;
    }
    if (t._def.typeName === 'ZodObject') {
      out.push(...settingLines(t, `${prefix}${key}.`));
      continue;
    }
    out.push(`${prefix}${key}: ${valuesOf(t)}${dflt === undefined ? '' : ` (default ${String(dflt)})`}`);
  }
  return out;
}

/** One entry's lines: its keys, and its own example config and answer. */
function typeLines(def: FormQuestionTypeDef): string[] {
  const keys = Object.keys(objectShape(def.configSchema) ?? {});
  return [
    `${def.type} (${def.label}) config keys: ${keys.length > 0 ? keys.join(', ') : '(none)'}`,
    `  config ${JSON.stringify(def.example.config)}  answer ${JSON.stringify(def.example.answer)}`,
  ];
}

export function formGuide(): GuideSection[] {
  const defs = Object.values(FORM_QUESTION_TYPES) as FormQuestionTypeDef[];
  const first = defs[0] as FormQuestionTypeDef;
  return [
    {
      title: 'author a form',
      lines: [
        "tm8 form create --title '…' --spec <json-source>   (inline JSON, @file, or - for stdin)",
        `tm8 form create --title '…' --question '${QUESTION_SHORTHAND}' … [--optional <key>]`,
        'the spec, shorthand and answers are validated locally first: an invalid one exits 2, one `key code message` line per issue, nothing sent',
        'the create receipt prints the form id, version and url; answers arrive in YOUR session as a message',
      ],
    },
    {
      title: 'spec (--spec)',
      lines: [
        '{ "title": "…",  "description": "…",                        title 1..300 chars',
        '  "sections": [{"key":"…","title":"…","help":"…"}],          optional, one heading each',
        '  "questions": [{"key":"snake_case","type":"<type>","title":"…","help":"…",',
        '                 "required":true,"section":"<section-key>","config":{…}}],',
        '  "settings": {…},  "open": true|false,  "forSession": "<session-id>",  "attachTo": ["<entity-id>"] }',
        'keys: ^[a-z][a-z0-9_]{0,63}$; required defaults to true; config is per type, below',
      ],
    },
    { title: 'question types (config keys, then one valid config and answer each)', lines: defs.flatMap(typeLines) },
    {
      title: '--question shorthand',
      lines: [
        `'${QUESTION_SHORTHAND}'  — the 4th segment sets options (choice types): value=Label, * marks recommended`,
        'any other config (scale min/max, maxLength, pattern, display, allowOther…) goes through --spec or `form question update --config`',
        '\\: escapes a colon, \\, a comma; --optional <key> (repeatable) sets required:false; --section key:Title[:q1,q2]',
      ],
    },
    {
      title: 'settings (--settings, sparse; unset keys keep their default)',
      lines: [
        ...settingLines(),
        'responses: per_member = one current response per member; single = one on the whole form; unlimited = many chains per member',
        'respondents: humans refuses agents; allowAmend: resubmitting makes a new revision, delivered again, history kept',
        'delivery.target: the requesting session or a new one; onSessionNotLive: resume it, queue for it, or spawn_new',
        'attentionPoints: the attention raised on open, resolved on submit',
      ],
    },
    {
      title: 'answers (--answers)',
      lines: [
        '{ "<question-key>": <answer>, … }  — null or absent = unanswered; the answer shapes are the examples above',
        `tm8 form submit <form-id> --answers '${JSON.stringify({ q1: first.example.answer })}'`,
        'drafts: form response save (no required check) · form submit (full check) · form response discard',
        '--response-version guards YOUR response; --amend-of <response-id> names the revision edited (only under unlimited)',
      ],
    },
    {
      title: 'lifecycle',
      lines: [
        `transitions (from -> to): ${Object.entries(FORM_TRANSITIONS).map(([f, t]) => `${f} -> ${t.join('|') || '(terminal)'}`).join(';  ')}`,
        'verbs: form open (draft->open) · close · reopen (closed->open) · cancel (the requester is told)',
        'agents create open, humans draft (--open/--draft); closeOnSubmit closes on the first submit',
        'questions, sections and settings.responses FREEZE at the first submitted response (form_structure_frozen)',
        'author writes take --expect-version (the FORM\'s); read it with `tm8 entity context <form-id>`',
      ],
    },
    {
      title: 'errors',
      lines: [
        'form_answers_invalid (422, details.issues[{key,code,message}]) · form_not_open · form_structure_frozen',
        'form_response_limit · form_respondent_not_allowed · conflict (a draft in flight: its draftId; a taken key; form_transition_invalid)',
        'version_conflict (re-read, then retry deliberately) · local validation: exit 2',
      ],
    },
    {
      title: 'waiting for an answer',
      lines: [
        'tm8 form wait <form-id> [--timeout <seconds>] — W2: blocks until a response arrives (not in this build)',
        'meanwhile the answer arrives in your session as a message; or poll `tm8 form response list <form-id>`',
      ],
    },
  ];
}
