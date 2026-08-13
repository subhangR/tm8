import { Markdown } from '../kit';
import { projectTurnParts } from './turn-model';
import type { ChatTurnPart, ChatUsage } from './types';

export function TurnParts({ parts }: { parts: readonly ChatTurnPart[] }) {
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
          return (
            <article
              className="tch-tool"
              data-state={part.state}
              data-testid="chat-tool-card"
              key={`${part.toolCallId}:${part.seq}`}
            >
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
            </article>
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

