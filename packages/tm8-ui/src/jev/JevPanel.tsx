import { forwardRef } from 'react';
import type { EntitySuggestion, RankedEntity, RankedEntityHeader } from '@tm8/contract';

import { BudgetMeter, formatBytes } from './BudgetMeter';
import { SOURCE_WORDS } from './format';
import { JevCostLine } from './JevCostLine';
import { JevGroupStatus } from './JevGroupStatus';
import type { JevApplyTarget, JevEntityGroup, JevLedgerEntry, JevPanelSource, JevTickKindAll } from './lane-a-stub';
import type { JevGroupState } from './useJevSuggestions';

const KIND_OF: Record<JevEntityGroup, JevTickKindAll> = { memories: 'memory', skills: 'skill', references: 'reference' };
const TARGET_WORD: Record<JevApplyTarget, string> = {
  model: 'Model',
  teammates: 'Teammate',
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
export function untickedWhy(item: RankedEntity, value: { floor: number; budget?: number | null }): string {
  const lead = item.default ? 'A default, left out: ' : '';
  if (item.reason === 'below-floor') {
    return `${lead}below the floor — scored ${item.score.toFixed(1)}, the group needs ${value.floor.toFixed(1)}.`;
  }
  if (item.reason === 'over-budget') {
    const budget = value.budget ?? null;
    return `${lead}over budget — ${budget === null ? 'the prompt' : `the group’s ${formatBytes(budget)}`} was full when its turn came.`;
  }
  return item.suggested ? `${lead}you unticked it.` : `${lead}Jev did not suggest it.`;
}

function latestEntry(applied: readonly JevLedgerEntry[], group: JevApplyTarget): JevLedgerEntry | undefined {
  for (let i = applied.length - 1; i >= 0; i -= 1) if (applied[i]!.group === group) return applied[i];
  return undefined;
}

function ApplyButton({ target, applied, refusal, label, onApply, onUndo }: {
  target: JevApplyTarget;
  applied: boolean;
  refusal: string | null;
  label?: string;
  onApply(): void;
  onUndo(): void;
}) {
  if (applied) {
    return (
      <button type="button" className="jev-link" data-testid={`jev-undo-${target}`} onClick={onUndo}>
        Undo
      </button>
    );
  }
  return (
    <button
      type="button"
      className="jev-apply"
      data-testid={`jev-apply-${target}`}
      aria-disabled={refusal ? true : undefined}
      title={refusal ?? undefined}
      onClick={() => { if (!refusal) onApply(); }}
    >
      {label ?? `Apply ${TARGET_WORD[target].toLowerCase()}`}
    </button>
  );
}

function Section({ target, title, cost, action, children }: {
  target: JevApplyTarget;
  title: string;
  cost: JevGroupState<unknown>;
  action: React.ReactNode;
  children: React.ReactNode;
}) {
  const headingId = `jev-panel-${target}-h`;
  return (
    <section className="jev-panel__section" aria-labelledby={headingId} data-testid={`jev-panel-${target}`}>
      <div className="jev-panel__section-head">
        <h3 className="jev-panel__eyebrow" id={headingId}>{title}</h3>
        {cost.status === 'ok' ? <JevCostLine cost={cost.cost} /> : null}
        <span className="jev-panel__spacer" />
        {action}
      </div>
      {children}
    </section>
  );
}

function EntityRow({ item, value, on, kind, onToggle }: {
  item: RankedEntity;
  value: EntitySuggestion;
  on: boolean;
  kind: JevTickKindAll;
  onToggle(kind: JevTickKindAll, id: string): void;
}) {
  const text = item.header.summary ?? item.header.whenToUse;
  const whyId = `jev-why-${item.entityId}`;
  return (
    <li className={`jev-prow ${on ? 'jev-prow--on' : ''}`} data-testid={`jev-prow-${item.entityId}`}>
      <label className="jev-prow__line">
        <input
          type="checkbox"
          checked={on}
          onChange={() => onToggle(kind, item.entityId)}
          aria-describedby={on ? undefined : whyId}
        />
        {/* Graph content: a title is plain text, never markup. */}
        <span className="jev-prow__title" title={item.title}>{item.title}</span>
      </label>
      <span className="jev-prow__chips">
        <span className={`jev-level jev-level--${item.level}`} data-testid={`jev-level-${item.entityId}`}>{levelText(item)}</span>
        {item.default ? <span className="jev-chip jev-chip--default">default</span> : null}
        {item.sources.map((source) => <span key={source} className="jev-chip">{SOURCE_WORDS[source]}</span>)}
        <span className={`jev-chip jev-chip--${item.header.source}`} data-testid={`jev-header-source-${item.entityId}`}>
          {HEADER_SOURCE_WORDS[item.header.source]}
        </span>
        <span className="jev-chip jev-chip--bytes">{formatBytes(item.promptBytes)}</span>
      </span>
      {text ? <p className="jev-prow__text" data-testid={`jev-header-text-${item.entityId}`}>{text}</p> : null}
      {on ? null : (
        <p className={`jev-prow__why ${item.default ? 'jev-prow__why--default' : ''}`} id={whyId} data-testid={`jev-why-${item.entityId}`}>
          {untickedWhy(item, value)}
        </p>
      )}
    </li>
  );
}

function EntitySection({ group, jev }: { group: JevEntityGroup; jev: JevPanelSource }) {
  const state = jev.groups[group];
  const kind = KIND_OF[group];
  const entry = latestEntry(jev.applied, group);
  const meter = jev.meter[group];
  const refusal = state.status === 'ok' ? null : 'Jev has no answer for this group yet.';
  return (
    <Section
      target={group}
      title={TARGET_WORD[group]}
      cost={state}
      action={state.status === 'ok' ? (
        <ApplyButton
          target={group}
          applied={Boolean(entry)}
          refusal={refusal}
          label="Apply this group"
          onApply={() => jev.applyGroup(group)}
          onUndo={() => jev.undo(group)}
        />
      ) : null}
    >
      {state.status !== 'ok' ? <JevGroupStatus group={group} state={state} onRetry={jev.retry} /> : (
        <>
          <BudgetMeter
            group={group}
            compact
            usedBytes={meter?.usedBytes ?? 0}
            budget={meter ? meter.budget : state.value.budget}
            contextIndex={jev.contextIndex}
          />
          {state.value.considered < state.value.total ? (
            <span className="jev-list__considered" data-testid={`jev-panel-${group}-considered`}>
              {state.value.considered} of {state.value.total} considered
            </span>
          ) : null}
          {state.value.items.length === 0 ? <p className="jev-status">✦ Jev ranked nothing here.</p> : (
            <ul className="jev-panel__rows">
              {state.value.items.map((item) => (
                <EntityRow
                  key={item.entityId}
                  item={item}
                  value={state.value}
                  kind={kind}
                  on={jev.ticked[kind].includes(item.entityId)}
                  onToggle={jev.toggle}
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
  for (const group of ['memories', 'skills', 'references', 'teammates'] as const) {
    const state = jev.groups[group];
    if (state.status !== 'ok') continue;
    const hit = state.value.items.find((item) => item.entityId === id);
    if (hit) return hit.title;
  }
  return id;
}

function LedgerLine({ entry, jev, modelLabel }: { entry: JevLedgerEntry; jev: JevPanelSource; modelLabel: string }) {
  let what: string;
  if (entry.group === 'model') {
    what = `${modelLabel} · ${entry.model.effort} · ${entry.model.agentTool}`;
  } else if (entry.group === 'teammates') {
    what = titleOf(jev, entry.teammateId);
  } else {
    const parts: string[] = [];
    if (entry.added.length > 0) parts.push(`added ${entry.added.map((id) => titleOf(jev, id)).join(', ')}`);
    if (entry.removed.length > 0) parts.push(`removed default ${entry.removed.map((id) => titleOf(jev, id)).join(', ')}`);
    what = parts.length > 0 ? parts.join('; ') : 'no change from the defaults';
  }
  return (
    <li className="jev-ledger__line" data-testid={`jev-ledger-${entry.group}`}>
      <span className="jev-ledger__group">{TARGET_WORD[entry.group]}</span>
      <span className="jev-ledger__what">{what}</span>
      <time className="jev-cost" dateTime={new Date(entry.at).toISOString()}>
        {new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </time>
      <button type="button" className="jev-link" data-testid={`jev-ledger-undo-${entry.group}`} onClick={() => jev.undo(entry.group)}>
        Undo
      </button>
    </li>
  );
}

/**
 * JEV PANEL — every recommendation in one view (Subhang's I9b note): Model,
 * Teammate, Memories, Skills and References, each with its own Apply and Undo,
 * Apply all on top, and "Applied to this launch" at the bottom, built from the
 * applied ledger. Nothing here changes the launch except a click on Apply, and
 * every Apply can be undone.
 *
 * Header text, titles and summaries are graph content and render as plain
 * text. Every unticked row says why it is unticked.
 */
export const JevPanel = forwardRef<HTMLHeadingElement, {
  jev: JevPanelSource;
  /** The catalog's words for the suggested model. */
  modelLabel: string;
  /** Why Apply model is refused on this surface, or null. */
  modelRefusal: string | null;
  /** Why Apply teammate is refused on this surface (not on the roster), or null. */
  teammateRefusal?: string | null;
  onClose?(): void;
  id?: string;
}>(function JevPanel({ jev, modelLabel, modelRefusal, teammateRefusal, onClose, id }, headingRef) {
  const model = jev.groups.model;
  const teammates = jev.groups.teammates;
  const top = teammates.status === 'ok' && !teammates.value.noFit
    ? [...teammates.value.items].sort((a, b) => b.score - a.score).find((item) => item.suggested)
    : undefined;
  const anyAnswer = (['model', 'teammates', 'memories', 'skills', 'references'] as const)
    .some((group) => jev.groups[group].status === 'ok');

  return (
    <div className="jev-panel" id={id} data-testid="jev-panel" role="region" aria-labelledby="jev-panel-title">
      <div className="jev-panel__head">
        <h2 className="jev-panel__title" id="jev-panel-title" ref={headingRef} tabIndex={-1}>✦ Jev’s recommendations</h2>
        {jev.run && jev.run.calls > 0 ? <JevCostLine run={jev.run} /> : null}
        <span className="jev-panel__spacer" />
        {jev.applied.length > 0 ? (
          <button type="button" className="jev-link" data-testid="jev-undo-all" onClick={jev.undoAll}>Undo all</button>
        ) : null}
        <button
          type="button"
          className="jev-apply"
          data-testid="jev-apply-all"
          aria-disabled={anyAnswer ? undefined : true}
          title={anyAnswer ? 'Apply every recommendation to this launch. Each one can be undone.' : 'Jev has not answered yet.'}
          onClick={() => { if (anyAnswer) jev.applyAll(); }}
        >
          Apply all
        </button>
        {onClose ? (
          <button type="button" className="jev-link" data-testid="jev-panel-close" onClick={onClose}>Close</button>
        ) : null}
      </div>
      <p className="jev-panel__note">Nothing changes until you apply it. Ticks go out with Launch.</p>
      {jev.state === 'stale' ? (
        <p className="jev-status" role="status" data-testid="jev-panel-stale">
          Changed since Jev looked —{' '}
          <button type="button" className="jev-link" data-testid="jev-panel-ask-again" onClick={() => jev.ask()}>Ask again</button>
        </p>
      ) : null}

      <Section
        target="model"
        title="Model"
        cost={model}
        action={model.status === 'ok' ? (
          <ApplyButton
            target="model"
            applied={Boolean(latestEntry(jev.applied, 'model'))}
            refusal={modelRefusal}
            onApply={jev.applyModel}
            onUndo={() => jev.undo('model')}
          />
        ) : null}
      >
        {model.status !== 'ok' ? <JevGroupStatus group="model" state={model} onRetry={jev.retry} /> : (
          <>
            <p className="jev-panel__value" data-testid="jev-panel-model-value">
              {modelLabel} · {model.value.effort} · {model.value.tier} · {model.value.agentTool}
            </p>
            {modelRefusal ? <p className="jev-hint__refusal" data-testid="jev-panel-model-refusal">{modelRefusal}</p> : null}
            {model.value.reasons.length > 0 ? (
              <ul className="jev-panel__reasons">{model.value.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            ) : null}
          </>
        )}
      </Section>

      <Section
        target="teammates"
        title="Teammate"
        cost={teammates}
        action={teammates.status === 'ok' ? (
          <ApplyButton
            target="teammates"
            applied={Boolean(latestEntry(jev.applied, 'teammates'))}
            refusal={!top ? 'Jev found no teammate that fits this work.' : teammateRefusal ?? null}
            label={top ? `Apply ${top.title}` : 'Apply teammate'}
            onApply={jev.applyTeammate}
            onUndo={() => jev.undo('teammates')}
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
                  <span className="jev-prow__chips">
                    <span className={`jev-level jev-level--${item.level}`}>{levelText(item)}</span>
                    {item.default ? <span className="jev-chip jev-chip--default">default</span> : null}
                    {item.sources.map((source) => <span key={source} className="jev-chip">{SOURCE_WORDS[source]}</span>)}
                    <span className={`jev-chip jev-chip--${item.header.source}`}>{HEADER_SOURCE_WORDS[item.header.source]}</span>
                  </span>
                  {item.header.summary ?? item.header.whenToUse ? (
                    <p className="jev-prow__text">{item.header.summary ?? item.header.whenToUse}</p>
                  ) : null}
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

      <EntitySection group="memories" jev={jev} />
      <EntitySection group="skills" jev={jev} />
      <EntitySection group="references" jev={jev} />

      <section className="jev-panel__section jev-ledger" aria-labelledby="jev-ledger-h" data-testid="jev-ledger">
        <h3 className="jev-panel__eyebrow" id="jev-ledger-h">Applied to this launch</h3>
        {jev.applied.length === 0 ? (
          <p className="jev-status" data-testid="jev-ledger-empty">Nothing yet — this launch goes out as you set it.</p>
        ) : (
          <ul className="jev-ledger__lines">
            {jev.applied.map((entry) => (
              <LedgerLine key={`${entry.group}-${String(entry.at)}`} entry={entry} jev={jev} modelLabel={modelLabel} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
});
