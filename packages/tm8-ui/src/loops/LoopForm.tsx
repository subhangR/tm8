import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  LOOP_MAX_RUNTIME_MAX_SECONDS,
  LOOP_MAX_RUNTIME_MIN_SECONDS,
  LOOP_MEMORY_IDS_MAX,
  LOOP_PROMPT_MAX,
  LOOP_RETRY_ATTEMPTS_MAX,
  LOOP_RETRY_DELAY_DEFAULT_SECONDS,
  LOOP_RETRY_DELAY_MAX_SECONDS,
  LOOP_RETRY_DELAY_MIN_SECONDS,
  LOOP_TITLE_MAX,
  type EntityId,
  type EntitySummary,
  type LaunchCredentialSource,
  type ProjectId,
  type SpaceId,
  type ToolInput,
  type ToolJsonValue,
  type ToolView,
  type WorkSessionWorkdirMode,
} from '@tm8/contract';
import { ComposerSelect, type ComposerSelectOption } from '../chat-home/ComposerSelect';
import { classifyFailure, nextMutationId } from '../authoring/commands';
import { RefusalCard } from '../authoring/RefusalCard';
import type { FileUploadTask } from '../files/upload';
import { DisabledAction } from '../panels/honesty/DisabledWithReason';
import {
  ACCESS_MODE_CYCLE,
  AGENT_TOOLS,
  EFFORT_LABELS,
  LAUNCH_MODES,
  PROFILE_STATUS_REASON,
  SCRATCH_OPTION,
  UNTRUSTED_REASON,
  WORKDIR_MODE_OPTIONS,
  accessModeLabel,
  currentNodeKey,
  type LaunchAccessMode,
} from '../domain/launch';
import { catalogModelsFor, modelCatalogVersion, subscribeModelCatalog } from '../domain/model-catalog';
import { useMobileSurface } from '../mobile/surface';
import { MembershipPicker } from '../panels/bodies/MembershipBlock';
import { ProseField, type TriggerOption } from '../rich-input';
import { InputValue } from '../tools/InputValue';
import { parseValue } from '../tools/values';
import {
  fieldPathOf,
  isVersionConflict,
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
  presetProblem,
  timeOf,
  timeZoneOptions,
  wholeNumberOf,
  type SchedulePreset,
  type SchedulePresetKind,
} from './schedule-presets';
import { SchedulePreviewPanel, useSchedulePreview } from './SchedulePreview';
import type { LoopFormSources } from './sources';
import { entityRefLabel, useEntityRef } from './use-entity-ref';
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
 * (`domain/launch.ts` access modes, session modes, efforts, working copies,
 * the editable model catalog) and the same picker (`ComposerSelect`), with
 * its own state.
 *
 * A LOOP'S VERSION MOVES EACH TIME IT FIRES (the run bookkeeping is part of
 * the row), so an edit refused for a stale version is usually not a
 * conflict at all. The form re-reads the loop and resends the same patch
 * when nothing it changes has moved; only a real overlap reaches the human,
 * as a "re-read and retry" card.
 */

interface LoopFormCommon {
  spaceId: SpaceId;
  client: LoopsClient;
  sources: LoopFormSources;
  onSaved(view: LoopView): void;
  onClose(): void;
  /** In place (a workspace draft tab), not a modal: no backdrop, no dialog role, no window-level Escape. */
  inline?: boolean;
  /** A draft tab's stored values (create only), and where its changes go; the host debounces. */
  initialValues?: Record<string, unknown> | null;
  onDraftChange?(values: Record<string, unknown>): void;
  /** A save started (true) or ended (false), for a host that blocks its own submit. */
  onBusy?(busy: boolean): void;
  /** Skills `/` can reference in the instructions, and an uploader for the loop being edited (R1/R4). */
  skillOptions?: readonly TriggerOption[];
  attach?: (file: File) => FileUploadTask;
  onAttached?: () => void;
}

/** Edit carries the loop as last read (its version guards the update), so a mis-wired edit can never create. */
export type LoopFormProps = LoopFormCommon & ({ mode: 'create'; view?: undefined } | { mode: 'edit'; view: LoopView });

interface Draft {
  title: string;
  action: LoopAction;
  teamMemberId: EntityId | null;
  toolId: EntityId | null;
  toolInputs: Record<string, string>;
  /** `title` is the picked one; a stored id's title is read when drawn (`RefChip`). */
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

/** A stored input as the text its field edits: a JSON input shows JSON, every other type its value (tools/values `initialValues`). */
function inputText(input: ToolInput | undefined, value: ToolJsonValue): string {
  if (input?.type === 'json') return JSON.stringify(value);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function inputTextsOf(stored: Record<string, ToolJsonValue>, tool: ToolView | null): Record<string, string> {
  const inputs = new Map((tool?.definition.inputs ?? []).map(input => [input.name, input] as const));
  return Object.fromEntries(Object.entries(stored).map(([name, value]) => [name, inputText(inputs.get(name), value)]));
}

/** The form for a stored loop (or a blank one). `tool`, once read, types the stored inputs. */
function draftOf(view: LoopView | undefined, tool: ToolView | null = null): Draft {
  const d = view?.definition;
  const c: LoopSpawnConfig = d?.config ?? {};
  return {
    title: d?.title ?? '',
    action: d?.action ?? 'spawn',
    teamMemberId: d?.teamMemberId ?? null,
    toolId: d?.toolId ?? null,
    toolInputs: inputTextsOf(d?.toolInputs ?? {}, tool && tool.id === d?.toolId ? tool : null),
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
    retryDelaySeconds: String(d?.retry.delaySeconds ?? LOOP_RETRY_DELAY_DEFAULT_SECONDS),
    enabled: view?.state.enabled ?? true,
  };
}

/* --- a draft tab's values ---------------------------------------------- */

const DRAFT_VALUES_VERSION = 1;
const TEXT_KEYS = [
  'title', 'prompt', 'timezone', 'model', 'reasoningEffort', 'accessMode', 'sessionMode', 'projectId', 'workdirMode',
  'baseRef', 'credentialSource', 'interactionProfileId', 'maxRuntimeMinutes', 'retryAttempts', 'retryDelaySeconds',
] as const;
const isText = (value: unknown): value is string => typeof value === 'string';
const isRef = (value: unknown): value is { id: EntityId; title: string } =>
  typeof value === 'object' && value !== null && isText((value as { id?: unknown }).id) && isText((value as { title?: unknown }).title);

function restorePreset(value: unknown): SchedulePreset | null {
  if (typeof value !== 'object' || value === null) return null;
  const stored = value as Record<string, unknown>;
  const kind = PRESET_LABELS.find(option => option.id === stored.kind)?.id;
  if (!kind) return null;
  // JSON writes a NaN (an empty number field) as null.
  const num = (key: keyof SchedulePreset) => typeof stored[key] === 'number' ? stored[key] as number : stored[key] === null ? NaN : DEFAULT_PRESET[key] as number;
  return {
    kind, minute: num('minute'), hour: num('hour'), weekday: num('weekday'), every: num('every'),
    unit: stored.unit === 'h' ? 'h' : 'm', cron: isText(stored.cron) ? stored.cron : '',
  };
}

/** A draft tab's stored values back into a form: a key of the wrong shape keeps its default rather than breaking the form. */
function restoreDraft(values: Record<string, unknown> | null | undefined): Draft {
  const draft = draftOf(undefined);
  if (!values || values.v !== DRAFT_VALUES_VERSION) return draft;
  for (const key of TEXT_KEYS) {
    const value = values[key];
    if (isText(value)) draft[key] = value;
  }
  if (ACTIONS.some(option => option.id === values.action)) draft.action = values.action as LoopAction;
  if (values.concurrency === 'skip' || values.concurrency === 'queue') draft.concurrency = values.concurrency;
  if (typeof values.enabled === 'boolean') draft.enabled = values.enabled;
  if (values.teamMemberId === null || isText(values.teamMemberId)) draft.teamMemberId = values.teamMemberId;
  if (values.toolId === null || isText(values.toolId)) draft.toolId = values.toolId;
  if (values.subject === null || isRef(values.subject)) draft.subject = values.subject;
  if (Array.isArray(values.memories)) draft.memories = values.memories.filter(isRef);
  const inputs = values.toolInputs;
  if (typeof inputs === 'object' && inputs !== null && Object.values(inputs).every(isText)) draft.toolInputs = inputs as Record<string, string>;
  draft.preset = restorePreset(values.preset) ?? draft.preset;
  return draft;
}

/* --- what a save sends ---------------------------------------------------- */

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

/**
 * Local checks: only what a human could not mean (empty name, no runner, an
 * input its tool refuses). The server decides the rest. `toolGate` is why the
 * picked tool cannot be checked yet, when the save needs it checked.
 */
function localProblems(draft: Draft, tool: ToolView | null, toolGate: string | null = null): { errors: FieldErrors; inputs: Record<string, ToolJsonValue> } {
  const errors: FieldErrors = {};
  const inputs: Record<string, ToolJsonValue> = {};
  if (draft.title.trim() === '') errors.title = 'Give the loop a name.';
  if (draft.prompt.length > LOOP_PROMPT_MAX) errors.prompt = `Keep the instructions under ${LOOP_PROMPT_MAX.toLocaleString()} characters.`;
  const scheduleProblem = presetProblem(draft.preset);
  if (scheduleProblem) errors.schedule = scheduleProblem;
  if (draft.action === 'spawn' && !draft.teamMemberId) errors.teamMemberId = 'Pick the teammate who runs it.';
  if (draft.action === 'tool') {
    if (!draft.toolId) errors.toolId = 'Pick the tool to run.';
    else if (toolGate) errors.toolId = toolGate;
    else if (tool) {
      if (personaRequired(tool) && !draft.teamMemberId) errors.teamMemberId = 'This tool works in tm8, so pick the teammate it runs as.';
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
    if (!/^\d+$/.test(text.trim()) || n < min || n > max) errors[key] = `${label} must be a whole number from ${min} to ${max}.`;
  };
  integer('maxRuntimeSeconds', draft.maxRuntimeMinutes, LOOP_MAX_RUNTIME_MIN_SECONDS / 60, LOOP_MAX_RUNTIME_MAX_SECONDS / 60, 'Max runtime (minutes)');
  integer('retry.attempts', draft.retryAttempts, 0, LOOP_RETRY_ATTEMPTS_MAX, 'Retries');
  integer('retry.delaySeconds', draft.retryDelaySeconds, LOOP_RETRY_DELAY_MIN_SECONDS, LOOP_RETRY_DELAY_MAX_SECONDS, 'Retry delay');
  return { errors, inputs };
}

function definitionOf(draft: Draft, inputs: Record<string, ToolJsonValue>): LoopDefinition {
  return {
    title: draft.title.trim(),
    schedule: expressionOf(draft.preset),
    timezone: draft.timezone,
    action: draft.action,
    // For a tool, the persona it runs as (§2.1); the Dispatcher picks its own.
    teamMemberId: draft.action === 'dispatch' ? null : draft.teamMemberId,
    toolId: draft.action === 'tool' ? draft.toolId : null,
    toolInputs: draft.action === 'tool' ? inputs : {},
    subjectId: draft.subject?.id ?? null,
    prompt: draft.prompt,
    config: configOf(draft),
    concurrency: draft.concurrency,
    maxRuntimeSeconds: draft.maxRuntimeMinutes.trim() === '' ? null : Number(draft.maxRuntimeMinutes) * 60,
    retry: {
      attempts: draft.retryAttempts.trim() === '' ? 0 : Number(draft.retryAttempts),
      delaySeconds: draft.retryDelaySeconds.trim() === '' ? LOOP_RETRY_DELAY_DEFAULT_SECONDS : Number(draft.retryDelaySeconds),
    },
  };
}

/** A tool that reaches tm8 runs as a persona; the server refuses one without (§2.1). */
function personaRequired(tool: ToolView): boolean {
  return tool.definition.tm8Access === 'read' || tool.definition.tm8Access === 'write';
}

/**
 * The edit's patch: only the fields the human changed, so an edit never
 * rewrites a field they did not touch. "Changed" is judged against what the
 * form would send for the loop untouched, not against the stored definition:
 * the form shows some fields lossily (max runtime in whole minutes, a schedule
 * re-spelled from its preset, tool inputs only once the tool is read), and an
 * untouched one must keep its stored value exactly. `config` is overlaid key
 * by key on the stored object, so keys the form does not show survive.
 */
function patchOf(stored: LoopDefinition, untouched: LoopDefinition, after: LoopDefinition): LoopDefinitionPatch {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof LoopDefinition)[]) {
    if (key !== 'config' && JSON.stringify(untouched[key]) !== JSON.stringify(after[key])) out[key] = after[key];
  }
  const config: Record<string, unknown> = { ...stored.config };
  const before = untouched.config as Record<string, unknown>, next = after.config as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
    if (JSON.stringify(before[key]) === JSON.stringify(next[key])) continue;
    if (next[key] === undefined) delete config[key]; else config[key] = next[key];
  }
  if (JSON.stringify(config) !== JSON.stringify(stored.config)) out.config = config;
  // A different tool (or action) must not inherit the old tool's stored inputs.
  if (('toolId' in out || 'action' in out) && JSON.stringify(after.toolInputs) !== JSON.stringify(stored.toolInputs)) out.toolInputs = after.toolInputs;
  return out as LoopDefinitionPatch;
}

/** The patch's keys whose stored value moved between two reads: a real overlap with someone else's edit. */
function movedKeys(read: LoopDefinition, fresh: LoopDefinition, patch: LoopDefinitionPatch): (keyof LoopDefinition)[] {
  return (Object.keys(patch) as (keyof LoopDefinition)[]).filter(key => JSON.stringify(read[key]) !== JSON.stringify(fresh[key]));
}

/** Rebase the human's draft on a fresh read: their edits stay, everything they did not touch takes the fresh value. */
function rebased(read: Draft, mine: Draft, fresh: Draft): Draft {
  const out = { ...fresh } as Record<keyof Draft, unknown>;
  for (const key of Object.keys(mine) as (keyof Draft)[]) {
    if (JSON.stringify(mine[key]) !== JSON.stringify(read[key])) out[key] = mine[key];
  }
  return out as unknown as Draft;
}

const FIELD_WORDS: Readonly<Record<keyof LoopDefinition, string>> = {
  title: 'the name', schedule: 'the schedule', timezone: 'the timezone', action: 'what runs', teamMemberId: 'the teammate',
  toolId: 'the tool', toolInputs: 'the tool inputs', subjectId: 'what it is about', prompt: 'the instructions',
  config: 'the advanced settings', concurrency: 'the concurrency', maxRuntimeSeconds: 'the max runtime', retry: 'the retries',
};

function listWords(words: readonly string[]): string {
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** Which form section a server path belongs to, so a refused advanced field opens Advanced. */
const ADVANCED_PATHS = /^(config|concurrency|maxRuntimeSeconds|retry)/;

/** How many times one save re-reads a loop that only moved under it (it fired) before asking the human. */
const CONFLICT_RETRIES = 2;

type Phase =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'refused'; cause: string; detail: string; aftermath: string; retryable: boolean }
  /** Someone changed what this edit changes: re-read (keeping the human's edits) and save again. */
  | { phase: 'conflict'; fresh: LoopView; moved: (keyof LoopDefinition)[] };

type Options = { options: EntitySummary[]; loaded: boolean; problem: string | null };

/** A picker's rows, read once it is needed (`enabled`); a failed read says so rather than looking empty. */
function useEntityOptions(sources: LoopFormSources, spaceId: SpaceId, kind: string, enabled = true): Options {
  const [state, setState] = useState<Options>({ options: [], loaded: false, problem: null });
  const wanted = enabled || state.loaded;
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    sources.query({ spaceId, kinds: [kind as never], limit: 200 }).then(
      result => { if (live) setState({ options: result.page.items, loaded: true, problem: null }); },
      (error: unknown) => {
        if (live) setState({ options: [], loaded: true, problem: error instanceof Error ? error.message : 'The list could not be read.' });
      },
    );
    return () => { live = false; };
  }, [sources, spaceId, kind, wanted]);
  return state;
}

function emptyNoteOf(state: Options, empty: string, loading: string): string {
  if (state.problem) return `Could not read the list: ${state.problem}`;
  return state.loaded ? empty : loading;
}

export function LoopForm(props: LoopFormProps) {
  const { mode, spaceId, client, sources, onSaved, onClose, inline = false, initialValues, onDraftChange, onBusy, skillOptions, attach, onAttached } = props;
  // The loop as last read: the version an edit is guarded by, and the base its patch is judged against.
  const [base, setBase] = useState<LoopView | undefined>(props.view);
  const [draft, setDraft] = useState<Draft>(() => (props.view ? draftOf(props.view) : restoreDraft(initialValues)));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [phase, setPhase] = useState<Phase>({ phase: 'idle' });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [tool, setTool] = useState<ToolView | null>(null);
  const [toolProblem, setToolProblem] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectOptions>({ rows: [], loaded: false, problem: null });
  const firstField = useRef<HTMLInputElement | null>(null);
  // The stored inputs, typed once their tool is read (edit only).
  const seedInputs = useRef(props.view?.definition.toolId ? { toolId: props.view.definition.toolId, inputs: props.view.definition.toolInputs } : null);
  // One idempotency key per intent: a retry of the same request reuses it, so a lost response never creates twice.
  const intent = useRef<{ key: string; id: string } | null>(null);
  const { sheetHost } = useMobileSurface();
  const saving = phase.phase === 'saving';
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({ ...current, [key]: value }));

  useEffect(() => { firstField.current?.focus(); }, []);

  // A draft tab keeps what was typed (the host debounces). Only a change is reported: the
  // opening draft is what the host handed in, and a host re-render is not an edit.
  const hostCallbacks = useRef({ onDraftChange, onBusy });
  hostCallbacks.current = { onDraftChange, onBusy };
  const opened = useRef(draft);
  useEffect(() => {
    if (draft !== opened.current) hostCallbacks.current.onDraftChange?.({ v: DRAFT_VALUES_VERSION, ...draft });
  }, [draft]);

  const spawnAdvanced = advancedOpen && draft.action === 'spawn';
  const teammates = useEntityOptions(sources, spaceId, 'team_member', draft.action !== 'dispatch');
  const tools = useEntityOptions(sources, spaceId, 'tool', draft.action === 'tool');
  const profiles = useEntityOptions(sources, spaceId, 'interaction_profile', spawnAdvanced);

  const projectsWanted = spawnAdvanced || projects.loaded;
  useEffect(() => {
    if (!sources.projects || !projectsWanted) return;
    let live = true;
    sources.projects(spaceId).then(
      rows => {
        if (live) setProjects({ rows: rows.map(row => ({ id: row.id, name: row.name, trusted: row.trust === 'trusted' })), loaded: true, problem: null });
      },
      // A failed read says so (the select's note), rather than looking like a space with no projects.
      (error: unknown) => {
        if (live) setProjects({ rows: [], loaded: true, problem: error instanceof Error ? error.message : 'The projects could not be read.' });
      },
    );
    return () => { live = false; };
  }, [sources, spaceId, projectsWanted]);

  // The picked tool's definition: its inputs are the form's inputs.
  useEffect(() => {
    setTool(null);
    setToolProblem(null);
    if (draft.action !== 'tool' || !draft.toolId) return;
    const port = sources.commands?.tools;
    if (!port) { setToolProblem('This view cannot read tool definitions.'); return; }
    let live = true;
    port.get(draft.toolId).then(
      loaded => {
        if (!live) return;
        setTool(loaded);
        const seed = seedInputs.current;
        if (seed && seed.toolId === loaded.id) {
          seedInputs.current = null;
          setDraft(current => (current.toolId === loaded.id ? { ...current, toolInputs: inputTextsOf(seed.inputs, loaded) } : current));
        }
      },
      (error: unknown) => { if (live) setToolProblem(error instanceof Error ? error.message : 'The tool could not be read.'); },
    );
    return () => { live = false; };
  }, [sources, draft.action, draft.toolId]);

  /* What an edit is judged against: the stored loop as this form would send it. */
  const untouched = useMemo(() => (base ? draftOf(base, tool) : null), [base, tool]);
  // A save that sets the tool (create, or a new tool or action) needs it read; an edit that leaves it alone does not.
  const toolMatters = draft.action === 'tool' && draft.toolId !== null
    && (!untouched || untouched.action !== 'tool' || untouched.toolId !== draft.toolId);
  const toolGate = toolMatters && !tool ? (toolProblem ?? 'The tool is still being read; its inputs appear in a moment.') : null;

  const schedule = expressionOf(draft.preset);
  const scheduleTouched = !untouched || schedule !== expressionOf(untouched.preset) || draft.timezone !== untouched.timezone;
  // An edit opens on the preview `loops.get` already answered for the stored schedule.
  const opening = props.view;
  const known = useMemo(() => (opening && (opening.schedule.next.length > 0 || !opening.schedule.valid)
    ? { schedule: expressionOf(presetOf(opening.definition.schedule)), timezone: opening.definition.timezone, preview: opening.schedule }
    : undefined), [opening]);
  const preview = useSchedulePreview(client, spaceId, schedule, draft.timezone, known);
  const previewPending = preview.phase === 'loading' || (preview.phase === 'ready' && preview.stale);
  const previewInvalid = preview.phase === 'ready' && !preview.stale && !preview.preview.valid;
  // A stored schedule that never matches must not block a title edit: only a schedule being changed is held to the preview.
  const scheduleBlocks = scheduleTouched && previewInvalid;
  const zones = useMemo(() => timeZoneOptions(draft.timezone), [draft.timezone]);

  const close = () => { if (!saving) onClose(); };

  useEffect(() => {
    if (inline) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || saving) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [inline, saving, onClose]);

  const wasSaving = useRef(false);
  useEffect(() => {
    if (wasSaving.current !== saving) hostCallbacks.current.onBusy?.(saving);
    wasSaving.current = saving;
  }, [saving]);

  const idFor = (key: string) => {
    if (intent.current?.key !== key) intent.current = { key, id: nextMutationId() };
    return intent.current.id;
  };

  /**
   * The edit, re-read and resent while the loop only moved under it (it fired).
   * When someone changed what this patch changes, the fresh loop and the keys
   * that moved come back for the human instead. Every attempt carries the one
   * mutation id: a refused attempt records nothing, so a later one is new to
   * the server, and a lost answer is replayed rather than applied twice.
   */
  const update = async (read: LoopView, patch: LoopDefinitionPatch): Promise<LoopView | { conflict: LoopView; moved: (keyof LoopDefinition)[] }> => {
    const clientMutationId = idFor(JSON.stringify(['update', read.id, patch]));
    let current = read;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await client.update(current, patch, { clientMutationId });
      } catch (error) {
        if (!isVersionConflict(error) || attempt >= CONFLICT_RETRIES) throw error;
        const fresh = await client.get(read.id).catch(() => { throw error; });
        const moved = movedKeys(read.definition, fresh.definition, patch);
        if (moved.length > 0) return { conflict: fresh, moved };
        current = fresh;
      }
    }
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (saving) return;
    const { errors: local, inputs } = localProblems(draft, tool, toolGate);
    setErrors(local);
    if (Object.keys(local).length > 0) {
      if (Object.keys(local).some(key => ADVANCED_PATHS.test(key))) setAdvancedOpen(true);
      return;
    }
    if (scheduleBlocks) return;
    const definition = definitionOf(draft, inputs);
    let patch: LoopDefinitionPatch | null = null;
    if (base && untouched) {
      patch = patchOf(base.definition, definitionOf(untouched, localProblems(untouched, tool).inputs), definition);
      // Nothing changed: nothing to send.
      if (Object.keys(patch).length === 0) { onClose(); return; }
    }
    setPhase({ phase: 'saving' });
    try {
      // Faster than the preview: the server checks the schedule before anything is written.
      if (scheduleTouched && previewPending) {
        const checked = await client.schedulePreview(spaceId, definition.schedule, definition.timezone, 1).catch(() => null);
        if (checked && !checked.valid) {
          setErrors({ schedule: checked.problem ?? 'The server cannot read this schedule.' });
          setPhase({ phase: 'idle' });
          return;
        }
      }
      let saved: LoopView;
      if (base && patch) {
        const result = await update(base, patch);
        if ('conflict' in result) {
          setPhase({ phase: 'conflict', fresh: result.conflict, moved: result.moved });
          return;
        }
        saved = result;
      } else {
        const create: LoopCreateDefinition = definition;
        saved = await client.create(spaceId, create, draft.enabled, { clientMutationId: idFor(JSON.stringify(['create', create, draft.enabled])) });
      }
      intent.current = null;
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
        detail: failure.kind === 'conflict' ? `${failure.detail} A loop's version also moves each time it fires: re-read it and retry.` : failure.detail,
        aftermath: failure.aftermath,
        retryable: failure.kind === 'refused' ? failure.retryable : false,
      });
    }
  };

  /** Re-read: the fresh loop under the human's edits, so their next save is judged against what is stored now. */
  const reread = (fresh: LoopView) => {
    if (base) setDraft(current => rebased(draftOf(base, tool), current, draftOf(fresh, tool)));
    setBase(fresh);
    setPhase({ phase: 'idle' });
  };

  const errorFor = (key: string) => errors[key] ?? Object.entries(errors).find(([path]) => path.startsWith(`${key}.`))?.[1] ?? null;

  const teammateOptions: ComposerSelectOption[] = teammates.options.map(t => ({ id: t.id, label: t.title, actor: { id: t.id } }));
  const personaOptions: ComposerSelectOption[] = [{ id: DEFAULT, label: 'No teammate' }, ...teammateOptions];
  const toolOptions: ComposerSelectOption[] = tools.options.map(t => ({ id: t.id, label: t.title }));
  const stop = (event: MouseEvent) => event.stopPropagation();
  const title = mode === 'edit' ? 'Edit loop' : 'New loop';
  const needsPersona = tool !== null && personaRequired(tool);
  const reader = sources.entity ? (sources as Required<Pick<LoopFormSources, 'entity'>>) : null;

  const pickAction = (action: LoopAction) => set('action', action);
  /* A radio group moves with the arrows (and Home/End); the checked radio is its one Tab stop. */
  const onActionKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = ACTIONS.findIndex(option => option.id === draft.action);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? ACTIONS.length - 1 : step === undefined ? null : (index + step + ACTIONS.length) % ACTIONS.length;
    if (next === null || saving) return;
    event.preventDefault();
    const action = ACTIONS[next]!.id;
    pickAction(action);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-testid="loop-action-${action}"]`)?.focus();
  };

  const form = (
    <form
      className={inline ? 'loop-form loop-form--inline' : 'au-dialog loop-form'}
      role={inline ? undefined : 'dialog'}
      aria-modal={inline ? undefined : true}
      aria-label={title}
      aria-busy={saving || undefined}
      data-testid="loop-form"
      onSubmit={event => void submit(event)}
      onMouseDown={inline ? undefined : stop}
      noValidate
    >
      {inline ? null : <h2 className="au-dialog__title">{title}</h2>}

      <Field label="Name" error={errorFor('title')}>
        <input
          ref={firstField}
          className="au-dialog__input"
          value={draft.title}
          maxLength={LOOP_TITLE_MAX}
          placeholder="Daily project sweep"
          aria-label="Name"
          disabled={saving}
          onChange={event => set('title', event.target.value)}
        />
      </Field>

      <fieldset className="loop-form__section" disabled={saving}>
        <legend className="au-dialog__label">What should run?</legend>
        <div className="loop-form__segmented" role="radiogroup" aria-label="What should run?" onKeyDown={onActionKey}>
          {ACTIONS.map(option => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={draft.action === option.id}
              tabIndex={draft.action === option.id ? 0 : -1}
              className={`loop-form__segment${draft.action === option.id ? ' loop-form__segment--on' : ''}`}
              data-testid={`loop-action-${option.id}`}
              disabled={saving}
              onClick={() => pickAction(option.id)}
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
              emptyNote={emptyNoteOf(teammates, 'No teammates in this space.', 'Loading teammates…')}
              note={draft.teamMemberId ? null : 'Pick who runs each firing.'}
              variant="quiet"
              tall
              disabled={saving}
              testId="loop-teammate"
            />
          </Field>
        ) : null}
        {draft.action === 'dispatch' ? (
          <p className="loop-form__muted">Each firing goes to the Dispatcher, which picks the teammate.</p>
        ) : null}
        {draft.action === 'tool' ? (
          <>
            {/* Until the tool is read its inputs are not drawn, so a refused input shows here. */}
            <Field label="Tool" error={errorFor('toolId') ?? toolProblem ?? (tool ? null : errorFor('toolInputs'))}>
              <ComposerSelect
                label="Tool"
                options={toolOptions}
                value={draft.toolId ?? ''}
                // Re-picking the tool already chosen keeps what was typed for it.
                onChange={id => setDraft(current => (id === current.toolId ? current : { ...current, toolId: id, toolInputs: {} }))}
                emptyNote={emptyNoteOf(tools, 'No tools in this space.', 'Loading tools…')}
                variant="quiet"
                tall
                disabled={saving}
                testId="loop-tool"
              />
            </Field>
            <Field label="Runs as" optional={!needsPersona} error={errorFor('teamMemberId')}>
              <ComposerSelect
                label="Runs as"
                options={personaOptions}
                value={draft.teamMemberId ?? DEFAULT}
                onChange={id => set('teamMemberId', id || null)}
                emptyNote={emptyNoteOf(teammates, 'No teammates in this space.', 'Loading teammates…')}
                note={needsPersona ? 'This tool works in tm8, so it runs as a teammate.' : 'The teammate the tool acts as, if it reaches tm8.'}
                variant="quiet"
                tall
                disabled={saving}
                testId="loop-tool-persona"
              />
            </Field>
            {tool ? <ToolInputs tool={tool} values={draft.toolInputs} errorFor={errorFor} disabled={saving}
              onChange={(name, value) => setDraft(current => ({ ...current, toolInputs: { ...current.toolInputs, [name]: value } }))} /> : null}
          </>
        ) : null}
      </fieldset>

      <Field label="About" optional error={errorFor('subjectId')}>
        {draft.subject ? (
          <RefChip reader={reader} entity={draft.subject} fallback="An entity you cannot see" testId="loop-subject"
            removeLabel="Clear subject" disabled={saving} onRemove={() => set('subject', null)} />
        ) : (
          <MembershipPicker
            search={text => sources.query({ spaceId, ...(text.trim() ? { filters: { words: text.trim() } } : {}), limit: 50 }).then(r => r.page.items)}
            onPick={(id, pickedTitle) => set('subject', { id, title: pickedTitle })}
            excludeIds={new Set(props.view ? [props.view.id] : [])}
            addLabel="Choose what it is about…"
            refusal={saving ? 'Saving…' : null}
          />
        )}
      </Field>

      <Field label="Instructions" optional error={errorFor('prompt')}>
        <ProseField
          value={draft.prompt}
          onChange={next => set('prompt', next)}
          label="Instructions"
          className="au-dialog__input"
          testId="loop-instructions"
          rows={3}
          placeholder="What each firing should do"
          disabled={saving}
          {...(skillOptions ? { skillOptions } : {})}
          {...(attach ? { attach } : {})}
          {...(onAttached ? { onAttached } : {})}
        />
      </Field>

      <fieldset className="loop-form__section" disabled={saving}>
        <legend className="au-dialog__label">When</legend>
        <ScheduleFields preset={draft.preset} onChange={preset => set('preset', preset)} />
        <Field label="Timezone" error={errorFor('timezone')}>
          <select
            className="au-dialog__input"
            aria-label="Timezone"
            value={draft.timezone}
            onChange={event => set('timezone', event.target.value)}
          >
            {zones.map(zone => <option key={zone} value={zone}>{zone}</option>)}
          </select>
        </Field>
        {errorFor('schedule') ? <p className="au-dialog__missing" role="alert">{errorFor('schedule')}</p> : null}
        <SchedulePreviewPanel state={preview} timezone={draft.timezone} />
        {previewInvalid && !scheduleTouched ? (
          <p className="loop-form__muted" data-testid="loop-schedule-stored-note">The stored schedule never fires; other edits still save.</p>
        ) : null}
      </fieldset>

      <details className="loop-form__advanced" open={advancedOpen} onToggle={event => setAdvancedOpen((event.target as HTMLDetailsElement).open)}>
        <summary>Advanced</summary>
        <fieldset className="loop-form__plain" disabled={saving}>
          {draft.action === 'spawn' ? (
            <SpawnSettings draft={draft} set={set} projects={projects} profiles={profiles} sources={sources} spaceId={spaceId} errorFor={errorFor} reader={reader} />
          ) : null}
          <Field label="If the previous run is still going" error={errorFor('concurrency')}>
            <select className="au-dialog__input" aria-label="Concurrency" value={draft.concurrency}
              onChange={event => set('concurrency', event.target.value as LoopConcurrency)}>
              <option value="skip">Skip this firing</option>
              <option value="queue">Wait, then run</option>
            </select>
          </Field>
          {/* Text, not type=number: a number box that cannot parse reads as empty, which would clear a stored value. */}
          <Field label="Max runtime (minutes)" optional error={errorFor('maxRuntimeSeconds')}>
            <input className="au-dialog__input" inputMode="numeric" aria-label="Max runtime (minutes)"
              placeholder={`${LOOP_MAX_RUNTIME_MIN_SECONDS / 60}–${LOOP_MAX_RUNTIME_MAX_SECONDS / 60}`}
              value={draft.maxRuntimeMinutes} onChange={event => set('maxRuntimeMinutes', event.target.value)} />
          </Field>
          <div className="loop-form__row">
            <Field label="Retries" error={errorFor('retry.attempts')}>
              <input className="au-dialog__input" inputMode="numeric" aria-label="Retries"
                value={draft.retryAttempts} onChange={event => set('retryAttempts', event.target.value)} />
            </Field>
            <Field label="Retry delay (seconds)" error={errorFor('retry.delaySeconds')}>
              <input className="au-dialog__input" inputMode="numeric" aria-label="Retry delay (seconds)"
                value={draft.retryDelaySeconds} onChange={event => set('retryDelaySeconds', event.target.value)} />
            </Field>
          </div>
        </fieldset>
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
      {phase.phase === 'conflict' ? (
        <RefusalCard
          word="save refused — this loop changed while you were editing"
          detail={`Someone changed ${listWords(phase.moved.map(key => FIELD_WORDS[key]))} since you opened it. Re-read the loop to see their change; your edits stay in the form. Then save again.`}
          aftermath="Nothing was saved; your edits are kept right here."
          moves={[
            { label: 're-read', onSelect: () => reread(phase.fresh) },
            { label: 'back to the form', onSelect: () => setPhase({ phase: 'idle' }) },
          ]}
        />
      ) : null}

      <div className="au-dialog__actions">
        <button type="button" onClick={close} disabled={saving}>Cancel</button>
        <button type="submit" className="au-dialog__primary" aria-busy={saving} disabled={saving || scheduleBlocks}>
          {saving ? 'Saving…' : mode === 'edit' ? 'Save loop' : 'Create loop'}
        </button>
      </div>
    </form>
  );
  if (inline) return form;
  const dialog = <div className="au-dialog__backdrop" role="presentation" onMouseDown={close}>{form}</div>;
  /* On the phone each picker opens as a sheet in the frame's sheet host. The
     dialog joins them there, so a sheet opened from it is drawn above it
     rather than under the dialog's own layer (authoring-phone.css). */
  return sheetHost ? createPortal(dialog, sheetHost) : dialog;
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

/** A picked entity as a chip: the picked title, or the stored id's title read when drawn — never the raw id. */
function RefChip({ reader, entity, fallback, testId, removeLabel, disabled, onRemove }: {
  reader: Required<Pick<LoopFormSources, 'entity'>> | null;
  entity: { id: EntityId; title: string };
  fallback: string;
  testId?: string;
  removeLabel: string;
  disabled: boolean;
  onRemove(): void;
}) {
  const ref = useEntityRef(entity.title ? null : reader, entity.title ? null : entity.id);
  const label = entity.title || (ref.status === 'ready' || ref.status === 'loading' ? entityRefLabel(ref, fallback) : fallback);
  return (
    <span className="loop-form__chip" data-testid={testId}>
      {label}
      <button type="button" aria-label={removeLabel} disabled={disabled} onClick={onRemove}>×</button>
    </span>
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
  const bound = new Set(tool.secretBindings.map(binding => binding.inputName));
  return (
    <div className="loop-form__inputs" data-testid="loop-tool-inputs">
      {inputs.map((input: ToolInput) => (
        <label key={input.name} className="tool-field">
          <span>{input.name}{input.required ? ' · required' : ''}</span>
          {input.description ? <small>{input.description}</small> : null}
          {input.type === 'secret' ? (
            bound.has(input.name)
              ? <small>Uses the secret bound on the tool; a loop never stores one.</small>
              : <small className={input.required ? 'au-dialog__missing' : undefined}>
                No secret is bound on the tool for this input{input.required ? ', so a firing will be refused' : ''}. Bind one on the tool: a loop never stores one.
              </small>
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
  // An empty or partial number stays empty (NaN) rather than snapping to a bound the human did not type.
  const shown = (n: number) => (Number.isNaN(n) ? '' : String(n));
  return (
    <div className="loop-form__schedule">
      <select
        className="au-dialog__input"
        aria-label="Repeat"
        data-testid="loop-preset"
        value={preset.kind}
        onChange={event => {
          const kind = event.target.value as SchedulePresetKind;
          // Custom starts from what the current preset writes, unless an expression was already typed (or stored).
          onChange({ ...preset, kind, cron: kind === 'custom' && preset.kind !== 'custom' && preset.cron.trim() === '' ? expressionOf(preset) : preset.cron });
        }}
      >
        {PRESET_LABELS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      {preset.kind === 'hourly' ? (
        <label className="loop-form__inline">at minute
          <input className="au-dialog__input" inputMode="numeric" aria-label="Minute"
            value={shown(preset.minute)} onChange={event => onChange({ ...preset, minute: wholeNumberOf(event.target.value) })} />
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
          <input className="au-dialog__input" inputMode="numeric" aria-label="Every"
            value={shown(preset.every)} onChange={event => onChange({ ...preset, every: wholeNumberOf(event.target.value) })} />
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

const ACCESS_OPTIONS: ComposerSelectOption[] = ACCESS_MODE_CYCLE.map(mode => ({ id: mode ?? DEFAULT, label: mode ? accessModeLabel(mode) : "Teammate's default" }));
const SESSION_MODE_OPTIONS: ComposerSelectOption[] = [
  { id: DEFAULT, label: 'Worker (default)' },
  ...LAUNCH_MODES.filter(mode => mode.id !== 'dispatcher').map(mode => ({ id: mode.id, label: mode.label, hint: mode.description })),
];
const WORKDIR_OPTIONS: ComposerSelectOption[] = [
  { id: DEFAULT, label: 'Default' },
  ...WORKDIR_MODE_OPTIONS.map(option => ({ id: option.id, label: option.label, hint: option.description })),
  { id: SCRATCH_OPTION.id, label: SCRATCH_OPTION.label, hint: SCRATCH_OPTION.description },
];
const CREDENTIAL_OPTIONS: ComposerSelectOption[] = [
  { id: DEFAULT, label: 'Auto' },
  { id: 'member', label: 'Member', hint: "The acting member's own credential" },
  { id: 'space', label: 'Space', hint: 'A credential the space holds' },
  { id: 'node', label: 'Node', hint: "The node's credential" },
];

/** A stored value the options no longer offer stays visible (and pickable) rather than reading as blank. */
function withCurrent(options: ComposerSelectOption[], value: string, label: (value: string) => string): ComposerSelectOption[] {
  return value === DEFAULT || options.some(option => option.id === value) ? options : [...options, { id: value, label: label(value) }];
}

/** The models the editable catalog offers per agent tool (Settings can add or hide one). */
function useModelOptions(current: string): ComposerSelectOption[] {
  const version = useSyncExternalStore(subscribeModelCatalog, modelCatalogVersion, modelCatalogVersion);
  return useMemo(() => withCurrent([
    { id: DEFAULT, label: "Teammate's default" },
    ...AGENT_TOOLS.flatMap(agent => catalogModelsFor(currentNodeKey(), agent.id).map(model => ({
      id: `${agent.id}::${model.model}`, label: model.label, group: agent.label, ...(model.note ? { hint: model.note } : {}),
    }))),
  ], current, value => `${value.split('::')[1] ?? value} (not in this catalog)`), [current, version]);
}

/** The efforts the picked model accepts; every effort while the model is the teammate's own. */
function effortOptions(model: string, current: string): ComposerSelectOption[] {
  const [agent, id] = model.split('::');
  const entry = model ? catalogModelsFor(currentNodeKey(), agent).find(candidate => candidate.model === id) : undefined;
  const efforts = entry?.efforts ?? (Object.keys(EFFORT_LABELS) as (keyof typeof EFFORT_LABELS)[]);
  return withCurrent([
    { id: DEFAULT, label: 'Default' },
    ...efforts.map(effort => ({ id: effort, label: EFFORT_LABELS[effort] })),
  ], current, value => `${EFFORT_LABELS[value as keyof typeof EFFORT_LABELS] ?? value} (not offered for this model)`);
}

type DraftSetter = <K extends keyof Draft>(key: K, value: Draft[K]) => void;
type StringKey = { [K in keyof Draft]: Draft[K] extends string ? K : never }[keyof Draft];

type ProjectOptions = { rows: { id: string; name: string; trusted: boolean }[]; loaded: boolean; problem: string | null };

function SpawnSettings({ draft, set, projects, profiles, sources, spaceId, errorFor, reader }: {
  draft: Draft;
  set: DraftSetter;
  projects: ProjectOptions;
  profiles: Options;
  sources: LoopFormSources;
  spaceId: SpaceId;
  errorFor(key: string): string | null;
  reader: Required<Pick<LoopFormSources, 'entity'>> | null;
}) {
  const modelOptions = useModelOptions(draft.model);
  const projectOptions = useMemo<ComposerSelectOption[]>(() => withCurrent([
    { id: DEFAULT, label: 'No project' },
    ...projects.rows.map(p => ({ id: p.id, label: p.name, ...(p.trusted ? {} : { disabledReason: UNTRUSTED_REASON }) })),
  ], draft.projectId, () => (projects.loaded ? 'A project you cannot see' : 'Loading…')), [projects, draft.projectId]);
  const projectNote = projects.problem ? `Could not read the projects: ${projects.problem}` : projects.loaded ? null : 'Loading projects…';
  const profileOptions = useMemo<ComposerSelectOption[]>(() => withCurrent([
    { id: DEFAULT, label: "Teammate's default" },
    ...profiles.options.map(p => {
      // Only an active profile can govern a session; draft and retired ones show, refused with why (D51.3).
      const status = p.state.kind === 'interaction_profile' ? p.state.status : 'active';
      const reason = PROFILE_STATUS_REASON[status];
      return { id: p.id, label: p.title, ...(reason ? { disabledReason: reason } : {}) };
    }),
  ], draft.interactionProfileId, () => 'A profile you cannot see'), [profiles.options, draft.interactionProfileId]);
  const select = (label: string, key: StringKey, options: readonly ComposerSelectOption[], testId: string, path: string, emptyNote = 'Nothing to choose.', note: string | null = null) => (
    <Field label={label} error={errorFor(path)}>
      <ComposerSelect label={label} options={options} value={draft[key]} onChange={id => set(key, id)}
        emptyNote={emptyNote} note={note} variant="quiet" testId={testId} />
    </Field>
  );
  return (
    <div className="loop-form__spawn">
      {select('Model', 'model', modelOptions, 'loop-model', 'config.model')}
      {select('Reasoning effort', 'reasoningEffort', effortOptions(draft.model, draft.reasoningEffort), 'loop-effort', 'config.reasoningEffort')}
      {select('Access', 'accessMode', ACCESS_OPTIONS, 'loop-access', 'config.accessMode')}
      {select('Mode', 'sessionMode', SESSION_MODE_OPTIONS, 'loop-mode', 'config.mode')}
      {select('Project', 'projectId', projectOptions, 'loop-project', 'config.projectId', 'Nothing to choose.', projectNote)}
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
            <RefChip key={memory.id} reader={reader} entity={memory} fallback="A memory you cannot see"
              removeLabel={`Remove ${memory.title || 'memory'}`} disabled={false}
              onRemove={() => set('memories', draft.memories.filter(m => m.id !== memory.id))} />
          ))}
          {draft.memories.length < LOOP_MEMORY_IDS_MAX ? (
            <MembershipPicker
              search={text => sources.query({ spaceId, kinds: ['memory' as never], ...(text.trim() ? { filters: { words: text.trim() } } : {}), limit: 50 }).then(r => r.page.items)}
              onPick={(id, title) => set('memories', [...draft.memories, { id, title }])}
              excludeIds={new Set(draft.memories.map(m => m.id))}
              addLabel="+ memory"
            />
          ) : null}
        </div>
      </Field>
      {select('Credential source', 'credentialSource', CREDENTIAL_OPTIONS, 'loop-credential', 'config.credentialSource')}
      {select('Interaction profile', 'interactionProfileId', profileOptions, 'loop-profile', 'config.interactionProfileId',
        emptyNoteOf(profiles, 'Nothing to choose.', 'Loading profiles…'))}
    </div>
  );
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
        <LoopForm
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
