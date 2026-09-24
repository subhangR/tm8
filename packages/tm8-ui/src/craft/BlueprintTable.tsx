/**
 * TABLE — every node of the blueprint as a row: kind, title, existence,
 * status, stage, who, what it needs and makes, and whether anything is wrong.
 *
 * A real `<table>` with headers, so a screen reader can walk it by column;
 * each title is a button on the studio's one selection. Stage is the flow
 * rank + 1 — the same column the Flow view places the card in.
 */
import type { BlueprintView } from './blueprint-types';
import { humanStatus, statusTone } from './presentation';
import { titleOf } from './canvas-nav';

export interface BlueprintTableProps {
  view: BlueprintView;
  selectedKey: string | null;
  onSelect(key: string | null): void;
  onActivate?: ((key: string) => void) | undefined;
  marked?: ReadonlySet<string> | undefined;
}

export function BlueprintTable({ view, selectedKey, onSelect, onActivate, marked }: BlueprintTableProps) {
  const rows = [...view.lists.rows].sort((a, b) => (a.rank - b.rank) || a.title.localeCompare(b.title));
  const names = (keys: readonly string[]) => keys.map((key) => titleOf(view, key)).join(', ');
  const live = new Set(view.cards.filter((card) => card.live).map((card) => card.key));
  return (
    <div className="crf-table-wrap" data-testid="crf-table">
      <table className="crf-table">
        <caption className="crf-sr">Every node in the blueprint, in flow order</caption>
        <thead>
          <tr>
            <th scope="col">Stage</th>
            <th scope="col">Kind</th>
            <th scope="col">Title</th>
            <th scope="col">State</th>
            <th scope="col">Assigned</th>
            <th scope="col">Needs</th>
            <th scope="col">Makes</th>
            <th scope="col">Issues</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              data-selected={selectedKey === row.key || undefined}
              data-marked={marked?.has(row.key) || undefined}
            >
              <td className="crf-table__num">{row.rank >= 0 ? row.rank + 1 : '—'}</td>
              <td>{row.kindLabel}</td>
              <th scope="row">
                <button
                  type="button"
                  className="crf-table__title"
                  aria-pressed={selectedKey === row.key}
                  onClick={() => onSelect(row.key)}
                  onDoubleClick={() => onActivate?.(row.key)}
                >
                  {row.title}
                </button>
              </th>
              <td>
                <span className="crf-ol__tag" data-built={row.materialized || undefined}>
                  {row.isSpec ? 'spec' : row.materialized ? 'built' : 'exists'}
                </span>
                {row.status || live.has(row.key) ? (
                  <span className="crf-ol__status" data-tone={statusTone(row.status, live.has(row.key))}>
                    {live.has(row.key) ? 'running' : humanStatus(row.status)}
                  </span>
                ) : null}
              </td>
              <td>{names(row.assignees)}</td>
              <td>{names([...row.consumes, ...row.dependsOn])}</td>
              <td>{names([...row.produces, ...row.blocks])}</td>
              <td>
                {row.severity ? (
                  <span className="crf-ol__issue" data-severity={row.severity}>{row.severity}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
