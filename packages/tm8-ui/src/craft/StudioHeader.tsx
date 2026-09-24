/**
 * THE STUDIO HEADER — one row for the whole studio, replacing the two pane
 * headers that each carried an unrelated picker and a ＋.
 *
 *   [‹›] Blueprint ▾ › Conversation ▾      Flow│Lanes│Outline│Table   ⚠ 3   [Orchestrate ▸]
 *
 * It reads left to right as the hierarchy it is: WHICH plan, which
 * conversation about it, how to look at it, and the one committing verb.
 * Orchestrate is the studio's primary action and opens a PRE-FLIGHT: the
 * coherence findings, errors first. Errors block the approval (the agent
 * would materialize a plan the checker already knows is broken); warnings
 * are shown and can be accepted.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { CoherenceFinding, EntityId, EntitySummary } from '@tm8/contract';
import { FindingRow } from './NodeInspector';
import type { CraftViewId, CraftViewOption } from './presentation';

/** Dismiss a popover on an outside press or Escape (captured, so it wins over outer rungs). */
function useDismiss(open: boolean, close: () => void, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, close, ref]);
}

export interface GraphPickerProps {
  graphs: readonly EntitySummary[];
  selectedId: EntityId | null;
  onSelect(id: EntityId): void;
  onCreate(): void;
}

export function GraphPicker({ graphs, selectedId, onSelect, onCreate }: GraphPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);
  const findRef = useRef<HTMLInputElement | null>(null);
  useDismiss(open, () => setOpen(false), ref);
  useEffect(() => {
    if (open) findRef.current?.focus();
    else setQuery('');
  }, [open]);
  const current = graphs.find((graph) => graph.id === selectedId) ?? null;
  const listed = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? graphs.filter((graph) => graph.title.toLowerCase().includes(q)) : graphs;
  }, [graphs, query]);

  return (
    <div className="crf-crumb crf-crumb--graph" ref={ref}>
      <button
        type="button"
        className="crf-pick crf-pick--graph"
        data-testid="crf-picker"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Blueprint: ${current?.title ?? 'none selected'}`}
        onClick={() => setOpen((was) => !was)}
      >
        <svg className="crf-pick__mark" width={14} height={14} viewBox="0 0 14 14" aria-hidden>
          <rect x={1} y={1.5} width={5} height={4} rx={1} />
          <rect x={8} y={8.5} width={5} height={4} rx={1} />
          <path d="M3.5 5.5 V10.5 H8" />
        </svg>
        <span className="crf-pick__title">{current?.title ?? (graphs.length === 0 ? 'No blueprints yet' : 'Choose a blueprint')}</span>
        <span className="crf-pick__caret" aria-hidden>▾</span>
      </button>
      {open ? (
        <div className="crf-pop crf-pop--graph" role="dialog" aria-label="Blueprints" data-testid="crf-graph-pop">
          <input
            ref={findRef}
            type="search"
            className="crf-pop__find"
            placeholder="Find a blueprint…"
            aria-label="Find a blueprint"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="crf-pop__list">
            <button
              type="button"
              className="crf-pop__row crf-pop__row--new"
              data-testid="crf-new"
              onClick={() => {
                setOpen(false);
                onCreate();
              }}
            >
              <span className="crf-pop__row-title">＋ New blueprint</span>
            </button>
            {listed.length === 0 && graphs.length > 0 ? (
              <p className="crf-pop__hollow">No blueprint matches.</p>
            ) : null}
            {listed.map((graph) => (
              <button
                type="button"
                key={graph.id}
                className="crf-pop__row"
                data-testid="crf-graph-row"
                data-active={graph.id === selectedId || undefined}
                onClick={() => {
                  setOpen(false);
                  onSelect(graph.id as EntityId);
                }}
              >
                <span className="crf-pop__row-title">{graph.title}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ViewSwitcher({
  options,
  value,
  onChange,
}: {
  options: readonly CraftViewOption[];
  value: CraftViewId;
  onChange(id: CraftViewId): void;
}) {
  if (options.length <= 1) return null;
  return (
    <div className="crf-views" role="radiogroup" aria-label="Blueprint view" data-testid="crf-views">
      {options.map((option) => (
        <button
          type="button"
          key={option.id}
          role="radio"
          aria-checked={value === option.id}
          className="crf-views__opt"
          data-testid={`crf-view-${option.id}`}
          title={option.hint}
          onClick={() => onChange(option.id)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
            event.preventDefault();
            const at = options.findIndex((o) => o.id === value);
            const next = options[(at + (event.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length]!;
            onChange(next.id);
            (event.currentTarget.parentElement?.querySelector(`[data-testid="crf-view-${next.id}"]`) as HTMLElement | null)?.focus();
          }}
          tabIndex={value === option.id ? 0 : -1}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface OrchestrateProps {
  findings: readonly CoherenceFinding[];
  /** What would be created: spec counts by kind label, e.g. [['Tasks', 5], ['Docs', 2]]. */
  plan: readonly (readonly [string, number])[];
  disabledReason: string | null;
  approving: boolean;
  onApprove(): void;
  onShowNode(key: string): void;
}

export function OrchestrateButton({ findings, plan, disabledReason, approving, onApprove, onShowNode }: OrchestrateProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(open, () => setOpen(false), ref);
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const infos = findings.filter((f) => f.severity === 'info');
  const blocked = errors.length > 0;
  return (
    <div className="crf-crumb crf-crumb--orch" ref={ref}>
      <button
        type="button"
        className="crf-orchestrate"
        data-testid="crf-orchestrate"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabledReason !== null || approving}
        title={disabledReason ?? 'Check the plan, then post the approval into the craft thread'}
        onClick={() => setOpen((was) => !was)}
      >
        {approving ? 'Posting…' : 'Orchestrate'}
        <span aria-hidden> ▸</span>
      </button>
      {open ? (
        <div className="crf-pop crf-pop--preflight" role="dialog" aria-label="Orchestrate pre-flight" data-testid="crf-preflight">
          <div className="crf-pre__head">
            <strong>Pre-flight</strong>
            <span className="crf-pre__sum">
              {plan.length > 0 ? `Will create ${plan.map(([label, n]) => `${n} ${label.toLowerCase()}`).join(', ')}` : 'Nothing new to create — every node already exists.'}
            </span>
          </div>
          <div className="crf-pop__list">
            {findings.length === 0 ? (
              <p className="crf-pre__ok" data-testid="crf-preflight-clean">No issues found. The plan is coherent.</p>
            ) : (
              <>
                <FindingGroup title="Errors — fix before orchestrating" findings={errors} onShow={(key) => { setOpen(false); onShowNode(key); }} />
                <FindingGroup title="Warnings" findings={warnings} onShow={(key) => { setOpen(false); onShowNode(key); }} />
                <FindingGroup title="Notes" findings={infos} onShow={(key) => { setOpen(false); onShowNode(key); }} />
              </>
            )}
          </div>
          <div className="crf-pre__foot">
            <span className="crf-pre__why">
              {blocked
                ? 'Errors block orchestration. Ask the chat to fix them.'
                : 'Posts your approval into the craft thread; the agent creates the plan from there.'}
            </span>
            <button
              type="button"
              className="crf-btn crf-btn--primary"
              data-testid="crf-approve"
              disabled={blocked || approving}
              onClick={() => {
                setOpen(false);
                onApprove();
              }}
            >
              {warnings.length > 0 ? 'Orchestrate anyway' : 'Orchestrate'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FindingGroup({
  title,
  findings,
  onShow,
}: {
  title: string;
  findings: readonly CoherenceFinding[];
  onShow(key: string): void;
}) {
  if (findings.length === 0) return null;
  return (
    <section className="crf-pre__group" aria-label={title}>
      <h4 className="crf-pre__h">{`${title} (${findings.length})`}</h4>
      <ul className="crf-findings">
        {findings.map((finding, index) => <FindingRow key={`${finding.code}:${index}`} finding={finding} onSelect={onShow} />)}
      </ul>
    </section>
  );
}

/** The findings count chip: worst severity colours it; the words say how many of each. */
export function FindingsChip({
  findings,
  onClick,
}: {
  findings: readonly CoherenceFinding[];
  onClick?: () => void;
}): ReactNode {
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  if (errors + warnings === 0) return null;
  const worst = errors > 0 ? 'error' : 'warning';
  const words = [errors ? `${errors} error${errors === 1 ? '' : 's'}` : '', warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : '']
    .filter(Boolean).join(', ');
  return (
    <button type="button" className="crf-issues" data-severity={worst} data-testid="crf-issues" title={words} aria-label={words} onClick={onClick}>
      <span aria-hidden>!</span>
      {errors + warnings}
    </button>
  );
}
