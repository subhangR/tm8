/**
 * THE CREW — the orchestrate pool, set at creation.
 *
 * The composer row above configures a CHAT THREAD (coordinator: teammate +
 * claude-code model + effort). This panel configures SPAWN DEFAULTS — N
 * workers, each a teammate + ANY catalog model (codex included) + effort +
 * a ⚙ with the rest of its spawn shape. Two objects, two validity rules, two
 * different model lists: that is why GPT 5.6 is pickable here and disabled
 * up there.
 *
 * Crew, not wizard: at creation you set the POOL and the POLICY. Assignment
 * happens later, in the thread, at dispatch. The policy (parallelism,
 * autonomy, on-failure) is orchestrate's ⚙ in the row, so it is shown here
 * read-only rather than owned twice.
 *
 * A worker's access mode is CAPPED by the thread's permission: options above
 * the rung render disabled with the reason, and the brief the coordinator
 * receives is already capped, so the cap holds even against a stale pick.
 */
import type { LaunchModelEffort } from '@tm8/contract';
import { Avatar } from '../../kit';
import { ComposerSelect } from '../ComposerSelect';
import type { ChatModelOption, ChatTeammateOption } from '../types';
import { ComposerPopover } from './ComposerPopover';
import { ModelEffortPicker } from './ModelEffortPicker';
import {
  MODE_OPTION_FIELDS,
  capWorkerAccess,
  crewBrief,
  modeOptionValue,
  newCrewWorker,
  workerAccessOptions,
  workerExtraCount,
  workerModelChoices,
  type CrewSpec,
  type CrewWorker,
  type ModeOptionValues,
  type PermissionRung,
} from './composer-model';

export interface CrewPanelProps {
  crew: CrewSpec;
  onChange: (crew: CrewSpec) => void;
  teammates: readonly ChatTeammateOption[];
  models: readonly ChatModelOption[];
  permission: PermissionRung;
  policy: ModeOptionValues | undefined;
  skillIds?: readonly { id: string; label: string }[];
  testId?: string;
}

const MAX_WORKERS = 8;

export function CrewPanel({ crew, onChange, teammates, models, permission, policy, skillIds = [], testId = 'tch-crew' }: CrewPanelProps) {
  const update = (key: string, patch: Partial<CrewWorker>) =>
    onChange({ workers: crew.workers.map((worker) => (worker.key === key ? { ...worker, ...patch } : worker)) });
  const remove = (key: string) => onChange({ workers: crew.workers.filter((worker) => worker.key !== key) });
  const add = () => {
    const firstWorker = teammates.find((teammate) => teammate.mode === 'worker' || teammate.mode === 'coordinated-worker') ?? teammates[0];
    const firstModel = models[0];
    onChange({
      workers: [
        ...crew.workers,
        newCrewWorker({
          teammateId: firstWorker?.id ?? '',
          model: firstModel?.model ?? '',
          effort: firstModel?.efforts?.includes('high') ? 'high' : firstModel?.efforts?.[0] ?? null,
        }),
      ],
    });
  };
  const teammateOptions = teammates.map((teammate) => ({
    id: teammate.id as string,
    label: teammate.label,
    actor: { id: teammate.id, avatar: teammate.avatar ?? null },
    ...(teammate.mode ? { hint: teammate.mode } : {}),
  }));
  const modelChoices = workerModelChoices(models);
  const brief = crewBrief(crew, { teammates, models, permission, options: policy });

  return (
    <section className="tch-crew" data-testid={testId} aria-label="Crew">
      <header className="tch-crew__head">
        <span className="tch-crew__title">Crew</span>
        <span className="tch-crew__sub">the pool this coordinator may dispatch · assignment happens at dispatch</span>
      </header>
      {crew.workers.length === 0 ? (
        <p className="tch-crew__empty">No workers yet — the coordinator will have to do everything itself.</p>
      ) : null}
      <ol className="tch-crew__list">
        {crew.workers.map((worker, index) => {
          const { accessMode, capped } = capWorkerAccess(permission, worker.accessMode);
          const extra = workerExtraCount(worker);
          const wid = `${testId}-w${index + 1}`;
          const teammate = teammates.find((entry) => entry.id === worker.teammateId);
          return (
            <li key={worker.key} className="tch-crew__row" data-testid={wid}>
              <span className="tch-crew__n">{index + 1}</span>
              <ComposerSelect
                label={`Worker ${index + 1} teammate`}
                testId={`${wid}-teammate`}
                options={teammateOptions}
                value={worker.teammateId}
                onChange={(id) => update(worker.key, { teammateId: id as CrewWorker['teammateId'] })}
                emptyNote="No agent teammate is available in this space."
              />
              <ModelEffortPicker
                label={`Worker ${index + 1} model`}
                testId={`${wid}-model`}
                models={models}
                choices={modelChoices}
                value={worker.model}
                onChange={(model) => {
                  const next = models.find((entry) => entry.model === model);
                  const keep = worker.effort && next?.efforts?.includes(worker.effort) ? worker.effort : next?.efforts?.[0] ?? null;
                  update(worker.key, { model, effort: keep });
                }}
                effort={worker.effort}
                onEffortChange={(effort: LaunchModelEffort) => update(worker.key, { effort })}
                compact
              />
              <ComposerPopover
                label={`Worker ${index + 1} options`}
                testId={`${wid}-gear`}
                badge={extra}
                title={`skills, MCPs, memories, access · ${extra} set`}
                menuWidth={300}
                menuHeight={380}
                trigger={<span className="tch-pop__gear" aria-hidden>⚙</span>}
              >
                {() => (
                  <div className="tch-optform" data-testid={`${wid}-gearform`}>
                    <p className="tch-optform__head">
                      {teammate ? <Avatar actorId={teammate.id} provenance="agent" label={teammate.label} size={15} src={teammate.avatar ?? null} /> : null}
                      <b>{teammate?.label ?? `Worker ${index + 1}`}</b>
                    </p>
                    <label className="tch-optform__row">
                      <span className="tch-optform__label">Access</span>
                      <select
                        data-testid={`${wid}-access`}
                        value={worker.accessMode ?? ''}
                        onChange={(event) => update(worker.key, { accessMode: (event.target.value || null) as CrewWorker['accessMode'] })}
                      >
                        <option value="">thread default ({capWorkerAccess(permission, null).accessMode})</option>
                        {workerAccessOptions(permission).map((option) => (
                          <option key={option.id} value={option.id} disabled={Boolean(option.disabledReason)}>
                            {option.label}{option.disabledReason ? ` — ${option.disabledReason}` : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                    {capped ? (
                      <p className="tch-optform__warn" role="note" data-testid={`${wid}-capped`}>
                        Capped to {accessMode}: a worker cannot exceed the thread's permission.
                      </p>
                    ) : null}
                    <ListField label="Skills" testId={`${wid}-skills`} values={worker.skills} onChange={(skills) => update(worker.key, { skills })} suggestions={skillIds.map((s) => s.id)} placeholder="skill id, Enter" />
                    <ListField label="MCPs" testId={`${wid}-mcps`} values={worker.mcps} onChange={(mcps) => update(worker.key, { mcps })} placeholder="server name, Enter" />
                    <ListField label="Memories" testId={`${wid}-memories`} values={worker.memories} onChange={(memories) => update(worker.key, { memories })} placeholder="memory id, Enter" />
                    <label className="tch-optform__row tch-optform__row--col">
                      <span className="tch-optform__label">Prompt extra</span>
                      <textarea
                        data-testid={`${wid}-prompt`}
                        rows={2}
                        value={worker.promptExtra}
                        onChange={(event) => update(worker.key, { promptExtra: event.target.value })}
                        placeholder="one or two lines the worker is told on spawn"
                      />
                    </label>
                  </div>
                )}
              </ComposerPopover>
              <button
                type="button"
                className="tch-crew__remove"
                data-testid={`${wid}-remove`}
                aria-label={`Remove worker ${index + 1}`}
                title="remove this worker"
                onClick={() => remove(worker.key)}
              >
                ×
              </button>
            </li>
          );
        })}
      </ol>
      <div className="tch-crew__foot">
        <button
          type="button"
          className="tch-linkbtn"
          data-testid={`${testId}-add`}
          onClick={add}
          disabled={crew.workers.length >= MAX_WORKERS || teammates.length === 0}
          title={teammates.length === 0 ? 'no teammate is available to be a worker' : crew.workers.length >= MAX_WORKERS ? `at most ${MAX_WORKERS} workers` : undefined}
        >
          + Add worker
        </button>
        <span className="tch-crew__policy" data-testid={`${testId}-policy`}>
          {MODE_OPTION_FIELDS.orchestrate.map((field) => (
            <span key={field.key}>{field.label} <b>{String(modeOptionValue(field, policy))}</b></span>
          ))}
          <span className="tch-crew__policyhint">· change in ⚙</span>
        </span>
      </div>
      {brief ? (
        <details className="tch-crew__brief" data-testid={`${testId}-brief`}>
          <summary>Sent to the coordinator with your first message</summary>
          <pre>{brief.trim()}</pre>
        </details>
      ) : null}
    </section>
  );
}

function ListField({
  label, values, onChange, suggestions = [], placeholder, testId,
}: { label: string; values: string[]; onChange: (values: string[]) => void; suggestions?: readonly string[]; placeholder?: string; testId: string }) {
  const listId = `${testId}-list`;
  return (
    <div className="tch-optform__row tch-optform__row--col">
      <span className="tch-optform__label">{label}</span>
      <span className="tch-optform__pills">
        {values.map((value) => (
          <button
            key={value}
            type="button"
            className="tch-pill"
            title={`remove ${value}`}
            onClick={() => onChange(values.filter((entry) => entry !== value))}
          >
            {value} <span aria-hidden>×</span>
          </button>
        ))}
      </span>
      <input
        type="text"
        data-testid={testId}
        list={suggestions.length ? listId : undefined}
        placeholder={placeholder}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          const input = event.currentTarget;
          const next = input.value.trim();
          if (!next) return;
          event.preventDefault();
          if (!values.includes(next)) onChange([...values, next]);
          input.value = '';
        }}
      />
      {suggestions.length ? (
        <datalist id={listId}>{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
      ) : null}
    </div>
  );
}
