import { CollabError } from '@tm8/contract';

/**
 * One message per definition-form field, keyed by its path in the definition:
 * `name`, `timeoutSeconds`, `inputs`, `inputs.3` (the whole row) or
 * `inputs.3.default`.
 */
export type FieldErrors = Readonly<Record<string, string>>;

/** A refused save or create, placed on the form. */
export interface DefinitionProblem {
  /** Shown above the form: the server's own message, plus anything no field can show. */
  message: string | null;
  fields: FieldErrors;
}

/** A zod issue's placeable part; `code`/`validation` ride along when the source had them. */
interface Issue { path: readonly (string | number)[]; message: string; code?: string; validation?: unknown }

const FORM_FIELDS = new Set(['name', 'description', 'runtime', 'source', 'inputs', 'help', 'tm8Access', 'timeoutSeconds']);
const INPUT_FIELDS = new Set(['name', 'type', 'required', 'description', 'flag', 'short', 'env', 'options', 'default', 'min', 'max']);

const errorText = (failure: unknown) => failure instanceof Error ? failure.message : 'The request could not be completed.';

/** The field a definition-relative issue path names, or null when the form has no such field. */
export function fieldKeyOf(path: readonly (string | number)[]): string | null {
  const [head, index, field] = path;
  if (typeof head !== 'string' || !FORM_FIELDS.has(head)) return null;
  if (head !== 'inputs' || typeof index !== 'number') return head;
  return typeof field === 'string' && INPUT_FIELDS.has(field) ? `inputs.${index}.${field}` : `inputs.${index}`;
}

/** Zod-shaped issues from anything that carries them (a ZodError, or the wire's `details.issues`). */
export function issuesOf(value: unknown): Issue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const issue = item as { path?: unknown; message?: unknown; code?: unknown; validation?: unknown };
    if (!Array.isArray(issue.path) || typeof issue.message !== 'string' || !issue.path.every(part => typeof part === 'string' || typeof part === 'number')) return [];
    return [{ path: issue.path as (string | number)[], message: issue.message,
      ...(typeof issue.code === 'string' ? { code: issue.code } : {}), ...(issue.validation !== undefined ? { validation: issue.validation } : {}) }];
  });
}

/**
 * Issues whose path starts with `prefix` land on the field the rest of the
 * path names (the first message per field wins); every other issue is
 * returned in `unplaced`, prefixed with its path so it still says where.
 */
export function placeIssues(issues: readonly Issue[], prefix: readonly (string | number)[] = []): { fields: Record<string, string>; unplaced: string[] } {
  const fields: Record<string, string> = {};
  const unplaced: string[] = [];
  for (const issue of issues) {
    const inside = prefix.every((part, at) => issue.path[at] === part);
    const key = inside ? fieldKeyOf(issue.path.slice(prefix.length)) : null;
    if (key) fields[key] ??= issue.message;
    else unplaced.push(issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message);
  }
  return { fields, unplaced };
}

/**
 * Where a refused `tools.create`/`tools.update` belongs on the form. The
 * server's message is never replaced: `invalid_input` from contract
 * validation carries zod issues whose paths (`definition.inputs.3.default`)
 * name the field, and the message heads the form; a refusal without a path
 * is shown at the top in the server's words. A duplicate name is the one
 * unique violation a definition write can raise (SQLSTATE 23505, decided by
 * code, never by message text), so it is shown on Name.
 */
export function definitionProblemOf(failure: unknown): DefinitionProblem {
  if (!(failure instanceof CollabError)) return { message: errorText(failure), fields: {} };
  const issues = issuesOf(failure.details?.issues);
  if (issues.length) {
    const { fields, unplaced } = placeIssues(issues, ['definition']);
    return { message: [failure.message, ...unplaced].join(' · '), fields };
  }
  if (failure.code === 'invariant_violation' && failure.details?.sqlstate === '23505') return { message: null, fields: { name: failure.message } };
  return { message: failure.message, fields: {} };
}

// ---------------------------------------------------------------------------
// Refusals shown as the server gave them (tool page v2: run, configuration,
// secret and load surfaces). The component that renders one is ToolErrorAlert.
// ---------------------------------------------------------------------------

/**
 * A refusal as the server gave it: its taxonomy code and its own message,
 * under a short title for the surface that failed. The server's sentence is
 * the useful part (the session cap and its remedy, the missing input names,
 * the credential it would not lend), so it is never replaced.
 */
export interface ToolErrorView { code: string | null; title: string; message: string }
export type ToolErrorContext = 'run' | 'config' | 'secret' | 'load';

const TITLES: Record<ToolErrorContext, Partial<Record<string, string>> & { fallback: string }> = {
  run: {
    limit_exceeded: 'Tool session cap reached.', invalid_input: 'Check the inputs.', forbidden: 'Not allowed.',
    upstream_unavailable: 'The tool could not start.', version_conflict: 'The tool changed.', not_found: 'Tool unavailable.',
    fallback: 'The run was refused.',
  },
  config: { invalid_input: 'That value was refused.', forbidden: 'Not allowed.', version_conflict: 'The tool changed.', fallback: 'Configuration could not be saved.' },
  secret: { fallback: 'The secret was not changed.' },
  load: { fallback: 'Could not load.' },
};

/** `redact` is a value the user typed (a secret): it never reaches the screen, even if a message echoes it. */
export function toolErrorOf(failure: unknown, context: ToolErrorContext, redact?: string): ToolErrorView {
  const code = failure instanceof CollabError ? failure.code : null;
  const raw = failure instanceof Error && failure.message ? failure.message : 'The request could not be completed.';
  const message = redact ? raw.split(redact).join('••••') : raw;
  const titles = TITLES[context];
  return { code, title: (code && titles[code]) || titles.fallback, message };
}
/** A local check, not a server refusal: the message alone. */
export const localError = (message: string): ToolErrorView => ({ code: null, title: '', message });
