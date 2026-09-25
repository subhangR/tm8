import { useId, useState, type ReactNode } from 'react';
import type { ContextBudgets, RankedEntityReason, SpawnSelectionGroup } from '@tm8/contract';

import {
  groupIds,
  isTicked,
  LAUNCH_GROUP_LABEL,
  LAUNCH_SELECTION_GROUPS,
  type LaunchContextRow,
} from '../domain/launch-selection';
import { BudgetMeter } from '../jev';
import { groupMeter, REASON_WORDS, type GroupMeterFacts, type LaunchRanked } from './meter';
import type { LaunchSelection, LoadLaunchDefaults } from './useLaunchSelection';

/** What a surface knows about the launch's prompt bytes, for the per-group meter (I7). All optional: absent, the meter falls back to `launch.defaults`, then to counts. */
export interface LaunchSelectionBudgetProps {
  /** Jev's ok answer per group: rows' `promptBytes`, the group's budget. */
  ranked?: LaunchRanked;
  /** The latest answer's context index, else `launch.defaults'`. */
  contextIndex?: 'on' | 'off' | null;
  /** The per-launch override (`BudgetOverride`), which replaces the budget it names. */
  budgets?: ContextBudgets;
  /** Why a default a person's Jev Apply removed is out (`appliedReasons`). */
  reasons?: Partial<Record<SpawnSelectionGroup, Readonly<Record<string, RankedEntityReason>>>>;
}

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
  collapsed = false,
  extra,
  ranked,
  contextIndex,
  budgets,
  reasons,
}: LaunchSelectionBudgetProps & {
  selection: LaunchSelection;
  /** Which groups this surface edits here — in Jev mode the sheet shows Jev's checklists for memories and skills. */
  groups: readonly SpawnSelectionGroup[];
  candidates: LaunchSelectionCandidates;
  /**
   * The sheet's form (owner's pick, I9b form 2026-09-25): each group is ONE
   * summary line — "MEMORIES  3 defaults · −1 removed ▾" — that expands to its
   * rows. Most launches are untouched, and the line already says so.
   */
  collapsed?: boolean;
  /** Rendered at the foot of a group's expanded body (the Skills group's "How these load"). */
  extra?: Partial<Record<SpawnSelectionGroup, ReactNode>>;
}) {
  return (
    <>
      {groups.map((group) => (
        <SelectionGroup
          key={group}
          group={group}
          selection={selection}
          candidates={candidates[group]}
          collapsed={collapsed}
          extra={extra?.[group]}
          meter={groupMeter(selection, group, ranked?.[group], contextIndex ?? selection.contextIndex, budgets)}
          reasons={reasons?.[group] ?? {}}
        />
      ))}
      {selection.warnings.map((warning) => (
        <p key={warning} className="ls__profile-empty" role="status">{warning}</p>
      ))}
    </>
  );
}

/** The summary line's words: how many the launch carries, then the diff. */
export function groupSummary(selection: LaunchSelection, group: SpawnSelectionGroup): string {
  const defaults = selection.defaults[group];
  if (defaults.status === 'loading') return 'reading defaults…';
  if (defaults.status === 'unknown') return 'defaults unknown — can’t be edited';
  const n = defaults.total;
  const head = n === 0 ? 'no defaults' : `${String(n)} default${n === 1 ? '' : 's'}`;
  const lock = selection.lock(group);
  if (lock) return `${head} · over the ceiling — can’t be edited`;
  const line = selection.diff(group).line;
  return line ? `${head} · ${line}` : head;
}

function SelectionGroup({
  group,
  selection,
  candidates,
  collapsed,
  extra,
  meter,
  reasons,
}: {
  group: SpawnSelectionGroup;
  selection: LaunchSelection;
  candidates: readonly LaunchContextRow[] | undefined;
  collapsed: boolean;
  extra: ReactNode;
  meter: GroupMeterFacts | null;
  reasons: Readonly<Record<string, RankedEntityReason>>;
}) {
  const pickerId = `lsel-${group}-${useId()}`;
  const bodyId = `lsel-body-${group}-${useId()}`;
  const [expanded, setExpanded] = useState(!collapsed);
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
    const why = removed ? reasons[item.id] : undefined;
    const tag = where === 'default'
      ? (removed ? `default · removed${why ? ` · ${REASON_WORDS[why]}` : ''}` : 'default')
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
      {collapsed ? (
        <button
          type="button"
          className={`lsel__head lsel__head--toggle ${diff.line ? 'lsel__head--edited' : ''}`}
          aria-expanded={expanded}
          aria-controls={bodyId}
          data-testid={`lsel-toggle-${group}`}
          onClick={() => setExpanded((e) => !e)}
        >
          <span className="ls__eyebrow">{label.toUpperCase()}</span>
          <span className="lsel__summary">{groupSummary(selection, group)}</span>
          <span className="lsel__caret" aria-hidden="true">{expanded ? '▴' : '▾'}</span>
        </button>
      ) : (
        <div className="lsel__head">
          <span className="ls__eyebrow">{label.toUpperCase()}</span>
          {diff.line ? <span className="lsel__diff" data-testid={`lsel-diff-${group}`}>{diff.line}</span> : null}
        </div>
      )}
      {meter ? <GroupMeter group={group} facts={meter} /> : null}
      {expanded ? (
      <div id={bodyId} className="lsel__body">
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
      {extra}
      </div>
      ) : null}
    </section>
  );
}

/**
 * One group's meter: lane B's `BudgetMeter`, fed what THIS launch carries.
 * Unknown bytes reach it as null, and it shows the count only. When nobody
 * said what the group's budget is (a node before `launch.defaults` carried
 * it, and no Jev answer), a plain count line — the meter's null budget means
 * "takes what the prompt has left", which would be a claim nobody made.
 */
function GroupMeter({ group, facts }: { group: SpawnSelectionGroup; facts: GroupMeterFacts }) {
  if (facts.budget === undefined) {
    const noun = facts.count === 1 ? LAUNCH_ONE[group] : LAUNCH_GROUP_LABEL[group].toLowerCase();
    return (
      <p className="lsel__meter lsel__meter--count" data-testid={`lsel-meter-${group}`} data-meter="count">
        {String(facts.count)} {noun} · prompt bytes not known here
      </p>
    );
  }
  return (
    <div className="lsel__meter" data-testid={`lsel-meter-${group}`} data-budget-source={facts.budgetSource ?? undefined}>
      <BudgetMeter group={group} usedBytes={facts.usedBytes} budget={facts.budget} count={facts.count} contextIndex={facts.contextIndex} compact />
    </div>
  );
}

const LAUNCH_ONE: Record<SpawnSelectionGroup, string> = { memories: 'memory', skills: 'skill', references: 'reference' };

/** What a launch surface needs to offer the groups: the defaults read and the add pools. */
export interface LaunchSelectionSources {
  load?: LoadLaunchDefaults;
  candidates: LaunchSelectionCandidates;
}

const CHIP_NOUN: Record<SpawnSelectionGroup, [string, string]> = {
  memories: ['memory', 'memories'],
  skills: ['skill', 'skills'],
  references: ['ref', 'refs'],
};

/** A chip's words: how many the launch will carry for that group. */
function chipLabel(selection: LaunchSelection, group: SpawnSelectionGroup): string {
  const defaults = selection.defaults[group];
  const [one, many] = CHIP_NOUN[group];
  if (defaults.status === 'loading') return `… ${many}`;
  if (defaults.status === 'unknown') return `? ${many}`;
  const n = selection.lock(group) ? defaults.total : groupIds(defaults, selection.edits[group]).length;
  return `${String(n)} ${n === 1 ? one : many}`;
}

/**
 * The Run composer's compact form (owner's pick, I9b form 2026-09-25): three
 * count chips — ◈ 3 memories · ✧ 4 skills · ▤ 2 refs. A chip turns amber when
 * its group was edited, and opens that group in a popover beneath the row.
 *
 * `governed` names groups another source decides (Ask Jev's ticks in Jev
 * mode): their chip says so and does not open, since the popup's own edits
 * would not be sent.
 */
export function LaunchSelectionChips({
  selection,
  candidates,
  governed = [],
  governedNote = 'Jev’s ticks are this set — review them in ✦ Review.',
  ...budget
}: LaunchSelectionBudgetProps & {
  selection: LaunchSelection;
  candidates: LaunchSelectionCandidates;
  governed?: readonly SpawnSelectionGroup[];
  governedNote?: string;
}) {
  const [open, setOpen] = useState<SpawnSelectionGroup | null>(null);
  const popoverId = `lsel-pop-${useId()}`;
  return (
    <div className="lsel-chips" data-testid="launch-selection-chips">
      <div className="lsel-chips__row" role="group" aria-label="Launch context">
        {LAUNCH_SELECTION_GROUPS.map((group) => {
          const isGoverned = governed.includes(group);
          const edited = !isGoverned && selection.diff(group).line !== null;
          const label = isGoverned ? `✦ Jev’s ${CHIP_NOUN[group][1]}` : chipLabel(selection, group);
          return (
            <button
              key={group}
              type="button"
              className={`lsel-chip ${edited ? 'lsel-chip--edited' : ''} ${open === group ? 'lsel-chip--open' : ''}`}
              data-testid={`lsel-chip-${group}`}
              aria-expanded={isGoverned ? undefined : open === group}
              aria-controls={isGoverned ? undefined : popoverId}
              aria-disabled={isGoverned || undefined}
              title={isGoverned ? governedNote : edited ? `${LAUNCH_GROUP_LABEL[group]}: ${selection.diff(group).line ?? ''}` : `${LAUNCH_GROUP_LABEL[group]}: the launch’s defaults`}
              onClick={(event) => {
                if (isGoverned) return event.preventDefault();
                setOpen((current) => (current === group ? null : group));
              }}
            >
              <span aria-hidden="true">{GLYPH[group]}</span> {label}
              {edited ? <span className="lsel-chip__dot" aria-label="edited" /> : null}
            </button>
          );
        })}
      </div>
      {open && !governed.includes(open) ? (
        <div
          id={popoverId}
          className="lsel-popover"
          role="dialog"
          aria-label={`${LAUNCH_GROUP_LABEL[open]} for this launch`}
          data-testid="lsel-popover"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(null);
            }
          }}
        >
          <button type="button" className="lsel-popover__close" aria-label="Close" onClick={() => setOpen(null)}>✕</button>
          <LaunchSelectionGroups selection={selection} groups={[open]} candidates={candidates} {...budget} />
        </div>
      ) : null}
    </div>
  );
}
