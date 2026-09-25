import { forwardRef, useState } from 'react';
import type { RankedEntity, RankedEntityHeader } from '@tm8/contract';

import { BudgetMeter, formatBytes } from './BudgetMeter';
import { SOURCE_WORDS } from './format';
import { JevCostLine } from './JevCostLine';
import { JevGroupStatus } from './JevGroupStatus';
import {
  JEV_ENTITY_GROUPS,
  type JevApplyTarget,
  type JevEntityGroup,
  type JevEntityGroupView,
  type JevGroupState,
  type JevRow,
  type JevSuggestions,
} from './useJevSuggestions';

/**
 * What the panel and the entry point read from `useJevSuggestions` — a Pick,
 * so a test can hand-build one and the hook's value is always assignable.
 */
export type JevPanelSource = Pick<JevSuggestions,
  | 'groups' | 'state' | 'run' | 'askRefusal' | 'ask' | 'retry'
  | 'contextIndex' | 'entity' | 'toggle' | 'tickRefusal'
  | 'teammatePick' | 'teammateRefusal' | 'modelRefusal' | 'modelMatches'
  | 'applied' | 'applyGroup' | 'applyTeammate' | 'applyModel' | 'applyAll' | 'undo' | 'undoAll'>;

const TARGET_WORD: Record<JevApplyTarget, string> = {
  model: 'Model',
  teammate: 'Teammate',
  memories: 'Memories',
  skills: 'Skills',
  references: 'References',
};
const HEADER_SOURCE_WORDS: Record<RankedEntityHeader['source'], string> = {
  authored: 'authored header',
  native: 'native header',
  derived: 'derived header',
};

/** `useful · 2.1` */
function levelText(item: RankedEntity): string {
  return `${item.level} · ${item.score.toFixed(1)}`;
}

/**
 * Why a row is not ticked, in words. Jev's own fill says below-floor or
 * over-budget; a row Jev DID suggest that is now unticked was the person's
 * untick, and says that instead. A default left out is the loud case: without
 * this line it would vanish from the launch without anyone noticing.
 */
export function untickedWhy(item: RankedEntity, value: { floor: number | null; budget?: number | null }): string {
  const lead = item.default ? 'A default, left out: ' : '';
  if (item.reason === 'below-floor') {
    const floor = value.floor === null ? '' : `, the group needs ${value.floor.toFixed(1)}`;
    return `${lead}below the floor — scored ${item.score.toFixed(1)}${floor}.`;
  }
  if (item.reason === 'over-budget') {
    const budget = value.budget ?? null;
    return `${lead}over budget — ${budget === null ? 'the prompt' : `the group’s ${formatBytes(budget)}`} was full when its turn came.`;
  }
  return item.suggested ? `${lead}you unticked it.` : `${lead}Jev did not suggest it.`;
}

/** Apply, or — once applied — Undo, plus Re-apply when Jev's answer or ticks moved on since. */
function ApplyControl({ target, applied, current = true, refusal, label, onApply, onUndo }: {
  target: JevApplyTarget;
  applied: boolean;
  /** False when the applied entry predates the current answer or ticks. */
  current?: boolean;
  refusal: string | null;
  label?: string;
  onApply(): void;
  onUndo(): void;
}) {
  const apply = (words: string) => (
    <button
      type="button"
      className="jev-apply"
      data-testid={`jev-apply-${target}`}
      aria-disabled={refusal ? true : undefined}
      title={refusal ?? undefined}
      onClick={() => { if (!refusal) onApply(); }}
    >
      {words}
    </button>
  );
  if (!applied) return apply(label ?? `Apply ${TARGET_WORD[target].toLowerCase()}`);
  return (
    <span className="jev-panel__applied">
      <span className="jev-mark" data-testid={`jev-applied-${target}`}>{current ? 'Applied ✓' : 'Applied · Jev’s picks changed since'}</span>
      {current ? null : apply('Re-apply')}
      <button type="button" className="jev-link" data-testid={`jev-undo-${target}`} onClick={onUndo}>Undo</button>
    </span>
  );
}

function Section({ target, title, state, action, children }: {
  target: JevApplyTarget;
  title: string;
  state: JevGroupState<unknown>;
  action: React.ReactNode;
  children: React.ReactNode;
}) {
  const headingId = `jev-panel-${target}-h`;
  return (
    <section className="jev-panel__section" aria-labelledby={headingId} data-testid={`jev-panel-${target}`}>
      <div className="jev-panel__section-head">
        <h3 className="jev-panel__eyebrow" id={headingId}>{title}</h3>
        {state.status === 'ok' ? <JevCostLine cost={state.cost} /> : null}
        <span className="jev-panel__spacer" />
        {action}
      </div>
      {children}
    </section>
  );
}

function Chips({ item }: { item: RankedEntity }) {
  return (
    <span className="jev-prow__chips">
      <span className={`jev-level jev-level--${item.level}`} data-testid={`jev-level-${item.entityId}`}>{levelText(item)}</span>
      {item.default ? <span className="jev-chip jev-chip--default">default</span> : null}
      {item.sources.map((source) => <span key={source} className="jev-chip">{SOURCE_WORDS[source]}</span>)}
      <span className={`jev-chip jev-chip--${item.header.source}`} data-testid={`jev-header-source-${item.entityId}`}>
        {HEADER_SOURCE_WORDS[item.header.source]}
      </span>
    </span>
  );
}

/** Graph content: header text is plain text, never markup. */
function HeaderText({ item }: { item: RankedEntity }) {
  const text = item.header.summary ?? item.header.whenToUse;
  return text ? <p className="jev-prow__text" data-testid={`jev-header-text-${item.entityId}`}>{text}</p> : null;
}

function EntityRow({ row, view, refusal, onToggle }: {
  row: JevRow;
  view: JevEntityGroupView;
  refusal: string | null;
  onToggle(): void;
}) {
  const whyId = `jev-why-${row.entityId}`;
  const refusalId = `jev-tick-refusal-${row.entityId}`;
  const describedBy = [row.ticked ? null : whyId, refusal ? refusalId : null].filter(Boolean).join(' ') || undefined;
  return (
    <li className={`jev-prow ${row.ticked ? 'jev-prow--on' : ''}`} data-testid={`jev-prow-${row.entityId}`}>
      <label className="jev-prow__line">
        <input type="checkbox" checked={row.ticked} onChange={onToggle} aria-describedby={describedBy} />
        <span className="jev-prow__title" title={row.title}>{row.title}</span>
        {view.inPrompt ? <span className="jev-chip jev-chip--bytes">{formatBytes(row.promptBytes)}</span> : null}
      </label>
      <Chips item={row} />
      <HeaderText item={row} />
      {row.ticked ? null : (
        <p className={`jev-prow__why ${row.default ? 'jev-prow__why--default' : ''}`} id={whyId} data-testid={`jev-why-${row.entityId}`}>
          {untickedWhy(row, view)}
        </p>
      )}
      {refusal ? <p className="jev-list__refusal" role="alert" id={refusalId} data-testid={`jev-tick-refusal-${row.entityId}`}>{refusal}</p> : null}
    </li>
  );
}

function EntitySection({ group, jev, say }: { group: JevEntityGroup; jev: JevPanelSource; say(text: string | null): void }) {
  const view = jev.entity[group];
  const state = view.state;
  return (
    <Section
      target={group}
      title={TARGET_WORD[group]}
      state={state}
      action={state.status === 'ok' ? (
        <ApplyControl
          target={group}
          applied={view.applied !== null}
          current={view.appliedIsCurrent}
          refusal={view.applyRefusal}
          label="Apply this group"
          onApply={() => say(jev.applyGroup(group))}
          onUndo={() => say(jev.undo(group))}
        />
      ) : null}
    >
      {state.status !== 'ok' ? <JevGroupStatus group={group} state={state} onRetry={jev.retry} /> : (
        <>
          <BudgetMeter
            group={group}
            compact
            usedBytes={view.usedBytes}
            budget={view.budget}
            count={view.ticked.length}
            contextIndex={view.contextIndex ?? jev.contextIndex}
          />
          {view.budgetSource === 'override' ? <span className="jev-list__considered">budget set for this launch</span> : null}
          {state.value.considered < state.value.total ? (
            <span className="jev-list__considered" data-testid={`jev-panel-${group}-considered`}>
              {state.value.considered} of {state.value.total} considered
            </span>
          ) : null}
          {view.rows.length === 0 ? <p className="jev-status">✦ Jev ranked nothing here.</p> : (
            <ul className="jev-panel__rows">
              {view.rows.map((row) => (
                <EntityRow
                  key={row.entityId}
                  row={row}
                  view={view}
                  refusal={jev.tickRefusal?.group === group && jev.tickRefusal.id === row.entityId ? jev.tickRefusal.reason : null}
                  onToggle={() => { jev.toggle(group, row.entityId); }}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}

function titleOf(jev: JevPanelSource, id: string): string {
  for (const group of JEV_ENTITY_GROUPS) {
    const hit = jev.entity[group].rows.find((row) => row.entityId === id);
    if (hit) return hit.title;
  }
  const teammates = jev.groups.teammates;
  if (teammates.status === 'ok') {
    const hit = teammates.value.items.find((item) => item.entityId === id);
    if (hit) return hit.title;
  }
  return id;
}

interface LedgerLineView { target: JevApplyTarget; at: number; what: string }

/** The ledger as lines, oldest first. */
export function ledgerLines(jev: JevPanelSource, modelLabel: string): LedgerLineView[] {
  const lines: LedgerLineView[] = [];
  const { model, teammate } = jev.applied;
  if (model) {
    lines.push({ target: 'model', at: model.at, what: `${modelLabel} · ${model.value.reasoningEffort ?? 'default effort'} · ${model.value.agentToolId}` });
  }
  if (teammate) lines.push({ target: 'teammate', at: teammate.at, what: titleOf(jev, teammate.teamMemberId) });
  for (const group of JEV_ENTITY_GROUPS) {
    const entry = jev.applied[group];
    if (!entry) continue;
    const parts: string[] = [];
    if (entry.added.length > 0) parts.push(`added ${entry.added.map((id) => titleOf(jev, id)).join(', ')}`);
    if (entry.removed.length > 0) parts.push(`removed default ${entry.removed.map((id) => titleOf(jev, id)).join(', ')}`);
    lines.push({ target: group, at: entry.at, what: parts.length > 0 ? parts.join('; ') : 'kept the defaults as they are' });
  }
  return lines.sort((a, b) => a.at - b.at);
}

/**
 * JEV PANEL — every recommendation in one view (Subhang's I9b note): Model,
 * Teammate, Memories, Skills and References, each with its own Apply and Undo,
 * Apply all on top, and "Applied to this launch" at the bottom, built from the
 * hook's applied ledger. Nothing here changes the launch except a click on
 * Apply, and every Apply can be undone. A refused action says why, in words.
 *
 * Header text, titles and summaries are graph content and render as plain
 * text. Every unticked row says why it is unticked.
 */
export const JevPanel = forwardRef<HTMLHeadingElement, {
  jev: JevPanelSource;
  /** The catalog's words for the suggested model. */
  modelLabel: string;
  onClose?(): void;
  id?: string;
}>(function JevPanel({ jev, modelLabel, onClose, id }, headingRef) {
  /* The last refusal an action returned — Undo teammate with nobody to go
     back to, Apply all's skipped groups — said here instead of swallowed. */
  const [notice, setNotice] = useState<string | null>(null);
  const model = jev.groups.model;
  const teammates = jev.groups.teammates;
  const top = jev.teammatePick;
  const anyAnswer = (['model', 'teammates', 'memories', 'skills', 'references'] as const)
    .some((group) => jev.groups[group].status === 'ok');
  const lines = ledgerLines(jev, modelLabel);

  const applyAll = () => {
    const report = jev.applyAll();
    const skipped = Object.entries(report.skipped) as [JevApplyTarget, string][];
    setNotice(skipped.length === 0 ? null
      : `Applied ${String(report.applied.length)}. Not applied: ${skipped.map(([target, why]) => `${TARGET_WORD[target]} — ${why}`).join(' · ')}`);
  };

  return (
    <div className="jev-panel" id={id} data-testid="jev-panel" role="region" aria-labelledby="jev-panel-title">
      <div className="jev-panel__head">
        <h2 className="jev-panel__title" id="jev-panel-title" ref={headingRef} tabIndex={-1}>✦ Jev’s recommendations</h2>
        {jev.run && jev.run.calls > 0 ? <JevCostLine run={jev.run} /> : null}
        <span className="jev-panel__spacer" />
        {lines.length > 0 ? (
          <button type="button" className="jev-link" data-testid="jev-undo-all" onClick={() => { jev.undoAll(); setNotice(null); }}>
            Undo all
          </button>
        ) : null}
        <button
          type="button"
          className="jev-apply"
          data-testid="jev-apply-all"
          aria-disabled={anyAnswer ? undefined : true}
          title={anyAnswer ? 'Apply every recommendation to this launch. Each one can be undone.' : 'Jev has not answered yet.'}
          onClick={() => { if (anyAnswer) applyAll(); }}
        >
          Apply all
        </button>
        {onClose ? (
          <button type="button" className="jev-link" data-testid="jev-panel-close" onClick={onClose}>Close</button>
        ) : null}
      </div>
      <p className="jev-panel__note">Nothing changes until you apply it. What you apply goes out with Launch.</p>
      {notice ? <p className="jev-status" role="status" data-testid="jev-panel-notice">{notice}</p> : null}
      {jev.state === 'stale' ? (
        <p className="jev-status" role="status" data-testid="jev-panel-stale">
          Changed since Jev looked —{' '}
          <button type="button" className="jev-link" data-testid="jev-panel-ask-again" onClick={() => jev.ask()}>Ask again</button>
        </p>
      ) : null}

      <Section
        target="model"
        title="Model"
        state={model}
        action={model.status === 'ok' ? (
          <ApplyControl
            target="model"
            applied={Boolean(jev.applied.model)}
            refusal={jev.modelRefusal ?? (jev.modelMatches ? 'The launch already runs this model, tool and effort.' : null)}
            onApply={() => setNotice(jev.applyModel())}
            onUndo={() => setNotice(jev.undo('model'))}
          />
        ) : null}
      >
        {model.status !== 'ok' ? <JevGroupStatus group="model" state={model} onRetry={jev.retry} /> : (
          <>
            <p className="jev-panel__value" data-testid="jev-panel-model-value">
              {modelLabel} · {model.value.effort} · {model.value.tier} · {model.value.agentTool}
            </p>
            {jev.modelRefusal ? <p className="jev-hint__refusal" data-testid="jev-panel-model-refusal">{jev.modelRefusal}</p> : null}
            {model.value.reasons.length > 0 ? (
              <ul className="jev-panel__reasons">{model.value.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            ) : null}
          </>
        )}
      </Section>

      <Section
        target="teammate"
        title="Teammate"
        state={teammates}
        action={teammates.status === 'ok' ? (
          <ApplyControl
            target="teammate"
            applied={Boolean(jev.applied.teammate)}
            refusal={jev.teammateRefusal}
            label={top ? `Apply ${top.title}` : 'Apply teammate'}
            onApply={() => setNotice(jev.applyTeammate())}
            onUndo={() => setNotice(jev.undo('teammate'))}
          />
        ) : null}
      >
        {teammates.status !== 'ok' ? <JevGroupStatus group="teammates" state={teammates} onRetry={jev.retry} /> : (
          <>
            {teammates.value.noFit ? <p className="jev-ranks__nofit" data-testid="jev-panel-nofit">Nobody fits this work well.</p> : null}
            <ol className="jev-panel__rows">
              {[...teammates.value.items].sort((a, b) => b.score - a.score).map((item) => (
                <li key={item.entityId} className="jev-prow" data-testid={`jev-prow-${item.entityId}`}>
                  <span className="jev-prow__line">
                    <span className="jev-prow__title" title={item.title}>{item.title}</span>
                  </span>
                  <Chips item={item} />
                  <HeaderText item={item} />
                  {item.suggested ? null : (
                    <p className="jev-prow__why" data-testid={`jev-why-${item.entityId}`}>
                      {untickedWhy(item, { floor: teammates.value.floor })}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
      </Section>

      {JEV_ENTITY_GROUPS.map((group) => <EntitySection key={group} group={group} jev={jev} say={setNotice} />)}

      <section className="jev-panel__section jev-ledger" aria-labelledby="jev-ledger-h" data-testid="jev-ledger">
        <h3 className="jev-panel__eyebrow" id="jev-ledger-h">Applied to this launch</h3>
        {lines.length === 0 ? (
          <p className="jev-status" data-testid="jev-ledger-empty">Nothing yet — this launch goes out as you set it.</p>
        ) : (
          <ul className="jev-ledger__lines">
            {lines.map((line) => (
              <li key={line.target} className="jev-ledger__line" data-testid={`jev-ledger-${line.target}`}>
                <span className="jev-ledger__group">{TARGET_WORD[line.target]}</span>
                <span className="jev-ledger__what">{line.what}</span>
                <time className="jev-cost" dateTime={new Date(line.at).toISOString()}>
                  {new Date(line.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </time>
                <button
                  type="button"
                  className="jev-link"
                  data-testid={`jev-ledger-undo-${line.target}`}
                  onClick={() => setNotice(jev.undo(line.target))}
                >
                  Undo
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
});
