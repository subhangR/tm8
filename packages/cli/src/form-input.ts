/**
 * `tm8 form` input: the `--question` shorthand, spec assembly, and the
 * CLIENT-SIDE validation every form command runs before it calls.
 *
 * WHY THE CLI VALIDATES (advisor ruling W1-R2). The forms.* wire schemas carry
 * questions RAW (`FormQuestionWireSchema`): structure only, config as written.
 * The server's only config and answer validator is SQL, which never compiles
 * an author's `pattern` in JS (the W0 ReDoS note). So the contract's own
 * `FormSpecSchema`, `FormQuestionSchema` and `validateFormAnswers` run HERE,
 * and a spec or an answer set that fails them never reaches the network: it
 * exits 2 with one `key  code  message` line per issue.
 *
 * NOTHING HERE SWITCHES ON QUESTION TYPE. The shorthand's fourth segment is
 * always `config.options` — a SHAPE the choice types share, exactly as the
 * contract's `FormOptionSchema` is — and the type's own `configSchema` then
 * accepts or refuses it. A new registry entry needs no change in this file.
 *
 * FORWARD COMPATIBILITY (advisor ruling W1-R4 5a). A question whose type this
 * CLI's registry does not know — a newer Server shipped it — is checked for
 * STRUCTURE only (`FormQuestionWireSchema`), and its config and answers are
 * left to the Server's SQL arm. Refusing locally what this build cannot
 * recognise would make an older CLI veto a newer Server.
 *
 * WHAT GOES ON THE WIRE IS WHAT THE CALLER WROTE. Parsing applies defaults
 * (`required: true`, `maxLength: 500`, every setting), but settings are stored
 * sparse and defaults apply on read (§3.3), so the request carries the raw,
 * validated input, never the defaulted parse.
 */
import {
  FormQuestionSchema,
  FormQuestionWireSchema,
  FormSectionSchema,
  FormSettingsPatchSchema,
  FormSpecSchema,
  formQuestionTypeDef,
  validateFormAnswers,
  type FormAnswerIssue,
  type FormQuestionRef,
} from '@tm8/contract';
import { CliError, EXIT_USAGE } from './exit.js';

/** One located problem: the shape of a 422 `form_answers_invalid` issue. */
export type FormInputIssue = FormAnswerIssue;

/** The structural subset of a Zod issue this module reads. No zod import. */
interface ZodIssueLike {
  path: readonly (string | number)[];
  code: string;
  message: string;
}

type SafeParse = { success: true } | { success: false; error: { issues: readonly ZodIssueLike[] } };

/**
 * A Zod path as an issue key. A path into `questions[i]` is named by that
 * question's KEY when it has one — `strategy.config.options` tells an author
 * which question to fix; `questions.3.config.options` makes them count.
 */
export function issueKey(path: readonly (string | number)[], questions?: readonly unknown[]): string {
  if (path.length === 0) return '$';
  const parts = [...path];
  if (parts[0] === 'questions' && typeof parts[1] === 'number' && questions !== undefined) {
    const key = (questions[parts[1]] as { key?: unknown } | undefined)?.key;
    if (typeof key === 'string' && key.length > 0) return [key, ...parts.slice(2)].join('.');
  }
  return parts.map((p) => (typeof p === 'number' ? `[${p}]` : p)).join('.').replace(/\.\[/g, '[');
}

function issuesOf(result: SafeParse, prefix: readonly (string | number)[] = [], questions?: readonly unknown[]): FormInputIssue[] {
  if (result.success) return [];
  return result.error.issues.map((i) => ({
    key: issueKey([...prefix, ...i.path], questions),
    code: i.code,
    message: i.message,
  }));
}

/** `key  code  message`, one line per issue, aligned for a terminal. */
export function formatIssues(issues: readonly FormInputIssue[]): string[] {
  const kw = Math.max(...issues.map((i) => i.key.length));
  const cw = Math.max(...issues.map((i) => i.code.length));
  return issues.map((i) => `  ${i.key.padEnd(kw)}  ${i.code.padEnd(cw)}  ${i.message}`);
}

/**
 * Refuse locally, exit 2, never reaching the network. `detail` carries the
 * issues in the same `{reason, issues}` shape a 422 from the Server does, so a
 * caller handles a local refusal and a remote one with one code path.
 */
export function refuseIfInvalid(what: string, issues: readonly FormInputIssue[]): void {
  if (issues.length === 0) return;
  throw new CliError(
    `${what} is invalid (${issues.length} issue${issues.length === 1 ? '' : 's'}; nothing was sent)\n${formatIssues(issues).join('\n')}`,
    EXIT_USAGE,
    {
      detail: { reason: 'form_input_invalid', issues },
      hint: 'the shapes and one example per question type: `tm8 help form`',
    },
  );
}

// ── the --question shorthand ───────────────────────────────────────────────

/** Split on an unescaped separator; `\<sep>` is a literal, `\\` a backslash. */
export function splitEscaped(raw: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (ch === '\\' && (raw[i + 1] === sep || raw[i + 1] === '\\')) {
      cur += raw[i + 1];
      i++;
    } else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export const QUESTION_SHORTHAND = 'key:type:Title[:value[=Label][*],value…]';

/**
 * `key:type:Title[:options]` → a raw question. The options segment is a comma
 * list of `value[=Label]`, with a trailing `*` marking the recommended one.
 * Escape a literal `:` or `,` with a backslash.
 */
export function parseQuestionShorthand(raw: string): Record<string, unknown> {
  const segs = splitEscaped(raw, ':');
  const bad = (why: string) =>
    new CliError(`--question ${JSON.stringify(raw)}: ${why}`, EXIT_USAGE, {
      hint: `shorthand: ${QUESTION_SHORTHAND}; escape a literal colon in the title as \\:`,
    });
  if (segs.length < 3) throw bad('needs at least key:type:Title');
  if (segs.length > 4) throw bad(`has ${segs.length - 1} unescaped colons (at most 3)`);
  const [key, type, title, options] = segs.map((s) => s.trim()) as [string, string, string, string | undefined];
  const question: Record<string, unknown> = { key, type, title };
  if (options !== undefined) {
    const items = splitEscaped(options, ',').map((s) => s.trim()).filter((s) => s.length > 0);
    if (items.length === 0) throw bad('the options segment is empty');
    question.config = {
      options: items.map((item) => {
        const recommended = item.endsWith('*');
        const body = recommended ? item.slice(0, -1).trim() : item;
        const eq = body.indexOf('=');
        const value = (eq < 0 ? body : body.slice(0, eq)).trim();
        const label = (eq < 0 ? body : body.slice(eq + 1)).trim();
        return { value, label, ...(recommended ? { recommended: true } : {}) };
      }),
    };
  }
  return question;
}

/** `key:Title[:q1,q2]` → a section plus the question keys it claims. */
export function parseSectionShorthand(raw: string): { section: Record<string, unknown>; members: string[] } {
  const segs = splitEscaped(raw, ':').map((s) => s.trim());
  if (segs.length < 2 || segs.length > 3) {
    throw new CliError(`--section ${JSON.stringify(raw)}: expected key:Title[:question-key,…]`, EXIT_USAGE);
  }
  const members = segs[2] === undefined ? [] : segs[2].split(',').map((s) => s.trim()).filter(Boolean);
  return { section: { key: segs[0], title: segs[1] }, members };
}

// ── spec assembly (form create) ────────────────────────────────────────────

export interface SpecFlags {
  /** The parsed `--spec` object, or undefined. */
  spec?: Record<string, unknown>;
  title?: string;
  description?: string;
  questions: readonly string[];
  optional: readonly string[];
  sections: readonly string[];
  settings?: unknown;
  open?: boolean;
  forSession?: string;
  attachTo: readonly string[];
}

/**
 * Merge `--spec` with the flags into ONE raw spec, and validate it with the
 * contract's `FormSpecSchema`. Flags win over the spec for scalars, and add to
 * it for lists (shorthand questions append; `--attach` appends).
 */
export function assembleSpec(flags: SpecFlags): Record<string, unknown> {
  const spec: Record<string, unknown> = { ...(flags.spec ?? {}) };
  if (flags.title !== undefined) spec.title = flags.title;
  if (flags.description !== undefined) spec.description = flags.description;
  if (flags.settings !== undefined) spec.settings = flags.settings;
  if (flags.open !== undefined) spec.open = flags.open;
  if (flags.forSession !== undefined) spec.forSession = flags.forSession;
  if (flags.attachTo.length > 0) {
    spec.attachTo = [...(Array.isArray(spec.attachTo) ? spec.attachTo : []), ...flags.attachTo];
  }

  const shorthand = flags.questions.map(parseQuestionShorthand);
  const questions: Record<string, unknown>[] = [
    ...(Array.isArray(spec.questions) ? (spec.questions as Record<string, unknown>[]) : []),
    ...shorthand,
  ];
  const issues: FormInputIssue[] = [];
  const byKey = new Map(questions.map((q) => [q.key, q]));

  for (const key of flags.optional) {
    const q = byKey.get(key);
    if (q === undefined) issues.push({ key, code: 'unknown_question', message: '--optional names no question' });
    else byKey.set(key, Object.assign(q, { required: false }));
  }

  if (flags.sections.length > 0) {
    const sections = [...(Array.isArray(spec.sections) ? (spec.sections as unknown[]) : [])];
    const claimed = new Map<string, string>();
    for (const raw of flags.sections) {
      const { section, members } = parseSectionShorthand(raw);
      sections.push(section);
      for (const m of members) {
        const q = byKey.get(m);
        if (q === undefined) {
          issues.push({ key: m, code: 'unknown_question', message: `--section ${String(section.key)} names no question` });
        } else if (claimed.has(m)) {
          issues.push({ key: m, code: 'duplicate_section', message: `already in section ${claimed.get(m)}` });
        } else {
          claimed.set(m, String(section.key));
          q.section = section.key;
        }
      }
    }
    spec.sections = sections;
  }
  spec.questions = questions;

  refuseIfInvalid('form spec', issues);
  refuseIfInvalid('form spec', specIssues(spec, questions));
  return spec;
}

/** A question type this build's registry does not know (a newer Server's). */
export function isUnknownType(question: unknown): boolean {
  const type = (question as { type?: unknown } | null)?.type;
  return typeof type === 'string' && formQuestionTypeDef(type) === undefined;
}

/**
 * `FormSpecSchema` issues, minus those under an unknown-type question, which
 * is checked for structure alone instead (see the forward-compatibility note).
 */
function specIssues(spec: Record<string, unknown>, questions: readonly Record<string, unknown>[]): FormInputIssue[] {
  const unknown = new Set(questions.flatMap((q, i) => (isUnknownType(q) ? [i] : [])));
  const result = FormSpecSchema.safeParse(spec) as SafeParse;
  const kept: SafeParse = result.success
    ? result
    : { success: false, error: { issues: result.error.issues.filter((i) => !(i.path[0] === 'questions' && unknown.has(i.path[1] as number))) } };
  return [
    ...issuesOf(kept, [], questions),
    ...[...unknown].flatMap((i) => issuesOf(FormQuestionWireSchema.safeParse(questions[i]) as SafeParse, ['questions', i], questions)),
  ];
}

// ── single-question and patch validation ───────────────────────────────────

/** One question, as `form question add` sends it. */
export function validateQuestion(question: Record<string, unknown>): void {
  const schema = isUnknownType(question) ? FormQuestionWireSchema : FormQuestionSchema;
  refuseIfInvalid('question', issuesOf(schema.safeParse(question) as SafeParse, ['questions', 0], [question]));
}

/** A settings patch (`--settings`), strict: an unknown key is a typo, not a no-op. */
export function validateSettingsPatch(settings: unknown): void {
  refuseIfInvalid('--settings', issuesOf(FormSettingsPatchSchema.safeParse(settings) as SafeParse, ['settings']));
}

/** A sections list (`form update --sections`). */
export function validateSections(sections: unknown): void {
  if (!Array.isArray(sections)) {
    refuseIfInvalid('--sections', [{ key: 'sections', code: 'invalid_type', message: 'expected a JSON array of sections' }]);
    return;
  }
  const issues = sections.flatMap((s, i) => issuesOf(FormSectionSchema.safeParse(s) as SafeParse, ['sections', i]));
  refuseIfInvalid('--sections', issues);
}

/**
 * Answers against the form's stored questions — the registry's own
 * `validateFormAnswers`. `final: false` is a draft save (shape and bounds,
 * no `required`); submit is `final: true`.
 */
export function validateAnswers(questions: readonly FormQuestionRef[], answers: unknown, final: boolean): void {
  const unknown = new Set(questions.filter(isUnknownType).map((q) => q.key));
  const issues = validateFormAnswers(questions, answers, { final }).filter((i) => !unknown.has(i.key));
  refuseIfInvalid(final ? 'answers' : 'draft answers', issues);
}
