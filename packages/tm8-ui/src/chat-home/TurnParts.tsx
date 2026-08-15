import { useMemo } from 'react';
import type { EntityId } from '@tm8/contract';
import { Markdown } from '../kit';
import { EntityChip, type ChatEntityResolver } from './EntityChip';
import { extractEntityRefs } from './entity-refs';
import { ExplanationToolCard } from './ExplanationToolCard';
import { durableOutputToolName, explanationToolName } from './explanation-tools';
import { projectTurnParts } from './turn-model';
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

export function TurnParts({
  parts,
  onOpenEntity,
  resolveEntity,
  suppressEntityIds,
  assetHref,
}: TurnPartsProps) {
  return (
    <div className="tch-parts">
      {projectTurnParts(parts).map((part) => {
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
          return (
            <ToolCard
              key={`${part.toolCallId}:${part.seq}`}
              part={part}
              onOpenEntity={onOpenEntity}
              resolveEntity={resolveEntity}
              suppressEntityIds={suppressEntityIds}
            />
          );
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

function ToolCard({
  part,
  onOpenEntity,
  resolveEntity,
  suppressEntityIds,
}: {
  part: Extract<ReturnType<typeof projectTurnParts>[number], { kind: 'tool' }>;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  resolveEntity?: ChatEntityResolver | undefined;
  suppressEntityIds?: ReadonlySet<string> | undefined;
}) {
  // The payload walk (with JSON.parse of embedded blobs) must not re-run on
  // every streamed frame of unrelated turns.
  const entityRefs = useMemo(
    () =>
      extractEntityRefs(part.args, part.result).filter(
        (ref) => !suppressEntityIds?.has(ref.id),
      ),
    [part.args, part.result, suppressEntityIds],
  );
  return (
    <article className="tch-tool" data-state={part.state} data-testid="chat-tool-card">
      <header className="tch-tool__head">
        <span aria-hidden className="tch-tool__mark">⌁</span>
        <code>{part.name}</code>
        <span className="tch-tool__state">{toolStateLabel(part.state)}</span>
      </header>
      <details className="tch-tool__detail">
        <summary>Input</summary>
        <pre>{formatPayload(part.args)}</pre>
      </details>
      {part.result !== undefined ? (
        <details className="tch-tool__detail" data-error={part.resultIsError || undefined}>
          <summary>{part.resultIsError ? 'Error result' : 'Result'}</summary>
          <pre>{formatPayload(part.result)}</pre>
        </details>
      ) : null}
      {entityRefs.length > 0 ? (
        <div
          className="tch-tool__entities"
          data-testid="chat-tool-entities"
          aria-label="Entities referenced by this tool call"
        >
          {entityRefs.map((ref) => (
            <EntityChip key={ref.id} refInfo={ref} resolve={resolveEntity} onOpen={onOpenEntity} />
          ))}
        </div>
      ) : null}
    </article>
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

function toolStateLabel(state: 'running' | 'completed' | 'error'): string {
  if (state === 'running') return 'running';
  if (state === 'completed') return 'completed';
  return 'error';
}

function tokenTotal(usage: ChatUsage): number | null {
  if (usage.input_tokens === undefined && usage.output_tokens === undefined) return null;
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

function formatPayload(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
