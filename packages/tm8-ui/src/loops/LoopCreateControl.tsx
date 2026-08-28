import { useEffect, useRef, useState, type FormEvent, type MouseEvent, type RefObject } from 'react';
import type { CommandResult, EntityId, SpaceId } from '@tm8/contract';
import { DisabledAction } from '../panels/honesty/DisabledWithReason';
import { classifyFailure, createdIdOf, newEntityInput, type AuthoringCommands } from '../authoring/commands';
import { RefusalCard } from '../authoring/RefusalCard';
import { loopScheduleProblem, nextLoopRunAt } from './schedule';
import './loops.css';

interface LoopDraft {
  title: string;
  schedule: string;
  teamMemberId: string;
  subjectId: string;
  prompt: string;
  config: string;
  enabled: boolean;
}

const INITIAL_DRAFT: LoopDraft = {
  title: '',
  schedule: 'every 1d',
  teamMemberId: '',
  subjectId: '',
  prompt: '',
  config: '{}',
  enabled: true,
};

type CreatePhase =
  | { phase: 'idle' }
  | { phase: 'creating' }
  | { phase: 'refused'; cause: string; detail: string; aftermath: string; retryable: boolean };

export function LoopCreateControl({
  spaceId,
  commands,
  label,
  onCreated,
}: {
  spaceId: SpaceId;
  commands: AuthoringCommands | null;
  label: string;
  onCreated?: (id: EntityId, result: CommandResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<LoopDraft>(INITIAL_DRAFT);
  const [phase, setPhase] = useState<CreatePhase>({ phase: 'idle' });
  const firstField = useRef<HTMLInputElement | null>(null);
  const creating = phase.phase === 'creating';

  useEffect(() => {
    if (open) firstField.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || creating) return;
      event.stopPropagation();
      setOpen(false);
      setPhase({ phase: 'idle' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [creating, open]);

  if (commands === null) {
    return (
      <DisabledAction
        reason={{ cause: 'Creating is not wired here', remedy: 'this surface has no command executor' }}
        label={label}
      >
        {label}
      </DisabledAction>
    );
  }

  const scheduleProblem = loopScheduleProblem(draft.schedule);
  const configProblem = jsonObjectProblem(draft.config);
  const runnerProblem = entityIdProblem(draft.teamMemberId, 'Runner');
  const subjectProblem = entityIdProblem(draft.subjectId, 'Subject');
  const titleProblem = draft.title.trim() === '' ? 'Title is required.' : null;
  const invalid = titleProblem ?? scheduleProblem ?? configProblem ?? runnerProblem ?? subjectProblem;

  const close = () => {
    if (creating) return;
    setOpen(false);
    setPhase({ phase: 'idle' });
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (creating || invalid !== null) return;
    const now = new Date();
    const next = nextLoopRunAt(draft.schedule, now);
    if (next === null) return;

    setPhase({ phase: 'creating' });
    try {
      const result = await commands.createEntity(newEntityInput(
        spaceId,
        'loop',
        draft.title.trim(),
        undefined,
        {
          schedule: draft.schedule.trim(),
          teamMemberId: optionalId(draft.teamMemberId),
          subjectId: optionalId(draft.subjectId),
          prompt: draft.prompt,
          config: JSON.parse(draft.config) as Record<string, unknown>,
          enabled: draft.enabled,
          nextRunAt: draft.enabled ? next.toISOString() : null,
        },
      ));
      const id = createdIdOf(result);
      if (id === null) {
        setPhase({
          phase: 'refused',
          cause: 'created, but the node did not return the new id',
          detail: 'The command succeeded without an entity id or patch id.',
          aftermath: 'The loop may exist; reload the list before trying again.',
          retryable: false,
        });
        return;
      }
      setDraft(INITIAL_DRAFT);
      setPhase({ phase: 'idle' });
      setOpen(false);
      onCreated?.(id, result);
    } catch (error) {
      const failure = classifyFailure(error, 'create');
      setPhase({
        phase: 'refused',
        cause: failure.cause,
        detail: failure.detail,
        aftermath: failure.aftermath,
        retryable: failure.kind === 'refused' ? failure.retryable : false,
      });
    }
  };

  const stop = (event: MouseEvent) => event.stopPropagation();

  return (
    <>
      <button type="button" className="lp__new" onClick={() => setOpen(true)}>{label}</button>
      {open ? (
        <div className="au-dialog__backdrop" role="presentation" onMouseDown={close}>
          <form
            className="au-dialog loop-create"
            role="dialog"
            aria-modal="true"
            aria-label="Create loop"
            data-testid="loop-create-dialog"
            onSubmit={(event) => void submit(event)}
            onMouseDown={stop}
          >
            <h2 className="au-dialog__title">Create loop</h2>
            <LoopTextField
              inputRef={firstField}
              label="Title"
              value={draft.title}
              problem={titleProblem}
              required
              maxLength={200}
              placeholder="Daily project sweep"
              onChange={(title) => setDraft((current) => ({ ...current, title }))}
            />
            <LoopTextField
              label="Schedule"
              value={draft.schedule}
              problem={scheduleProblem}
              required
              maxLength={200}
              placeholder="every 1d or 0 9 * * *"
              hint="UTC · every <n>m/h/d or five-field cron"
              onChange={(schedule) => setDraft((current) => ({ ...current, schedule }))}
            />
            <LoopTextField
              label="Runner entity ID"
              value={draft.teamMemberId}
              problem={runnerProblem}
              placeholder="blank routes through Dispatcher"
              hint="Optional · must name a teammate in this space"
              onChange={(teamMemberId) => setDraft((current) => ({ ...current, teamMemberId }))}
            />
            <LoopTextField
              label="Subject entity ID"
              value={draft.subjectId}
              problem={subjectProblem}
              placeholder="blank uses this loop"
              hint="Optional · any live entity in this space"
              onChange={(subjectId) => setDraft((current) => ({ ...current, subjectId }))}
            />
            <LoopTextField
              label="Prompt"
              value={draft.prompt}
              multiline
              maxLength={20_000}
              placeholder="Instruction sent on every firing"
              hint="Optional"
              onChange={(prompt) => setDraft((current) => ({ ...current, prompt }))}
            />
            <LoopTextField
              label="Spawn config (JSON)"
              value={draft.config}
              problem={configProblem}
              multiline
              placeholder='{"model":"…","accessMode":"…"}'
              onChange={(config) => setDraft((current) => ({ ...current, config }))}
            />
            <label className="loop-create__toggle">
              <input
                type="checkbox"
                checked={draft.enabled}
                disabled={creating}
                onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
              />
              <span>Enable after creation</span>
            </label>
            <p className="loop-create__truth" role="note">
              The first run is scheduled from this expression. “Run now” queues a due firing for the next scheduler tick.
            </p>

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
              <button type="button" onClick={close} disabled={creating}>Cancel</button>
              <button
                type="submit"
                className="au-dialog__primary"
                aria-busy={creating}
                disabled={creating || invalid !== null}
              >
                {creating ? 'Creating…' : 'Create loop'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

function LoopTextField({
  inputRef,
  label,
  value,
  problem,
  required,
  multiline,
  maxLength,
  placeholder,
  hint,
  onChange,
}: {
  inputRef?: RefObject<HTMLInputElement | null>;
  label: string;
  value: string;
  problem?: string | null;
  required?: boolean;
  multiline?: boolean;
  maxLength?: number;
  placeholder?: string;
  hint?: string;
  onChange: (value: string) => void;
}) {
  const control = multiline ? (
    <textarea
      className="au-dialog__input"
      rows={3}
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  ) : (
    <input
      ref={inputRef}
      className="au-dialog__input"
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
  return (
    <label className="au-dialog__field">
      <span className="au-dialog__label">
        {label}{required ? null : <em className="au-dialog__optional"> · optional</em>}
      </span>
      {control}
      {hint ? <span className="loop-create__hint">{hint}</span> : null}
      {problem ? <span className="au-dialog__missing" role="alert">{problem}</span> : null}
    </label>
  );
}

function optionalId(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function entityIdProblem(value: string, label: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
    ? null
    : `${label} must be a complete entity UUID.`;
}

function jsonObjectProblem(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? null
      : 'Spawn config must be a JSON object.';
  } catch {
    return 'Spawn config must be valid JSON.';
  }
}
