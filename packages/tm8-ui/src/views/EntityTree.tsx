/**
 * EntityTree — the WIDE middle list of an EntityView (D65): a separate
 * generic component, NOT the side EntityListPanel stretched (user ruling
 * 2026-07-29). One component, every kind, registry-configured.
 *
 * Geometry is T0-3's tree spec, extracted not eyeballed (canvas-T0-3.md):
 * indent 17px/level with guide hairlines at 7px + 17px·depth in --pn-line-2;
 * carets ▾/▸ 9px --pn-ink-3 in a 10px column (leaves hold the column with an
 * empty spacer); status dots encode state in GEOMETRY (solid=alive/done,
 * hollow ring=open/exited, pulsing=streaming/live, amber ring=stale); parent
 * titles 12.5px/500, children 12px regular; metas mono 9.5px.
 *
 * LIVENESS IS NEVER DERIVED HERE: session rows show the seam VERDICT passed
 * in via `livenessOf` — the record's status word never upgrades a dead
 * session to alive (two-source honesty).
 *
 * The tree is built from the flat query rows by parentId; a row whose parent
 * is not in the current tier's result set roots itself (an orphan is shown,
 * never silently dropped).
 *
 * DEFAULT COLLAPSED (user ruling 2026-08-17), reversing the original "the
 * canvas draws the coordinator tree open; collapsing is the gesture". Opening
 * is the gesture now, and it is REMEMBERED — see `kit/useTreeDisclosure`. The
 * canvas reference was drawn against a handful of demo rows; against a real
 * workspace the same rule paints the entire hierarchy on arrival, which is the
 * wall the ruling is about. The selection is still always on screen: its
 * ancestors read as open without being recorded as gestures.
 */
import { useMemo, useState } from 'react';
import type { EntitySummary } from '@tm8/contract';
import { ancestorPath, useTreeDisclosure } from '../kit';
import { KindIcon } from '../domain/KindIcon';
import { getKind } from '../domain/registry';
import type { QueryFilter } from '../domain/types';
import type { SessionLiveness } from '../data/seam';
import './entity-tree.css';

export interface EntityTreeProps {
  kind: string;
  rowsFor: (filter: QueryFilter | undefined) => readonly EntitySummary[];
  livenessOf: (id: string) => SessionLiveness;
  /** Pool activity (streaming) by id — gated on the verdict, per the law. */
  activity: Readonly<Record<string, boolean>>;
  selectedId: string | null;
  onSelect(id: string): void;
  /** Authoring 7a: the host's REAL create control, rendered in the head band. */
  createSlot?: React.ReactNode;
}

interface TreeNode {
  row: EntitySummary;
  children: TreeNode[];
  depth: number;
}

function buildTree(rows: readonly EntitySummary[]): TreeNode[] {
  const present = new Set(rows.map((r) => r.id));
  const byParent = new Map<string | null, EntitySummary[]>();
  for (const row of rows) {
    const key = row.parentId && present.has(row.parentId) ? row.parentId : null;
    const bucket = byParent.get(key);
    if (bucket) bucket.push(row);
    else byParent.set(key, [row]);
  }
  const attach = (parentKey: string | null, depth: number): TreeNode[] =>
    (byParent.get(parentKey) ?? []).map((row) => ({
      row,
      depth,
      children: attach(row.id, depth + 1),
    }));
  return attach(null, 0);
}

/**
 * The state facts for a row: the word (mono, never color alone) and the dot's
 * geometry class. Reads the SUMMARY's state union by its own discriminant —
 * presentation, not kind-branching: adding a kind with one of these state
 * shapes needs no edit here, which is the §15.2 test that matters.
 */
function stateFacts(
  row: EntitySummary,
  liveness: SessionLiveness,
  streaming: boolean,
): { word: string; dot: string } {
  const s = row.state;
  if (s.kind === 'work_session') {
    // VERDICT outranks record: the record's word renders only when the
    // verdict agrees something is running; otherwise the verdict's word is
    // the row's truth.
    if (liveness === 'live') {
      return { word: streaming ? 'streaming' : s.status, dot: streaming ? 'dot--pulse' : 'dot--solid-run' };
    }
    if (liveness === 'stale') return { word: 'stale', dot: 'dot--ring-wait' };
    if (liveness === 'unknown') return { word: 'unverified', dot: 'dot--ring-wait' };
    return { word: 'not running', dot: 'dot--ring-idle' };
  }
  if (s.kind === 'task') {
    if (s.workStatus === 'done') return { word: 'done', dot: 'dot--solid-run' };
    if (s.workStatus === 'blocked') return { word: 'blocked', dot: 'dot--solid-block' };
    if (s.workStatus === 'working') return { word: 'working', dot: 'dot--ring-run' };
    return { word: s.workStatus, dot: 'dot--ring-idle' };
  }
  return { word: '', dot: 'dot--ring-idle' };
}

function priorityFor(row: EntitySummary): string | null {
  return row.state.kind === 'task' ? row.state.priority : null;
}

const relative = (iso: string): string => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
};

export function EntityTree(props: EntityTreeProps) {
  const { kind, rowsFor, selectedId } = props;
  const config = getKind(kind);
  const tiers = config.list.lifecycle ?? null;
  const [tierId, setTierId] = useState<string>(tiers?.[0]?.id ?? 'open');

  const activeTier = tiers?.find((t) => t.id === tierId) ?? tiers?.[0] ?? null;
  const rows = rowsFor(activeTier?.filter ?? { deleted: 'exclude' });
  const roots = useMemo(() => buildTree(rows), [rows]);

  // The EXPANDED set — the viewer's own gestures, persisted per kind. It was a
  // `collapsed` set starting empty, which is default-open for every row that
  // exists now and every row that arrives later. The tier is not part of the
  // scope on purpose: the same subtree opened under `open` should still be open
  // when it moves to `done`.
  const revealed = useMemo(() => ancestorPath(rows, selectedId), [rows, selectedId]);
  const disclosure = useTreeDisclosure(`tree:${kind}`, revealed);

  const renderNode = (node: TreeNode): React.ReactNode => {
    const { row, children, depth } = node;
    const isCollapsed = !disclosure.isExpanded(row.id);
    const facts = stateFacts(row, props.livenessOf(row.id), props.activity[row.id] ?? false);
    const priority = priorityFor(row);
    return (
      <li
        key={row.id}
        className="evt-node"
        role="treeitem"
        aria-expanded={children.length > 0 ? !isCollapsed : undefined}
        aria-selected={row.id === selectedId}
      >
        <div
          className={row.id === selectedId ? 'evt-row evt-row--selected' : 'evt-row'}
          data-depth={depth}
          onClick={() => props.onSelect(row.id)}
        >
          {children.length > 0 ? (
            <button
              type="button"
              className="evt-caret"
              aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${row.title}, ${children.length} ${children.length === 1 ? 'child' : 'children'}`}
              aria-expanded={!isCollapsed}
              onClick={(e) => {
                e.stopPropagation();
                disclosure.toggle(row.id);
              }}
            >
              {isCollapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span className="evt-caret evt-caret--leaf" aria-hidden>
              ›
            </span>
          )}

          <span className={`evt-status evt-status--${facts.dot.replace('dot--', '')}`} aria-hidden>
            <span className={`evt-dot ${facts.dot}`} />
          </span>

          <span className="evt-copy">
            <span className="evt-copy__top">
              <button
                type="button"
                className={depth === 0 ? 'evt-title' : 'evt-title evt-title--child'}
                title={row.title}
                aria-current={row.id === selectedId ? 'true' : undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onSelect(row.id);
                }}
              >
                {row.title}
              </button>
              {priority ? (
                <span className={`evt-priority evt-priority--${priority}`}>{priority.toUpperCase()}</span>
              ) : null}
            </span>
            <span className="evt-copy__meta">
              {facts.word ? <span className="evt-word">{facts.word}</span> : null}
              {facts.word ? <span aria-hidden>·</span> : null}
              <span className="evt-when">{relative(row.activityAt)}</span>
            </span>
          </span>
        </div>
        {children.length > 0 && !isCollapsed ? (
          <ul className="evt-children" role="group">
            {children.map(renderNode)}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className="evt-root" data-testid="entity-tree" data-kind={kind}>
      <div className="evt-head">
        <span className="evt-head__glyph" aria-hidden>
          <KindIcon kind={config.kind} />
        </span>
        <span className="evt-head__label">{config.labelPlural}</span>
        <span className="evt-head__count">{rows.length}</span>
        <span className="evt-spacer" />
        {props.createSlot}
      </div>

      {tiers ? (
        <div className="evt-tabs" role="tablist" aria-label="Lifecycle">
          {tiers.map((tier) => {
            const count = rowsFor(tier.filter).length;
            const active = tier.id === (activeTier?.id ?? '');
            return (
              <button
                key={tier.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={active ? 'evt-tab evt-tab--active' : 'evt-tab'}
                onClick={() => setTierId(tier.id)}
              >
                {tier.label} <span className="evt-tab__n">{count}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="evt-scroll">
        {roots.length === 0 ? (
          <p className="evt-empty">
            {`No ${config.labelPlural.toLowerCase()} here${activeTier ? ` in ${activeTier.label.toLowerCase()}` : ''}.`}
          </p>
        ) : (
          <ul className="evt-tree" role="tree">
            {roots.map(renderNode)}
          </ul>
        )}
      </div>
    </div>
  );
}
