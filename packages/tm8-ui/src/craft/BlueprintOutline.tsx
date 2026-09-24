/**
 * OUTLINE — the blueprint as text: each teammate, the tasks they own in flow
 * order, and for every task what it NEEDS and what it MAKES.
 *
 * It is a VIEW and the ACCESSIBLE FALLBACK for the canvas at once, so it is
 * built from real list and button semantics: every node is a button that
 * shares the studio's one selection (select here, the canvas and inspector
 * follow), groups collapse with `aria-expanded`, and ↑/↓ walk the rows.
 *
 * Built from `view.lists` (layout-independent) — never from coordinates.
 */
import { useMemo, useState, type KeyboardEvent } from 'react';
import type { BlueprintRow, BlueprintView } from './blueprint-types';
import { humanStatus, statusTone } from './presentation';
import { titleOf } from './canvas-nav';

export interface BlueprintOutlineProps {
  view: BlueprintView;
  selectedKey: string | null;
  onSelect(key: string | null): void;
  onActivate?: ((key: string) => void) | undefined;
  marked?: ReadonlySet<string> | undefined;
}

export function BlueprintOutline({ view, selectedKey, onSelect, onActivate, marked }: BlueprintOutlineProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => new Map(view.lists.rows.map((row) => [row.key, row])), [view]);
  const cardOf = useMemo(() => new Map(view.cards.map((card) => [card.key, card])), [view]);

  /* Everything that is not a task hangs off the tasks that touch it; nodes no
     task touches (an orphan doc, a floating memory) get their own group, so
     the outline never silently drops part of the plan. */
  const touched = new Set<string>();
  view.lists.byAssignee.forEach((group) => group.tasks.forEach((key) => {
    touched.add(key);
    const row = rows.get(key);
    row?.consumes.forEach((k) => touched.add(k));
    row?.produces.forEach((k) => touched.add(k));
  }));
  const loose = view.lists.rows.filter((row) => !touched.has(row.key));

  const toggle = (id: string) => setCollapsed((was) => {
    const next = new Set(was);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-outline-item]')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  const nodeButton = (key: string, extra?: string) => {
    const row = rows.get(key);
    const card = cardOf.get(key);
    const tone = statusTone(row?.status ?? null, card?.live ?? false);
    return (
      <button
        type="button"
        data-outline-item
        className="crf-ol__node"
        data-kind={row?.kind ?? 'entity'}
        data-selected={selectedKey === key || undefined}
        data-marked={marked?.has(key) || undefined}
        aria-pressed={selectedKey === key}
        onClick={() => onSelect(key)}
        onDoubleClick={() => onActivate?.(key)}
      >
        <span className="crf-ol__kind">{row?.kindLabel ?? 'Node'}</span>
        <span className="crf-ol__title">{row?.title ?? titleOf(view, key)}</span>
        {row?.isSpec ? <span className="crf-ol__tag">spec</span> : row?.materialized ? <span className="crf-ol__tag crf-ol__tag--built">built</span> : null}
        {row?.status || card?.live ? (
          <span className="crf-ol__status" data-tone={tone}>{card?.live ? 'running' : humanStatus(row?.status ?? null)}</span>
        ) : null}
        {row?.severity ? <span className="crf-ol__issue" data-severity={row.severity} aria-label={`${row.severity}`}>!</span> : null}
        {extra ? <span className="crf-ol__extra">{extra}</span> : null}
      </button>
    );
  };

  const links = (label: string, keys: readonly string[]) => keys.length === 0 ? null : (
    <li className="crf-ol__links">
      <span className="crf-ol__rel">{label}</span>
      <ul className="crf-ol__linklist">
        {keys.map((key) => <li key={key}>{nodeButton(key)}</li>)}
      </ul>
    </li>
  );

  const task = (row: BlueprintRow) => (
    <li key={row.key} className="crf-ol__task">
      {nodeButton(row.key)}
      <ul className="crf-ol__rels">
        {links('Needs', row.consumes)}
        {links('After', row.dependsOn)}
        {links('Makes', row.produces)}
        {links('Unblocks', row.blocks)}
      </ul>
    </li>
  );

  return (
    <div className="crf-ol" data-testid="crf-outline" onKeyDown={onKeyDown}>
      {view.lists.byAssignee.map((group) => {
        const id = group.assignee?.key ?? '∅';
        const open = !collapsed.has(id);
        const headId = `crf-ol-${id}`;
        return (
          <section key={id} className="crf-ol__group" aria-labelledby={headId}>
            <h3 className="crf-ol__head" id={headId}>
              <button
                type="button"
                className="crf-ol__toggle"
                aria-expanded={open}
                data-outline-item
                onClick={() => toggle(id)}
              >
                <span className="crf-ol__caret" aria-hidden>{open ? '▾' : '▸'}</span>
                <span>{group.assignee ? group.assignee.title : 'Unassigned'}</span>
                <span className="crf-ol__count">{`${group.tasks.length} ${group.tasks.length === 1 ? 'task' : 'tasks'}`}</span>
              </button>
              {group.assignee ? (
                <button
                  type="button"
                  className="crf-ol__who"
                  data-outline-item
                  aria-pressed={selectedKey === group.assignee.key}
                  onClick={() => onSelect(group.assignee!.key)}
                >
                  Inspect
                </button>
              ) : null}
            </h3>
            {open ? (
              <ul className="crf-ol__tasks">
                {group.tasks.map((key) => rows.get(key)).filter((row): row is BlueprintRow => !!row).map(task)}
              </ul>
            ) : null}
          </section>
        );
      })}
      {loose.length > 0 ? (
        <section className="crf-ol__group" aria-label="Not connected to a task">
          <h3 className="crf-ol__head crf-ol__head--plain">Not connected to a task</h3>
          <ul className="crf-ol__tasks">
            {loose.map((row) => <li key={row.key} className="crf-ol__task">{nodeButton(row.key)}</li>)}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
