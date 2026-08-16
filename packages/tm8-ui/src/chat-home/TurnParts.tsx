import { useMemo } from 'react';
import type { EntityId } from '@tm8/contract';
import { Markdown } from '../kit';
import { EntityChip, type ChatEntityResolver } from './EntityChip';
import { extractEntityRefs, type ChatEntityRef } from './entity-refs';
import { ExplanationToolCard } from './ExplanationToolCard';
import { durableOutputToolName, explanationToolName } from './explanation-tools';
import { projectTurnParts, type ProjectedTurnPart } from './turn-model';
import type { ChatTurnPart, ChatUsage } from './types';

export interface TurnPartsProps {
  parts: readonly ChatTurnPart[];
  /** Opens the entity detail panel; absent renders chips as inert badges. */
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  /** Lazily resolves title/kind for bare-id references. */
  resolveEntity?: ChatEntityResolver | undefined;
  /** Ids that must never chip — this thread's own messages. A chip pointing at
   *  a message already on screen is noise; a message from another session or
   *  thread stays a useful pointer. */
  suppressEntityIds?: ReadonlySet<string> | undefined;
  /** Resolves authenticated tm8 file bytes for an inline asset preview. */
  assetHref?: ((fileEntityId: EntityId) => string | null) | undefined;
}

/** A tool call with nothing to show for itself — everything except the
 *  `explain_*` / `doc_*` / `artifact_create` family, whose payload IS content. */
function isPlainTool(
  part: ProjectedTurnPart,
): part is Extract<ProjectedTurnPart, { kind: 'tool' }> {
  return (
    part.kind === 'tool' &&
    !explanationToolName(part.name) &&
    !durableOutputToolName(part.name)
  );
}

export function TurnParts({
  parts,
  onOpenEntity,
  resolveEntity,
  suppressEntityIds,
  assetHref,
}: TurnPartsProps) {
  const projected = useMemo(() => projectTurnParts(parts), [parts]);
  /**
   * THE TOOL CALL IS NOT THE ANSWER. A turn that read nine entities drew nine
   * boxes, each announcing `tm8_read` and offering its own Input/Result
   * payload — the most visually dominant thing in the transcript, saying the
   * least. It buried the three things the reader actually came for: the prose,
   * the entities, and the graph.
   *
   * So a plain tool call now renders NOTHING OF ITS OWN. What it touched still
   * survives, because that is the part with meaning: every plain call's refs
   * are folded into ONE deduped chip row (nine reads of four entities = four
   * chips, not nine boxes), anchored at the first call so the row fills in
   * live, in place, exactly as the calls land.
   *
   * NOTHING IS LOST THAT WAS EVER READ HERE: the payload walk is unchanged,
   * the same `extractEntityRefs` the graph folds from, so the chips and the
   * graph still agree. Only the box is gone.
   */
  const plainTools = useMemo(() => projected.filter(isPlainTool), [projected]);
  const touched = useMemo(() => {
    const seen = new Map<string, ChatEntityRef>();
    for (const part of plainTools) {
      for (const ref of extractEntityRefs(part.args, part.result)) {
        if (suppressEntityIds?.has(ref.id)) continue;
        if (!seen.has(ref.id)) seen.set(ref.id, ref);
      }
    }
    return [...seen.values()];
  }, [plainTools, suppressEntityIds]);
  const chipAnchorSeq = plainTools[0]?.seq ?? null;

  return (
    <div className="tch-parts">
      {projected.map((part) => {
        if (part.kind === 'thinking') {
          return (
            <details className="tch-thinking" key={part.seq}>
              <summary>Thinking</summary>
              <p>{part.text}</p>
            </details>
          );
        }
        if (part.kind === 'text') {
          return (
            <Markdown
              key={part.seq}
              source={part.text}
              className="tch-answer"
              testId="chat-turn-text"
            />
          );
        }
        if (part.kind === 'tool') {
          if (explanationToolName(part.name) || durableOutputToolName(part.name)) {
            return (
              <ExplanationToolCard
                key={`${part.toolCallId}:${part.seq}`}
                part={part}
                onOpenEntity={onOpenEntity}
                resolveEntity={resolveEntity}
                suppressEntityIds={suppressEntityIds}
                assetHref={assetHref}
              />
            );
          }
          // The box is gone. Only the first plain call of the turn stands in
          // for all of them, and only to carry the chips.
          return part.seq === chipAnchorSeq && touched.length > 0 ? (
            <TouchedEntities
              key={part.seq}
              refs={touched}
              onOpenEntity={onOpenEntity}
              resolveEntity={resolveEntity}
            />
          ) : null;
        }
        if (part.kind === 'usage') {
          return <UsageCard key={part.seq} usage={part.usage} />;
        }
        return (
          <div className="tch-turn-error" role="alert" key={part.seq}>
            <strong>Turn failed</strong>
            <span>{part.message}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * ONE ROW PER TURN, for every plain tool call in it. The chips are the whole
 * surviving trace of those calls, so this row says what was touched and
 * nothing about how — no tool name, no call count, no payload.
 */
function TouchedEntities({
  refs,
  onOpenEntity,
  resolveEntity,
}: {
  refs: readonly ChatEntityRef[];
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  resolveEntity?: ChatEntityResolver | undefined;
}) {
  return (
    <div
      className="tch-touched"
      data-testid="chat-touched-entities"
      aria-label="Entities this turn touched"
    >
      {refs.map((ref) => (
        <EntityChip key={ref.id} refInfo={ref} resolve={resolveEntity} onOpen={onOpenEntity} />
      ))}
    </div>
  );
}

function UsageCard({ usage }: { usage: ChatUsage }) {
  const tokens = tokenTotal(usage);
  return (
    <aside className="tch-usage" aria-label="Turn usage" data-testid="chat-usage-card">
      <span className="tch-usage__label">usage</span>
      {tokens !== null ? <span>{tokens.toLocaleString()} tokens</span> : null}
      {usage.total_cost_usd !== undefined ? (
        <span>{formatCost(usage.total_cost_usd)}</span>
      ) : null}
      {usage.model ? <span>{usage.model}</span> : null}
      {usage.provider ? <span>{usage.provider}</span> : null}
    </aside>
  );
}

function tokenTotal(usage: ChatUsage): number | null {
  if (usage.input_tokens === undefined && usage.output_tokens === undefined) return null;
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}
