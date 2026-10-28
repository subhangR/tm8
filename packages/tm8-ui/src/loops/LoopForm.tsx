import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import type { EntityId, EntitySummary, LaunchCredentialSource, ProjectId, SpaceId, ToolInput, ToolJsonValue, ToolView, WorkSessionWorkdirMode } from '@tm8/contract';
import { ComposerSelect, type ComposerSelectOption } from '../chat-home/ComposerSelect';
import { classifyFailure } from '../authoring/commands';
import { RefusalCard } from '../authoring/RefusalCard';
import { DisabledAction } from '../panels/honesty/DisabledWithReason';
import type { Seam } from '../data/seam';
import { ACCESS_MODE_CYCLE, AGENT_TOOLS, EFFORT_LABELS, LAUNCH_MODES, accessModeLabel, type LaunchAccessMode } from '../domain/launch';
import { MembershipPicker } from '../panels/bodies/MembershipBlock';
import { InputValue } from '../tools/InputValue';
import { parseValue } from '../tools/values';
import {
  fieldPathOf,
  type LoopAction,
  type LoopConcurrency,
  type LoopCreateDefinition,
  type LoopDefinition,
  type LoopDefinitionPatch,
  type LoopSessionMode,
  type LoopSpawnConfig,
  type LoopsClient,
  type LoopView,
} from './api';
import {
  DEFAULT_PRESET,
  PRESET_LABELS,
  WEEKDAYS,
  browserTimeZone,
  expressionOf,
  parseTime,
  presetOf,
  timeOf,
  timeZoneOptions,
  type SchedulePreset,
  type SchedulePresetKind,
} from './schedule-presets';
import { SchedulePreviewPanel, useSchedulePreview } from './SchedulePreview';
import { readEntityRef } from './use-entity-ref';
import './loops.css';

/*
 * THE LOOP FORM — create and edit, one form (design 01a182d4 §6).
 *
 * TWO THINGS IT NEVER DOES. It never computes schedule state: the preview,
 * the validity of an expression and the next run all come from the server
 * (`loops.schedule.preview`, and `nextRunAt` written by the doors). And it
 * never asks for a raw entity id or raw JSON: the runner, tool, subject,
 * project, memories and profile are pickers; tool inputs are the tool's own
 * typed inputs (the Run dialog's `InputValue`).
 *
 * WHY NOT `useLaunchComposerState`: that hook owns its state from mount and
 * seeds an automatic teammate (the roster's front row) — right for launching
 * now, wrong for an edit form that must open on a stored definition and must
 * not choose a runner for the human. The form keeps the same VOCABULARY
 * (`domain/launch.ts` access modes, session modes, efforts, agent tools and
 * models) and the same picker (`ComposerSelect`), with its own state.
 */

/** What the pickers read. `seam` itself satisfies it. */
export interface LoopFormSources {
  query: Seam['query'];
  entity?: Seam['entity'];
  projects?: Seam['projects'];
  commands?: { tools?: { get(toolId: string): Promise<ToolView> } };
}

/** The seam's reads, bound, so a host holding only `commands` can open the form. */
export function loopFormSourcesOf(seam: Pick<Seam, 'query' | 'entity' | 'projects' | 'commands'>): LoopFormSources {
  return {
    query: input => seam.query(input),
    entity: id => seam.entity(id),
    projects: spaceId => seam.projects(spaceId),
    commands: { get tools() { return seam.commands.tools; } },
  };
}

export interface LoopFormProps {
  mode: 'create' | 'edit';
  spaceId: SpaceId;
  client: LoopsClient;
  sources: LoopFormSources;
  /** Required in edit mode: the loop as last read (its version guards the update). */
  view?: LoopView;
  onSaved(view: LoopView): void;
  onClose(): void;
}

interface Draft {
  title: string;
  action: LoopAction;
  teamMemberId: EntityId | null;
  toolId: EntityId | null;
  toolInputs: Record<string, string>;
  subject: { id: EntityId; title: string } | null;
  prompt: string;
  preset: SchedulePreset;
  timezone: string;
  model: string;          // `${agentTool}::${model}` or '' for the teammate's default
  reasoningEffort: string;
  accessMode: string;
  sessionMode: string;
  projectId: string;
  workdirMode: string;
  baseRef: string;
  memories: { id: EntityId; title: string }[];
  credentialSource: string;
  interactionProfileId: string;
  concurrency: LoopConcurrency;
  maxRuntimeMinutes: string;
  retryAttempts: string;
  retryDelaySeconds: string;
  enabled: boolean;
}

const DEFAULT = '';
const ACTIONS: readonly { id: LoopAction; label: string }[] = [
  { id: 'spawn', label: 'Teammate' },
  { id: 'dispatch', label: 'Dispatcher decides' },
  { id: 'tool', label: 'Tool' },
];

function draftOf(view: LoopView | undefined): Draft {
  const d = view?.definition;
  const c: LoopSpawnConfig = d?.config ?? {};
  return {
    title: d?.title ?? '',
    action: d?.action ?? 'spawn',
    teamMemberId: d?.teamMemberId ?? null,
    toolId: d?.toolId ?? null,
    toolInputs: Object.fromEntries(Object.entries(d?.toolInputs ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])),
    subject: d?.subjectId ? { id: d.subjectId, title: '' } : null,
    prompt: d?.prompt ?? '',
    preset: d ? presetOf(d.schedule) : DEFAULT_PRESET,
    timezone: d?.timezone ?? browserTimeZone(),
    model: c.model ? `${c.agentTool ?? ''}::${c.model}` : DEFAULT,
    reasoningEffort: c.reasoningEffort ?? DEFAULT,
    accessMode: c.accessMode ?? DEFAULT,
    sessionMode: c.mode ?? DEFAULT,
    projectId: c.projectId ?? DEFAULT,
    workdirMode: c.workdir?.mode ?? DEFAULT,
    baseRef: c.workdir?.baseRef ?? '',
    memories: (c.memoryIds ?? []).map(id => ({ id, title: '' })),
    credentialSource: c.credentialSource ?? DEFAULT,
    interactionProfileId: c.interactionProfileId ?? DEFAULT,
    concurrency: d?.concurrency ?? 'skip',
    maxRuntimeMinutes: d?.maxRuntimeSeconds ? String(Math.round(d.maxRuntimeSeconds / 60)) : '',
    retryAttempts: String(d?.retry.attempts ?? 0),
    retryDelaySeconds: String(d?.retry.delaySeconds ?? 60),
    enabled: view?.state.enabled ?? true,
  };
}

/** Field errors keyed by the server's path (minus `definition.`). */
type FieldErrors = Record<string, string>;

function configOf(draft: Draft): LoopSpawnConfig {
  if (draft.action !== 'spawn') return {};
  const config: LoopSpawnConfig = {};
  if (draft.model) {
    const [agentTool, model] = draft.model.split('::');
    config.model = model || null;
    if (agentTool) config.agentTool = agentTool;
  }
  if (draft.reasoningEffort) config.reasoningEffort = draft.reasoningEffort as LoopSpawnConfig['reasoningEffort'];
  if (draft.accessMode) config.accessMode = draft.accessMode as LaunchAccessMode;
  if (draft.sessionMode) config.mode = draft.sessionMode as LoopSessionMode;
  if (draft.projectId) config.projectId = draft.projectId as ProjectId;
  if (draft.workdirMode) {
    config.workdir = { mode: draft.workdirMode as WorkSessionWorkdirMode };
    if (draft.workdirMode === 'worktree' && draft.baseRef.trim()) config.workdir.baseRef = draft.baseRef.trim();
  }
  if (draft.memories.length > 0) config.memoryIds = draft.memories.map(memory => memory.id);
  if (draft.credentialSource) config.credentialSource = draft.credentialSource as LaunchCredentialSource;
  if (draft.interactionProfileId) config.interactionProfileId = draft.interactionProfileId;
  return config;
}

/** Local checks: only what a human could not mean (empty name, no runner). The server decides the rest. */
function localProblems(draft: Draft, tool: ToolView | null): { errors: FieldErrors; inputs: Record<string, ToolJsonValue> } {
  const errors: FieldErrors = {};
  const inputs: Record<string, ToolJsonValue> = {};
  if (draft.title.trim() === '') errors.title = 'Give the loop a name.';
  if (expressionOf(draft.preset) === '') errors.schedule = 'Enter a cron expression.';
  if (draft.action === 'spawn' && !draft.teamMemberId) errors.teamMemberId = 'Pick the teammate who runs it.';
  if (draft.action === 'tool') {
    if (!draft.toolId) errors.toolId = 'Pick the tool to run.';
    else if (tool) {
      for (const input of tool.definition.inputs) {
        if (input.type === 'secret') continue;
        const text = draft.toolInputs[input.name] ?? '';
        if (text === '') {
          const covered = Object.prototype.hasOwnProperty.call(tool.config, input.name) || ('default' in input && input.default !== undefined);
          if (input.required && !covered) errors[`toolInputs.${input.name}`] = 'A value is required.';
          continue;
        }
        try {
          inputs[input.name] = parseValue(input, text);
        } catch (error) {
          errors[`toolInputs.${input.name}`] = error instanceof Error ? error.message.replace(`${input.name}: `, '') : 'Invalid value.';
        }
      }
    }
  }
  const integer = (key: string, text: string, min: number, max: number, label: string) => {
    if (text.trim() === '') return;
    const n = Number(text);
    if (!Number.isInteger(n) || n < min || n > max) errors[key] = `${label} must be a whole number from ${min} to ${max}.`;
  };
  integer('maxRuntimeSeconds', draft.maxRuntimeMinutes, 1, 1440, 'Max runtime (minutes)');
  integer('retry.attempts', draft.retryAttempts, 0, 5, 'Retries');
  integer('retry.delaySeconds', draft.retryDelaySeconds, 30, 3600, 'Retry delay');
  return { errors, inputs };
}

function definitionOf(draft: Draft, inputs: Record<string, ToolJsonValue>): LoopDefinition {
  return {
    title: draft.title.trim(),
    schedule: expressionOf(draft.preset),
    timezone: draft.timezone,
    action: draft.action,
    teamMemberId: draft.action === 'spawn' ? draft.teamMemberId : null,
    toolId: draft.action === 'tool' ? draft.toolId : null,
    toolInputs: draft.action === 'tool' ? inputs : {},
    subjectId: draft.subject?.id ?? null,
    prompt: draft.prompt,
    config: configOf(draft),
    concurrency: draft.concurrency,
    maxRuntimeSeconds: draft.maxRuntimeMinutes.trim() === '' ? null : Number(draft.maxRuntimeMinutes) * 60,
    retry: {
      attempts: draft.retryAttempts.trim() === '' ? 0 : Number(draft.retryAttempts),
      delaySeconds: draft.retryDelaySeconds.trim() === '' ? 60 : Number(draft.retryDelaySeconds),
    },
  };
}

/** Only what changed, so an edit never rewrites a field the human did not touch. */
function changedFields(before: LoopDefinition, after: LoopDefinition): LoopDefinitionPatch {
  const out: LoopDefinitionPatch = {};
  for (const key of Object.keys(after) as (keyof LoopDefinition)[]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) (out as Record<string, unknown>)[key] = after[key];
  }
  return out;
}

/** Which form section a server path belongs to, so a refused advanced field opens Advanced. */
const ADVANCED_PATHS = /^(config|concurrency|maxRuntimeSeconds|retry)/;

type Phase =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'refused'; cause: string; detail: string; aftermath: string; retryable: boolean };

function useEntityOptions(sources: LoopFormSources, spaceId: SpaceId, kind: string): { options: EntitySummary[]; loaded: boolean } {
  const [state, setState] = useState<{ options: EntitySummary[]; loaded: boolean }>({ options: [], loaded: false });
  useEffect(() => {
    let live = true;
    sources.query({ spaceId, kinds: [kind as never], limit: 200 }).then(
      result => { if (live) setState({ options: result.page.items, loaded: true }); },
      () => { if (live) setState({ options: [], loaded: true }); },
    );
    return () => { live = false; };
  }, [sources, spaceId, kind]);
  return state;
}

export function LoopForm({ mode, spaceId, client, sources, view, onSaved, onClose }: LoopFormProps) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(view));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [phase, setPhase] = useState<Phase>({ phase: 'idle' });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [tool, setTool] = useState<ToolView | null>(null);
  const [toolProblem, setToolProblem] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const firstField = useRef<HTMLInputElement | null>(null);
  const saving = phase.phase === 'saving';
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({ ...current, [key]: value }));

  useEffect(() => { firstField.current?.focus(); }, []);

  const teammates = useEntityOptions(sources, spaceId, 'team_member');
  const tools = useEntityOptions(sources, spaceId, 'tool');
  const profiles = useEntityOptions(sources, spaceId, 'interaction_profile');

  useEffect(() => {
    if (!sources.projects) return;
    let live = true;
    sources.projects(spaceId).then(
      rows => { if (live) setProjects(rows.map(row => ({ id: row.id, name: row.name }))); },
      () => undefined,
    );
    return () => { live = false; };
  }, [sources, spaceId]);

  // The picked tool's definition: its inputs are the form's inputs.
  useEffect(() => {
    setTool(null);
    setToolProblem(null);
    if (draft.action !== 'tool' || !draft.toolId) return;
    const port = sources.commands?.tools;
    if (!port) { setToolProblem('This view cannot read tool definitions.'); return; }
    let live = true;
    port.get(draft.toolId).then(
      loaded => { if (live) setTool(loaded); },
      (error: unknown) => { if (live) setToolProblem(error instanceof Error ? error.message : 'The tool could not be read.'); },
    );
    return () => { live = false; };
  }, [sources, draft.action, draft.toolId]);

  // Titles for ids an edit opened with (subject, memories): read, never shown raw.
  useEffect(() => {
    const entity = sources.entity;
    const unnamed = [...(draft.subject && !draft.subject.title ? [draft.subject.id] : []), ...draft.memories.filter(m => !m.title).map(m => m.id)];
    if (unnamed.length === 0 || !entity) return;
    let live = true;
    void Promise.all(unnamed.map(id => readEntityRef(sources as { entity: typeof entity }, id).then(ref => [id, ref.title] as const, () => [id, ''] as const))).then(pairs => {
      if (!live) return;
      const titles = new Map(pairs);
      setDraft(current => ({
        ...current,
        subject: current.subject && !current.subject.title ? { ...current.subject, title: titles.get(current.subject.id) || 'An entity you cannot see' } : current.subject,
        memories: current.memories.map(m => (m.title ? m : { ...m, title: titles.get(m.id) || 'A memory you cannot see' })),
      }));
    });
    return () => { live = false; };
    // Only on open: later picks carry their titles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const schedule = expressionOf(draft.preset);
  const preview = useSchedulePreview(client, spaceId, schedule, draft.timezone);
  const previewInvalid = preview.phase === 'ready' && !preview.preview.valid;

  const close = () => { if (!saving) onClose(); };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || saving) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saving, onClose]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (saving) return;
    const { errors: local, inputs } = localProblems(draft, tool);
    setErrors(local);
    if (Object.keys(local).length > 0) {
      if (Object.keys(local).some(key => ADVANCED_PATHS.test(key))) setAdvancedOpen(true);
      return;
    }
    if (previewInvalid) return;
    const definition = definitionOf(draft, inputs);
    setPhase({ phase: 'saving' });
    try {
      let saved: LoopView;
      if (mode === 'edit' && view) {
        saved = await client.update(view, changedFields(view.definition, definition));
      } else {
        const create: LoopCreateDefinition = definition;
        saved = await client.create(spaceId, create, draft.enabled);
      }
      setPhase({ phase: 'idle' });
      onSaved(saved);
    } catch (error) {
      const field = fieldPathOf(error);
      if (field && FIELD_KEYS.some(key => field.path === key || field.path.startsWith(`${key}.`))) {
        setErrors({ [field.path]: field.message });
        if (ADVANCED_PATHS.test(field.path)) setAdvancedOpen(true);
        setPhase({ phase: 'idle' });
        return;
      }
      const failure = classifyFailure(error, mode === 'edit' ? 'save' : 'create');
      setPhase({
        phase: 'refused',
        cause: failure.cause,
        detail: failure.detail,
        aftermath: failure.aftermath,
        retryable: failure.kind === 'refused' ? failure.retryable : false,
      });
    }
  };

  const errorFor = (key: string) => errors[key] ?? Object.entries(errors).find(([path]) => path.startsWith(`${key}.`))?.[1] ?? null;

  const teammateOptions: ComposerSelectOption[] = teammates.options.map(t => ({ id: t.id, label: t.title, actor: { id: t.id } }));
  const toolOptions: ComposerSelectOption[] = tools.options.map(t => ({ id: t.id, label: t.title }));
  const stop = (event: MouseEvent) => event.stopPropagation();
  const title = mode === 'edit' ? 'Edit loop' : 'New loop';

  return (
    <div className="au-dialog__backdrop" role="presentation" onMouseDown={close}>
      <form
        className="au-dialog loop-form"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="loop-form"
        onSubmit={event => void submit(event)}
        onMouseDown={stop}
        noValidate
      >
        <h2 className="au-dialog__title">{title}</h2>

        <Field label="Name" error={errorFor('title')}>
          <input
            ref={firstField}
            className="au-dialog__input"
            value={draft.title}
            maxLength={200}
            placeholder="Daily project sweep"
            aria-label="Name"
            onChange={event => set('title', event.target.value)}
          />
        </Field>

        <fieldset className="loop-form__section">
          <legend className="au-dialog__label">What should run?</legend>
          <div className="loop-form__segmented" role="radiogroup" aria-label="What should run?">
            {ACTIONS.map(option => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={draft.action === option.id}
                className={`loop-form__segment${draft.action === option.id ? ' loop-form__segment--on' : ''}`}
                data-testid={`loop-action-${option.id}`}
                onClick={() => set('action', option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {draft.action === 'spawn' ? (
            <Field label="Teammate" error={errorFor('teamMemberId')}>
              <ComposerSelect
                label="Teammate"
                options={teammateOptions}
                value={draft.teamMemberId ?? ''}
                onChange={id => set('teamMemberId', id)}
                emptyNote={teammates.loaded ? 'No teammates in this space.' : 'Loading teammates…'}
                note={draft.teamMemberId ? null : 'Pick who runs each firing.'}
                variant="quiet"
                tall
                testId="loop-teammate"
              />
            </Field>
          ) : null}
          {draft.action === 'dispatch' ? (
            <p className="loop-form__muted">Each firing goes to the Dispatcher, which picks the teammate.</p>
          ) : null}
          {draft.action === 'tool' ? (
            <>
              <Field label="Tool" error={errorFor('toolId') ?? toolProblem}>
                <ComposerSelect
                  label="Tool"
                  options={toolOptions}
                  value={draft.toolId ?? ''}
                  onChange={id => setDraft(current => ({ ...current, toolId: id, toolInputs: {} }))}
                  emptyNote={tools.loaded ? 'No tools in this space.' : 'Loading tools…'}
                  variant="quiet"
                  tall
                  testId="loop-tool"
                />
              </Field>
              {tool ? <ToolInputs tool={tool} values={draft.toolInputs} errorFor={errorFor} disabled={saving}
                onChange={(name, value) => setDraft(current => ({ ...current, toolInputs: { ...current.toolInputs, [name]: value } }))} /> : null}
            </>
          ) : null}
        </fieldset>

        <Field label="About" optional error={errorFor('subjectId')}>
          {draft.subject ? (
            <span className="loop-form__chip" data-testid="loop-subject">
              {draft.subject.title || '…'}
              <button type="button" aria-label="Clear subject" onClick={() => set('subject', null)}>×</button>
            </span>
          ) : (
            <MembershipPicker
              search={text => sources.query({ spaceId, ...(text.trim() ? { words: text.trim() } : {}), limit: 50 }).then(r => r.page.items)}
              onPick={(id, pickedTitle) => set('subject', { id, title: pickedTitle })}
              excludeIds={new Set(view ? [view.id] : [])}
              addLabel="Choose what it is about…"
            />
          )}
        </Field>

        <Field label="Instructions" optional error={errorFor('prompt')}>
          <textarea
            className="au-dialog__input"
            rows={3}
            value={draft.prompt}
            maxLength={20_000}
            aria-label="Instructions"
            placeholder="What each firing should do"
            onChange={event => set('prompt', event.target.value)}
          />
        </Field>

        <fieldset className="loop-form__section">
          <legend className="au-dialog__label">When</legend>
          <ScheduleFields preset={draft.preset} onChange={preset => set('preset', preset)} />
          <Field label="Timezone" error={errorFor('timezone')}>
            <select
              className="au-dialog__input"
              aria-label="Timezone"
              value={draft.timezone}
              onChange={event => set('timezone', event.target.value)}
            >
              {timeZoneOptions(draft.timezone).map(zone => <option key={zone} value={zone}>{zone}</option>)}
            </select>
          </Field>
          {errorFor('schedule') ? <p className="au-dialog__missing" role="alert">{errorFor('schedule')}</p> : null}
          <SchedulePreviewPanel state={preview} timezone={draft.timezone} />
        </fieldset>

        <details className="loop-form__advanced" open={advancedOpen} onToggle={event => setAdvancedOpen((event.target as HTMLDetailsElement).open)}>
          <summary>Advanced</summary>
          {draft.action === 'spawn' ? (
            <SpawnSettings draft={draft} set={set} projects={projects} profiles={profiles.options} sources={sources} spaceId={spaceId} errorFor={errorFor} />
          ) : null}
          <Field label="If the previous run is still going" error={errorFor('concurrency')}>
            <select className="au-dialog__input" aria-label="Concurrency" value={draft.concurrency}
              onChange={event => set('concurrency', event.target.value as LoopConcurrency)}>
              <option value="skip">Skip this firing</option>
              <option value="queue">Wait, then run</option>
            </select>
          </Field>
          <Field label="Max runtime (minutes)" optional error={errorFor('maxRuntimeSeconds')}>
            <input className="au-dialog__input" type="number" min={1} max={1440} aria-label="Max runtime (minutes)"
              value={draft.maxRuntimeMinutes} onChange={event => set('maxRuntimeMinutes', event.target.value)} />
          </Field>
          <div className="loop-form__row">
            <Field label="Retries" error={errorFor('retry.attempts')}>
              <input className="au-dialog__input" type="number" min={0} max={5} aria-label="Retries"
                value={draft.retryAttempts} onChange={event => set('retryAttempts', event.target.value)} />
            </Field>
            <Field label="Retry delay (seconds)" error={errorFor('retry.delaySeconds')}>
              <input className="au-dialog__input" type="number" min={30} max={3600} aria-label="Retry delay (seconds)"
                value={draft.retryDelaySeconds} onChange={event => set('retryDelaySeconds', event.target.value)} />
            </Field>
          </div>
        </details>

        {mode === 'create' ? (
          <label className="loop-create__toggle">
            <input type="checkbox" checked={draft.enabled} disabled={saving} onChange={event => set('enabled', event.target.checked)} />
            <span>Enable now</span>
          </label>
        ) : null}

        {phase.phase === 'refused' ? (
          <RefusalCard
            word={phase.cause}
            detail={phase.detail}
            aftermath={phase.aftermath}
            moves={[
              ...(phase.retryable ? [{ label: 'retry', onSelect: () => void submit() }] : []),
              { label: 'back to the form', onSelect: () => setPhase({ phase: 'idle' }) },
            ]}
          />
        ) : null}

        <div className="au-dialog__actions">
          <button type="button" onClick={close} disabled={saving}>Cancel</button>
          <button type="submit" className="au-dialog__primary" aria-busy={saving} disabled={saving || previewInvalid}>
            {saving ? 'Saving…' : mode === 'edit' ? 'Save loop' : 'Create loop'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Paths a refusal can be drawn against; anything else is a whole-form refusal. */
const FIELD_KEYS = ['title', 'schedule', 'timezone', 'action', 'teamMemberId', 'toolId', 'toolInputs', 'subjectId', 'prompt', 'config', 'concurrency', 'maxRuntimeSeconds', 'retry'];

function Field({ label, optional, error, children }: { label: string; optional?: boolean; error?: string | null; children: ReactNode }) {
  return (
    <div className="au-dialog__field">
      <span className="au-dialog__label">
        {label}{optional ? <em className="au-dialog__optional"> · optional</em> : null}
      </span>
      {children}
      {error ? <span className="au-dialog__missing" role="alert">{error}</span> : null}
    </div>
  );
}

function ToolInputs({ tool, values, errorFor, disabled, onChange }: {
  tool: ToolView;
  values: Record<string, string>;
  errorFor(key: string): string | null;
  disabled: boolean;
  onChange(name: string, value: string): void;
}) {
  const inputs = tool.definition.inputs;
  if (inputs.length === 0) return <p className="loop-form__muted">This tool takes no inputs.</p>;
  return (
    <div className="loop-form__inputs" data-testid="loop-tool-inputs">
      {inputs.map((input: ToolInput) => (
        <label key={input.name} className="tool-field">
          <span>{input.name}{input.required ? ' · required' : ''}</span>
          {input.description ? <small>{input.description}</small> : null}
          {input.type === 'secret' ? (
            <small>Uses the secret bound on the tool; a loop never stores one.</small>
          ) : (
            <InputValue input={input} value={values[input.name] ?? ''} onChange={value => onChange(input.name, value)} disabled={disabled} />
          )}
          {errorFor(`toolInputs.${input.name}`) ? (
            <span className="au-dialog__missing" role="alert">{errorFor(`toolInputs.${input.name}`)}</span>
          ) : null}
        </label>
      ))}
    </div>
  );
}

function ScheduleFields({ preset, onChange }: { preset: SchedulePreset; onChange(preset: SchedulePreset): void }) {
  const at = (
    <input
      className="au-dialog__input"
      type="time"
      aria-label="Time"
      value={timeOf(preset)}
      onChange={event => onChange({ ...preset, ...parseTime(event.target.value, preset) })}
    />
  );
  return (
    <div className="loop-form__schedule">
      <select
        className="au-dialog__input"
        aria-label="Repeat"
        data-testid="loop-preset"
        value={preset.kind}
        onChange={event => {
          const kind = event.target.value as SchedulePresetKind;
          // Switching to Custom starts from what the preset wrote, so nothing is lost.
          onChange({ ...preset, kind, cron: kind === 'custom' && preset.kind !== 'custom' ? expressionOf(preset) : preset.cron });
        }}
      >
        {PRESET_LABELS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      {preset.kind === 'hourly' ? (
        <label className="loop-form__inline">at minute
          <input className="au-dialog__input" type="number" min={0} max={59} aria-label="Minute"
            value={preset.minute} onChange={event => onChange({ ...preset, minute: clamp(event.target.value, 0, 59) })} />
        </label>
      ) : null}
      {preset.kind === 'daily' || preset.kind === 'weekdays' ? at : null}
      {preset.kind === 'weekly' ? (
        <>
          <select className="au-dialog__input" aria-label="Day" value={preset.weekday}
            onChange={event => onChange({ ...preset, weekday: Number(event.target.value) })}>
            {WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
          </select>
          {at}
        </>
      ) : null}
      {preset.kind === 'interval' ? (
        <>
          <input className="au-dialog__input" type="number" min={1} aria-label="Every"
            value={preset.every} onChange={event => onChange({ ...preset, every: clamp(event.target.value, 1, 10_000) })} />
          <select className="au-dialog__input" aria-label="Unit" value={preset.unit}
            onChange={event => onChange({ ...preset, unit: event.target.value as 'm' | 'h' })}>
            <option value="m">minutes</option>
            <option value="h">hours</option>
          </select>
        </>
      ) : null}
      {preset.kind === 'custom' ? (
        <input className="au-dialog__input loop-form__cron" aria-label="Cron expression" placeholder="17 3 * * 1-5 or every 2h"
          value={preset.cron} spellCheck={false} onChange={event => onChange({ ...preset, cron: event.target.value })} />
      ) : null}
    </div>
  );
}

function clamp(text: string, min: number, max: number): number {
  const n = Math.round(Number(text));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

const MODEL_OPTIONS: ComposerSelectOption[] = [
  { id: DEFAULT, label: "Teammate's default" },
  ...AGENT_TOOLS.flatMap(tool => tool.models.map(model => ({ id: `${tool.id}::${model.id}`, label: model.label, group: tool.label, ...(model.note ? { hint: model.note } : {}) }))),
];
const EFFORT_OPTIONS: ComposerSelectOption[] = [
  { id: DEFAULT, label: 'Default' },
  ...Object.entries(EFFORT_LABELS).map(([id, label]) => ({ id, label })),
];
const ACCESS_OPTIONS: ComposerSelectOption[] = ACCESS_MODE_CYCLE.map(mode => ({ id: mode ?? DEFAULT, label: mode ? accessModeLabel(mode) : "Teammate's default" }));
const SESSION_MODE_OPTIONS: ComposerSelectOption[] = [
  { id: DEFAULT, label: 'Worker (default)' },
  ...LAUNCH_MODES.filter(mode => mode.id !== 'dispatcher').map(mode => ({ id: mode.id, label: mode.label, hint: mode.description })),
];
const WORKDIR_OPTIONS: ComposerSelectOption[] = [
  { id: DEFAULT, label: 'Default' },
  { id: 'worktree', label: 'Worktree', hint: 'A fresh git worktree per firing' },
  { id: 'project', label: 'Project folder', hint: 'Work in the project checkout itself' },
  { id: 'scratch', label: 'Scratch', hint: 'An empty scratch directory' },
];
const CREDENTIAL_OPTIONS: ComposerSelectOption[] = [
  { id: DEFAULT, label: 'Auto' },
  { id: 'member', label: 'Member', hint: "The acting member's own credential" },
  { id: 'space', label: 'Space', hint: 'A credential the space holds' },
  { id: 'node', label: 'Node', hint: "The node's credential" },
];

function SpawnSettings({ draft, set, projects, profiles, sources, spaceId, errorFor }: {
  draft: Draft;
  set<K extends keyof Draft>(key: K, value: Draft[K]): void;
  projects: { id: string; name: string }[];
  profiles: EntitySummary[];
  sources: LoopFormSources;
  spaceId: SpaceId;
  errorFor(key: string): string | null;
}) {
  const projectOptions = useMemo<ComposerSelectOption[]>(
    () => [{ id: DEFAULT, label: 'No project' }, ...projects.map(p => ({ id: p.id, label: p.name }))],
    [projects],
  );
  const profileOptions = useMemo<ComposerSelectOption[]>(
    () => [{ id: DEFAULT, label: "Teammate's default" }, ...profiles.map(p => ({ id: p.id, label: p.title }))],
    [profiles],
  );
  const select = (label: string, key: keyof Draft, options: readonly ComposerSelectOption[], testId: string, path: string) => (
    <Field label={label} error={errorFor(path)}>
      <ComposerSelect label={label} options={options} value={draft[key] as string} onChange={id => set(key, id as never)}
        emptyNote="Nothing to choose." variant="quiet" testId={testId} />
    </Field>
  );
  return (
    <div className="loop-form__spawn">
      {select('Model', 'model', MODEL_OPTIONS, 'loop-model', 'config.model')}
      {select('Reasoning effort', 'reasoningEffort', EFFORT_OPTIONS, 'loop-effort', 'config.reasoningEffort')}
      {select('Access', 'accessMode', ACCESS_OPTIONS, 'loop-access', 'config.accessMode')}
      {select('Mode', 'sessionMode', SESSION_MODE_OPTIONS, 'loop-mode', 'config.mode')}
      {select('Project', 'projectId', projectOptions, 'loop-project', 'config.projectId')}
      {select('Working copy', 'workdirMode', WORKDIR_OPTIONS, 'loop-workdir', 'config.workdir')}
      {draft.workdirMode === 'worktree' ? (
        <Field label="Base ref" optional error={errorFor('config.workdir.baseRef')}>
          <input className="au-dialog__input" aria-label="Base ref" placeholder="origin/main" value={draft.baseRef}
            onChange={event => set('baseRef', event.target.value)} />
        </Field>
      ) : null}
      <Field label="Memories" optional error={errorFor('config.memoryIds')}>
        <div className="loop-form__chips">
          {draft.memories.map(memory => (
            <span key={memory.id} className="loop-form__chip">
              {memory.title || '…'}
              <button type="button" aria-label={`Remove ${memory.title || 'memory'}`}
                onClick={() => set('memories', draft.memories.filter(m => m.id !== memory.id))}>×</button>
            </span>
          ))}
          {draft.memories.length < 32 ? (
            <MembershipPicker
              search={text => sources.query({ spaceId, kinds: ['memory' as never], ...(text.trim() ? { words: text.trim() } : {}), limit: 50 }).then(r => r.page.items)}
              onPick={(id, title) => set('memories', [...draft.memories, { id, title }])}
              excludeIds={new Set(draft.memories.map(m => m.id))}
              addLabel="+ memory"
            />
          ) : null}
        </div>
      </Field>
      {select('Credential source', 'credentialSource', CREDENTIAL_OPTIONS, 'loop-credential', 'config.credentialSource')}
      {select('Interaction profile', 'interactionProfileId', profileOptions, 'loop-profile', 'config.interactionProfileId')}
    </div>
  );
}

/**
 * The form as a mounted dialog: the parent decides when it is open by
 * rendering it, and `onClose` is how it asks to be unmounted.
 */
export function LoopFormDialog(props: LoopFormProps) {
  return <LoopForm {...props} />;
}

/** The "New loop" trigger: a button that opens the create form. Used by the New tab chooser, the list header and the palette host. */
export function LoopCreateButton({ spaceId, client, sources, label = 'New loop', onCreated }: {
  spaceId: SpaceId;
  client: LoopsClient | null;
  sources: LoopFormSources | null;
  label?: string;
  onCreated?(view: LoopView): void;
}) {
  const [open, setOpen] = useState(false);
  if (!client || !sources) {
    return (
      <DisabledAction reason={{ cause: 'Creating is not wired here', remedy: 'this surface has no loops client' }} label={label}>
        {label}
      </DisabledAction>
    );
  }
  return (
    <>
      <button type="button" className="lp__new" data-testid="loop-new" onClick={() => setOpen(true)}>{label}</button>
      {open ? (
        <LoopFormDialog
          mode="create"
          spaceId={spaceId}
          client={client}
          sources={sources}
          onClose={() => setOpen(false)}
          onSaved={view => { setOpen(false); onCreated?.(view); }}
        />
      ) : null}
    </>
  );
}
