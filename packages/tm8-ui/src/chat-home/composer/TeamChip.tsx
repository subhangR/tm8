/**
 * THE COORDINATOR'S TEAM — `👥 N`, drawn only in Coordinator mode.
 *
 * N counts every owner on the team: the generic New worker (always on, never
 * removable), any model-only workers added with `+ Add model`, and every
 * teammate ticked. The trigger's tooltip lists them.
 *
 * The picker has two halves. ABOVE the search box: everything selected, each
 * with its own model + effort — New worker first, added workers, then ticked
 * teammates in tick order (defaulting to the teammate's own model at Medium).
 * BELOW it: only the teammates not yet picked, with their model muted. Ticking
 * moves a row up; unticking moves it back down.
 *
 * Native selects, because this already is a popover and a second portalled
 * one inside it would dismiss the first.
 */
import { useMemo, useState } from 'react';
import type { LaunchModelEffort } from '@tm8/contract';
import type { ChatModelOption, ChatTeammateOption } from '../types';
import { ComposerIcon } from './ComposerIcons';
import { ComposerPopover } from './ComposerPopover';
import {
  EFFORT_LABELS,
  effortAvailability,
  shortModelLabel,
  slotEffort,
  slotModel,
  teamMembers,
  teamSize,
  type ComposerTeam,
  type ModelChoice,
  type TeamSlot,
} from './composer-model';

/** Past this many unpicked teammates the picker grows a search box. */
const SEARCH_AT = 6;

export interface TeamChipProps {
  team: ComposerTeam;
  onChange: (team: ComposerTeam) => void;
  teammates: readonly ChatTeammateOption[];
  models: readonly ChatModelOption[];
  workerChoices: readonly ModelChoice[];
  /** What a generic worker runs when it has no model of its own (the chat's model). */
  defaultModel: string | null;
  testId?: string;
}

export function TeamChip({ team, onChange, teammates, models, workerChoices, defaultModel, testId = 'tch-team' }: TeamChipProps) {
  const names = teamMembers(team, teammates, models, defaultModel);
  const count = teamSize(team);
  return (
    <ComposerPopover
      label="Coordinator team"
      testId={testId}
      className="tch-team"
      title={names.join('\n')}
      menuHeight={460}
      menuWidth={380}
      fitViewport
      trigger={<>
        <ComposerIcon name="team" />
        <span className="tch-pop__value" data-testid={`${testId}-count`}>{count}</span>
      </>}
    >
      {() => (
        <TeamPicker
          team={team}
          onChange={onChange}
          teammates={teammates}
          models={models}
          workerChoices={workerChoices}
          defaultModel={defaultModel}
          testId={testId}
        />
      )}
    </ComposerPopover>
  );
}

let addedSeq = 0;
function addedWorkerId(): string {
  addedSeq += 1;
  return `w${Date.now().toString(36)}${addedSeq}`;
}

/** The team picker itself: the chip's popover, or — compact composer — a section of ＋. */
export function TeamPicker({ team, onChange, teammates, models, workerChoices, defaultModel, testId }: Required<TeamChipProps>) {
  const [query, setQuery] = useState('');
  const picked = new Set(team.teammates.map((slot) => slot.teammateId));
  const unpicked = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return teammates.filter((teammate) =>
      !picked.has(teammate.id) && (!needle || teammate.label.toLowerCase().includes(needle)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teammates, team.teammates, query]);
  const unpickedTotal = teammates.filter((teammate) => !picked.has(teammate.id)).length;

  const pick = (id: string) =>
    onChange({ ...team, teammates: [...team.teammates, { teammateId: id, model: null, effort: null }] });
  const unpick = (id: string) =>
    onChange({ ...team, teammates: team.teammates.filter((slot) => slot.teammateId !== id) });

  return (
    <div className="tch-teampick" data-testid={`${testId}-picker`}>
      <div className="tch-teampick__picked" role="group" aria-label="On the team">
        <div className="tch-teampick__row tch-teampick__row--picked">
          <input type="checkbox" checked disabled aria-label="New worker (always on the team)" />
          <span className="tch-teampick__name" title="A generic worker — no teammate, just a model">New worker</span>
          <SlotSelects
            slot={team.worker}
            fallback={defaultModel}
            onChange={(worker) => onChange({ ...team, worker })}
            models={models}
            choices={workerChoices}
            label="New worker"
            testId={`${testId}-worker`}
          />
        </div>
        {team.workers.map((slot, index) => (
          <div key={slot.id} className="tch-teampick__row tch-teampick__row--picked">
            <button
              type="button"
              className="tch-teampick__remove"
              aria-label={`Remove added worker ${index + 1}`}
              title="Remove"
              onClick={() => onChange({ ...team, workers: team.workers.filter((entry) => entry.id !== slot.id) })}
            >
              ×
            </button>
            <span className="tch-teampick__name">New worker</span>
            <SlotSelects
              slot={slot}
              fallback={defaultModel}
              onChange={(next) => onChange({
                ...team,
                workers: team.workers.map((entry) => (entry.id === slot.id ? { ...entry, ...next } : entry)),
              })}
              models={models}
              choices={workerChoices}
              label={`Added worker ${index + 1}`}
              testId={`${testId}-added-${index}`}
            />
          </div>
        ))}
        {team.teammates.map((slot) => {
          const teammate = teammates.find((entry) => entry.id === slot.teammateId);
          if (!teammate) return null;
          return (
            <label key={slot.teammateId} className="tch-teampick__row tch-teampick__row--picked">
              <input
                type="checkbox"
                data-testid={`${testId}-${teammate.id}`}
                checked
                onChange={() => unpick(teammate.id)}
              />
              <span className="tch-teampick__name">{teammate.label}</span>
              <SlotSelects
                slot={slot}
                fallback={teammate.model}
                onChange={(next) => onChange({
                  ...team,
                  teammates: team.teammates.map((entry) =>
                    (entry.teammateId === slot.teammateId ? { ...entry, ...next } : entry)),
                })}
                models={models}
                choices={workerChoices}
                label={teammate.label}
                testId={`${testId}-${teammate.id}`}
              />
            </label>
          );
        })}
        <button
          type="button"
          className="tch-linkbtn tch-teampick__add"
          data-testid={`${testId}-add-model`}
          onClick={() => onChange({ ...team, workers: [...team.workers, { id: addedWorkerId(), model: null, effort: null }] })}
        >
          + Add model
        </button>
      </div>
      {unpickedTotal > SEARCH_AT ? (
        <input
          type="search"
          className="tch-teampick__search"
          placeholder="Search teammates"
          aria-label="Search teammates"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}
      <div className="tch-teampick__list" role="group" aria-label="Teammates">
        {teammates.length === 0 ? <p className="tch-pickmenu__note">No teammates in this space.</p> : null}
        {unpickedTotal > 0 && unpicked.length === 0 ? <p className="tch-pickmenu__note">No teammate matches.</p> : null}
        {unpicked.map((teammate) => {
          const model = teammate.model
            ? shortModelLabel(models.find((entry) => entry.model === teammate.model)?.label ?? teammate.model)
            : null;
          return (
            <label key={teammate.id} className="tch-teampick__row">
              <input
                type="checkbox"
                data-testid={`${testId}-${teammate.id}`}
                checked={false}
                onChange={() => pick(teammate.id)}
              />
              <span className="tch-teampick__name">{teammate.label}</span>
              {model ? <span className="tch-teampick__model">{model}</span> : null}
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** A slot's model + effort pair; the model falls back to `fallback`, effort to Medium. */
function SlotSelects({ slot, fallback, onChange, models, choices, label, testId }: {
  slot: TeamSlot;
  fallback: string | null | undefined;
  onChange: (slot: TeamSlot) => void;
  models: readonly ChatModelOption[];
  choices: readonly ModelChoice[];
  label: string;
  testId: string;
}) {
  const model = slotModel(slot, fallback);
  const stops = effortAvailability(models.find((entry) => entry.model === model)).stops;
  const effort = slotEffort(slot);
  /* A fallback model the catalog no longer lists still has to show as itself. */
  const listed = model === null || choices.some((choice) => choice.id === model);
  return (
    <span className="tch-teampick__selects">
      <select
        aria-label={`${label} model`}
        data-testid={`${testId}-model`}
        value={model ?? ''}
        onChange={(event) => onChange({ ...slot, model: event.target.value || null })}
      >
        {model === null ? <option value="">Model</option> : null}
        {!listed && model ? <option value={model}>{shortModelLabel(model)}</option> : null}
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id} disabled={Boolean(choice.disabledReason)} title={choice.label}>
            {shortModelLabel(choice.label)}
          </option>
        ))}
      </select>
      <select
        aria-label={`${label} effort`}
        data-testid={`${testId}-effort`}
        value={effort}
        onChange={(event) => onChange({ ...slot, effort: event.target.value as LaunchModelEffort })}
      >
        {(stops.length && !stops.includes(effort) ? [effort, ...stops] : stops.length ? stops : [effort]).map((stop) => (
          <option key={stop} value={stop}>{EFFORT_LABELS[stop].short}</option>
        ))}
      </select>
    </span>
  );
}
