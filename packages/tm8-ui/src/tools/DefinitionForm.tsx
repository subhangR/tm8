import { useId, type ReactNode } from 'react';
import { TOOL_DEFAULT_TIMEOUT_SECONDS, ToolDefinitionSchema, type ToolDefinition } from '@tm8/contract';
import { SourceEditor } from './SourceEditor';
import { draftInput, inputFromDraft, InputsEditor, type InputDraft } from './InputsEditor';
import { issuesOf, placeIssues, type DefinitionProblem, type FieldErrors } from './errors';

/** What the definition form edits: the definition, with the timeout and input rows kept as typed until submit. */
export interface DefinitionDraft {
  name: string;
  description: string;
  runtime: ToolDefinition['runtime'];
  source: string;
  inputs: InputDraft[];
  help: string;
  tm8Access: ToolDefinition['tm8Access'];
  timeout: string;
}

/** The source a new tool starts with: how declared inputs arrive, in each runtime. */
export const SOURCE_SKELETONS: Readonly<Record<ToolDefinition['runtime'], string>> = {
  bash: '#!/usr/bin/env bash\nset -euo pipefail\n\n# Each declared input arrives as an environment variable: input `repo` is "$REPO".\necho "Hello from tm8"\n',
  python: '#!/usr/bin/env python3\nimport os\n\n# Each declared input arrives as an environment variable: input `repo` is os.environ["REPO"].\nprint("Hello from tm8")\n',
};

export function newDefinitionDraft(): DefinitionDraft {
  return { name: '', description: '', runtime: 'bash', source: SOURCE_SKELETONS.bash, inputs: [], help: '', tm8Access: 'none', timeout: String(TOOL_DEFAULT_TIMEOUT_SECONDS) };
}

export function draftOfDefinition(definition: ToolDefinition): DefinitionDraft {
  return {
    name: definition.name, description: definition.description, runtime: definition.runtime, source: definition.source,
    inputs: definition.inputs.map(draftInput), help: definition.help, tm8Access: definition.tm8Access, timeout: String(definition.timeoutSeconds),
  };
}

const NAME_RULE = 'Use 2–63 characters: lowercase letters, digits and hyphens, starting with a letter.';
const TIMEOUT_RULE = 'Enter a whole number of seconds, at least 1.';
const INPUT_RULES: Readonly<Record<string, string>> = {
  name: 'Use lowercase letters, digits and underscores, starting with a letter (at most 64).',
  flag: 'Use lowercase letters, digits and hyphens, starting with a letter.',
  short: 'Use one letter.',
  env: 'Use letters, digits and underscores, not starting with a digit.',
};

type DraftIssue = { path: readonly (string | number)[]; message: string; code?: string; validation?: unknown };

/** Zod's bare "Invalid" for a pattern, or "Expected number, received nan", says nothing; say the rule. */
function ruleFor(issue: DraftIssue): DraftIssue {
  const [head, , field] = issue.path;
  if (head === 'timeoutSeconds') return { ...issue, message: TIMEOUT_RULE };
  if (issue.code !== 'invalid_string' || issue.validation !== 'regex') return issue;
  const rule = issue.path.length === 1 && head === 'name' ? NAME_RULE
    : head === 'inputs' && issue.path.length === 3 && typeof field === 'string' ? INPUT_RULES[field] : undefined;
  return rule ? { ...issue, message: rule } : issue;
}

/**
 * The draft as a definition the contract accepts, or its problems keyed by
 * field. Runs the same schema the server validates with, so a draft that
 * passes here is refused only for what the server alone knows (a duplicate
 * name, the caller's rights).
 */
export function definitionOfDraft(draft: DefinitionDraft): { definition: ToolDefinition } | { problem: DefinitionProblem } {
  const fields: Record<string, string> = {};
  const inputs = draft.inputs.map((row, index) => {
    try {
      return inputFromDraft(row);
    } catch (failure) {
      const issues = issuesOf((failure as { issues?: unknown }).issues).map(issue => ruleFor({ ...issue, path: ['inputs', index, ...issue.path] }));
      // The one plain error `inputFromDraft` throws is an unparseable default.
      if (!issues.length) fields[`inputs.${index}.default`] ??= failure instanceof Error ? failure.message : String(failure);
      for (const [key, message] of Object.entries(placeIssues(issues).fields)) fields[key] ??= message;
      return null;
    }
  });
  if (Object.keys(fields).length) return { problem: { message: null, fields } };
  const parsed = ToolDefinitionSchema.safeParse({
    name: draft.name, description: draft.description, runtime: draft.runtime, source: draft.source, inputs,
    help: draft.help, tm8Access: draft.tm8Access, timeoutSeconds: draft.timeout.trim() === '' ? Number.NaN : Number(draft.timeout),
  });
  if (parsed.success) return { definition: parsed.data };
  const placed = placeIssues(parsed.error.issues.map(ruleFor));
  return { problem: { message: placed.unplaced.length ? placed.unplaced.join(' · ') : null, fields: placed.fields } };
}

/**
 * The definition's fields, shared by the create form and the page's editor:
 * name, description, runtime, source, inputs, help, tm8 API access and
 * timeout. The host owns the `<form>`, its submit and its actions; `errors`
 * places a message under each field it names.
 */
export function DefinitionForm({ draft, onChange, disabled = false, errors = {} }: {
  draft: DefinitionDraft;
  onChange(next: DefinitionDraft): void;
  disabled?: boolean;
  errors?: FieldErrors;
}) {
  const id = useId();
  const set = <K extends keyof DefinitionDraft>(key: K, value: DefinitionDraft[K]) => onChange({ ...draft, [key]: value });
  const control = (key: string) => ({
    id: `${id}-${key}`,
    'aria-invalid': errors[key] ? true : undefined,
    'aria-describedby': errors[key] ? `${id}-${key}-error` : undefined,
  });
  const field = (key: string, label: string, input: ReactNode) => <div className="tool-field">
    <label htmlFor={`${id}-${key}`}>{label}</label>{input}<FieldError id={`${id}-${key}-error`} message={errors[key]} />
  </div>;
  return <>
    {field('name', 'Name', <input {...control('name')} value={draft.name} onChange={event => set('name', event.target.value)} required pattern="[a-z][a-z0-9-]{1,62}" title={NAME_RULE} autoComplete="off" spellCheck={false} />)}
    {field('description', 'Description', <textarea {...control('description')} value={draft.description} onChange={event => set('description', event.target.value)} />)}
    {field('runtime', 'Runtime', <select {...control('runtime')} value={draft.runtime} onChange={event => set('runtime', event.target.value as DefinitionDraft['runtime'])}><option value="bash">Bash</option><option value="python">Python</option></select>)}
    <h3>Source</h3><SourceEditor value={draft.source} runtime={draft.runtime} readOnly={disabled} onChange={value => set('source', value)} />
    <FieldError id={`${id}-source-error`} message={errors.source} />
    <InputsEditor rows={draft.inputs} onChange={inputs => set('inputs', inputs)} errors={errors} />
    {field('help', 'Help (Markdown)', <textarea {...control('help')} rows={5} value={draft.help} onChange={event => set('help', event.target.value)} />)}
    {field('tm8Access', 'tm8 API access', <select {...control('tm8Access')} value={draft.tm8Access} onChange={event => set('tm8Access', event.target.value as DefinitionDraft['tm8Access'])}><option value="none">None</option><option value="read">Read</option><option value="write">Write</option></select>)}
    {field('timeoutSeconds', 'Timeout (seconds)', <input {...control('timeoutSeconds')} type="number" min={1} step={1} value={draft.timeout} onChange={event => set('timeout', event.target.value)} required />)}
  </>;
}

export function FieldError({ id, message }: { id?: string; message: string | undefined }) {
  return message ? <span id={id} className="tool-field-error" role="alert">{message}</span> : null;
}
