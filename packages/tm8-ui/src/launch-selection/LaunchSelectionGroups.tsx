import { useId, useState } from 'react';
import type { SpawnSelectionGroup } from '@tm8/contract';

import {
  isTicked,
  LAUNCH_GROUP_LABEL,
  type LaunchContextRow,
} from '../domain/launch-selection';
import type { LaunchSelection } from './useLaunchSelection';

/** The pool a person may ADD from, per group. Undefined: never read into this client (unknown, not empty). */
export type LaunchSelectionCandidates = Partial<Record<SpawnSelectionGroup, readonly LaunchContextRow[] | undefined>>;

const GLYPH: Record<SpawnSelectionGroup, string> = { memories: '◈', skills: '✧', references: '▤' };

const VIA_WORD: Record<string, string> = {
  teammate: 'the teammate’s',
  inherited: 'inherited',
  task: 'the task’s',
  linked: 'linked to the task',
  attached: 'attached to the task',
};

/** Past this many candidates the add picker gets a filter box. */
const FILTER_FROM = 6;

/**
 * THE LAUNCH'S CONTEXT, PER GROUP (design 01a0d348 §5.1, I9) — memories,
 * skills and references, each showing the launch's DEFAULTS pre-ticked and
 * labelled "default". Unticking one is a removal, stated as a diff at the
 * group's head ("−2 defaults removed · +1 added"); an addition comes from the
 * space through the group's picker.
 *
 * A PICKER, NOT A MANAGER. Nothing here writes an edge: a removal or an
 * addition rides this one launch (`selection`), and a group the person never
 * edits is not sent at all.
 *
 * Header text is graph content and renders as plain text.
 */
export function LaunchSelectionGroups({
  selection,
  groups,
  candidates,
}: {
  selection: LaunchSelection;
  /** Which groups this surface edits here — in Jev mode the sheet shows Jev's checklists for memories and skills. */
  groups: readonly SpawnSelectionGroup[];
  candidates: LaunchSelectionCandidates;
}) {
  return (
    <>
      {groups.map((group) => (
        <SelectionGroup key={group} group={group} selection={selection} candidates={candidates[group]} />
      ))}
      {selection.warnings.map((warning) => (
        <p key={warning} className="ls__profile-empty" role="status">{warning}</p>
      ))}
    </>
  );
}

function SelectionGroup({
  group,
  selection,
  candidates,
}: {
  group: SpawnSelectionGroup;
  selection: LaunchSelection;
  candidates: readonly LaunchContextRow[] | undefined;
}) {
  const pickerId = `lsel-${group}-${useId()}`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const defaults = selection.defaults[group];
  const edit = selection.edits[group];
  const lock = selection.lock(group);
  const diff = selection.diff(group);
  const label = LAUNCH_GROUP_LABEL[group];

  const defaultRows = defaults.status === 'ready' ? defaults.rows : [];
  const defaultIds = new Set(defaultRows.map((row) => row.id));
  const addedRows = selection.added[group].filter((row) => edit.added.includes(row.id) && !defaultIds.has(row.id));
  const needle = query.trim().toLowerCase();
  const pool = (candidates ?? []).filter((row) => !defaultIds.has(row.id));
  const shown = needle
    ? pool.filter((row) => `${row.title} ${row.kind} ${row.text ?? ''}`.toLowerCase().includes(needle))
    : pool;

  const row = (item: LaunchContextRow, where: 'default' | 'added' | 'pool') => {
    const on = isTicked(defaults, edit, item.id);
    const refused = selection.refusal?.group === group && selection.refusal.id === item.id ? selection.refusal.reason : null;
    const removed = where === 'default' && !on;
    const tag = where === 'default'
      ? (removed ? 'default · removed' : 'default')
      : on ? 'added' : null;
    return (
      <div key={`${where}-${item.id}`} className="lsel__item">
        <button
          type="button"
          role="checkbox"
          aria-checked={on}
          aria-disabled={lock ? true : undefined}
          className={`ls__row lsel__row ${on ? 'ls__row--on' : ''} ${removed ? 'lsel__row--removed' : ''} ${lock ? 'ls__row--refused' : ''}`}
          title={lock ?? undefined}
          data-testid={`lsel-row-${group}-${item.id}`}
          onClick={(event) => {
            if (lock) return event.preventDefault();
            selection.toggle(group, item);
          }}
        >
          <span className="ls__glyph" aria-hidden="true">{GLYPH[group]}</span>
          <span className="ls__rowtext">
            <span className="ls__rowname lsel__name">{item.title}</span>
            <span className="ls__rowsub">
              {tag ? <span className={`lsel__tag ${removed ? 'lsel__tag--removed' : ''}`}>{tag}</span> : null}
              {tag ? ' · ' : ''}
              {group === 'references' ? item.kind : null}
              {group === 'references' && item.via ? ' · ' : ''}
              {item.via ? VIA_WORD[item.via] ?? item.via : null}
            </span>
            {item.text ? (
              <span className="lsel__text">
                {item.derived ? <span className="lsel__derived">derived</span> : null}
                {item.text}
              </span>
            ) : null}
          </span>
          <span className={`ls__check ${on ? 'ls__check--on' : 'ls__check--off'}`} aria-hidden="true">
            {on ? '✓' : ''}
          </span>
        </button>
        {refused ? <span className="ls__rowsub ls__rowsub--bad" role="alert">{refused}</span> : null}
      </div>
    );
  };

  return (
    <section className="ls__section lsel" data-testid={`lsel-group-${group}`} aria-label={label}>
      <div className="lsel__head">
        <span className="ls__eyebrow">{label.toUpperCase()}</span>
        {diff.line ? <span className="lsel__diff" data-testid={`lsel-diff-${group}`}>{diff.line}</span> : null}
      </div>
      {lock ? <p className="ls__profile-empty" role="status">{lock}</p> : null}
      {defaults.status === 'ready' && defaultRows.length === 0 && addedRows.length === 0 ? (
        <p className="ls__profile-empty" role="status">
          No default {label.toLowerCase()} for this launch.
        </p>
      ) : null}
      <div className="ls__picker" role="group" aria-label={`${label} this launch carries`}>
        {defaultRows.map((item) => row(item, 'default'))}
        {addedRows.map((item) => row(item, 'added'))}
      </div>
      {!lock ? (
        <button
          type="button"
          className="ls__change lsel__add"
          aria-expanded={open}
          aria-controls={pickerId}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? `done adding ${label.toLowerCase()} ▴` : `＋ add ${label.toLowerCase()} ▾`}
        </button>
      ) : null}
      {open && !lock ? (
        <div id={pickerId} className="ls__picker lsel__pool" role="group" aria-label={`${label} to add`}>
          {candidates === undefined ? (
            <p className="ls__profile-empty" role="status">
              {label} have not been read into this client, so none can be offered. This is unknown, not empty.
            </p>
          ) : pool.length === 0 ? (
            <p className="ls__profile-empty" role="status">Nothing else in this space to add.</p>
          ) : (
            <>
              {pool.length > FILTER_FROM ? (
                <input
                  className="ls__search"
                  type="search"
                  placeholder={`Filter ${label.toLowerCase()}…`}
                  aria-label={`Filter ${label.toLowerCase()} to add`}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              ) : null}
              {shown.map((item) => row(item, 'pool'))}
              {shown.length === 0 ? (
                <p className="ls__profile-empty" role="status">Nothing matches “{query.trim()}”.</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
