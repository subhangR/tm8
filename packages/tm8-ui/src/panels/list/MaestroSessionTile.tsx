import type { EntitySummary } from '@tm8/contract';
import { useState } from 'react';
import { copyToClipboard } from '../../terminal/domUtils';

/**
 * Maestro's session-row anatomy, fed exclusively by tm8 contract data.
 * The live dot/ping structure is intentionally identical to Maestro's
 * SessionListItem: liveness owns the solid dot; byte activity only adds ping.
 */
export function MaestroSessionTile({
  id,
  title,
  agentTool,
  model,
  status,
  attention,
  selected,
  archived,
  completed,
  live,
  streaming,
  statusTone,
  statusTitle,
  tasks,
  childCount,
  childrenExpanded,
  onToggleChildren,
  onSelect,
  onClose,
}: {
  id: string;
  title: string;
  agentTool: string | null;
  model: string | null;
  status: string;
  attention: boolean;
  selected: boolean;
  archived: boolean;
  completed: boolean;
  live: boolean;
  streaming: boolean;
  statusTone: string;
  statusTitle?: string;
  tasks: readonly EntitySummary[];
  childCount: number;
  childrenExpanded: boolean;
  onToggleChildren?: () => void;
  onSelect: () => void;
  onClose?: () => void;
}) {
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const copySessionId = async () => {
    if (!(await copyToClipboard(id))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  };

  return (
    <div
      className={`pn-st${selected ? ' pn-st--selected' : ''}${attention ? ' pn-st--attention' : ''}${archived ? ' pn-st--archived' : ''}`}
      data-testid="list-tile"
      data-session-node={id}
      data-children={childCount > 0 ? childCount : undefined}
      data-streaming={streaming ? 'true' : 'false'}
      onClick={onSelect}
    >
      <div className="pn-st__main">
        <button
          type="button"
          className={`pn-st__arrow ${childCount > 0 ? (childrenExpanded ? 'pn-st__arrow--expanded' : '') : 'pn-st__arrow--empty'}`}
          disabled={childCount === 0}
          onClick={(event) => {
            event.stopPropagation();
            onToggleChildren?.();
          }}
          title={childCount > 0 ? `${childrenExpanded ? 'Collapse' : 'Expand'} ${childCount} sub-sessions` : 'No sub-sessions'}
          aria-label={childCount > 0 ? `${childrenExpanded ? 'Collapse' : 'Expand'} ${title}, ${childCount} ${childCount === 1 ? 'child' : 'children'}` : `No sub-sessions for ${title}`}
          aria-expanded={childCount > 0 ? childrenExpanded : undefined}
        >
          <SessionIcon name="chevron" />
        </button>
        {childCount > 0 ? <span className="pn-st__arrowCount">{childCount}</span> : null}

        <span className="pn-st__title lp__title" title={`${title} · ${id}`}>
          <AgentTile
            tool={agentTool}
            live={!archived && live}
            streaming={!archived && live && streaming}
            title={statusTitle ?? status}
          />
          <span className="pn-st__titleText">{title}</span>
        </span>

        {model ? <span className="pn-st__model" title={model}>{model}</span> : null}

        {archived ? <span className="pn-st__tag">archived</span> : null}
        {attention && !archived ? <span className="pn-st__tag pn-st__tag--attention">needs attention</span> : null}
        {!archived && completed ? <span className="pn-st__tag pn-st__tag--done">done</span> : null}

        <span className={`pn-st__statusglyph lp__statusmark--${statusTone}`} title={statusTitle ?? status}>
          <StatusGlyph kind={archived ? 'archived' : status} />
        </span>
        <span className="pn-st__actions">
          {onClose ? (
            <button
              type="button"
              className="pn-st__btn pn-st__btn--danger"
              title="Close session"
              aria-label="Close session"
              onClick={(event) => {
                event.stopPropagation();
                onClose();
              }}
            >
              <SessionIcon name="close" />
            </button>
          ) : null}
          <button
            type="button"
            className="pn-st__btn"
            title={copied ? 'Session ID copied' : 'Copy session ID'}
            aria-label={copied ? 'Session ID copied' : 'Copy session ID'}
            onClick={(event) => {
              event.stopPropagation();
              void copySessionId();
            }}
          >
            <SessionIcon name={copied ? 'check' : 'copy'} />
          </button>
          <button
            type="button"
            className="pn-st__btn"
            title={detailsExpanded ? 'Collapse details' : 'Expand details'}
            aria-label={detailsExpanded ? 'Collapse details' : 'Expand details'}
            aria-expanded={detailsExpanded}
            onClick={(event) => {
              event.stopPropagation();
              setDetailsExpanded((value) => !value);
            }}
          >
            <SessionIcon name="expand" flipped={detailsExpanded} />
          </button>
        </span>
      </div>

      {detailsExpanded && tasks.length > 0 ? (
        <div className="pn-st__tasklines">
          {tasks.map((task) => {
            const taskState = task.state as unknown as { workStatus?: string };
            return (
              <div key={task.id} className="pn-st__taskline" title={`${task.title} (${taskState.workStatus ?? 'work item'})`}>
                <StatusGlyph kind={taskState.workStatus ?? 'open'} size={13} />
                <span className="pn-st__tasklineLabel">{task.title}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function AgentTile({ tool, live, streaming, title }: { tool: string | null; live: boolean; streaming: boolean; title: string }) {
  const normalized = tool === 'claude-code' ? 'claude' : (tool || 'agent').toLowerCase();
  const className = `pn-agent${live ? ' pn-agent--live' : ''}${streaming ? ' pn-agent--streaming' : ''}`;
  const label = normalized === 'claude'
    ? '✳'
    : normalized === 'codex'
      ? '✦'
      : normalized === 'gemini'
        ? '✧'
        : normalized === 'hermes'
          ? '✣'
          : '✦';
  return <span className={className} data-agent-kind={normalized} aria-label={tool || 'agent'} title={title}><span className="pn-agent__mark" aria-hidden>{label}</span></span>;
}

function SessionIcon({ name, size = 13, flipped = false }: { name: 'chevron' | 'check' | 'close' | 'copy' | 'expand'; size?: number; flipped?: boolean }) {
  const d = name === 'check'
    ? 'M3.5 8.5L6.5 11.5 12.5 5'
    : name === 'close'
      ? 'M4 4l8 8M12 4l-8 8'
      : name === 'copy'
        ? 'M6 5h6v7H6zM4 10H3V3h6v1'
        : name === 'expand'
          ? 'M4.5 6.5L8 10l3.5-3.5'
          : 'M6 3.5L10.5 8 6 12.5';
  return <svg style={flipped ? { transform: 'rotate(180deg)' } : undefined} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>;
}

function StatusGlyph({ kind, size = 16 }: { kind: string; size?: number }) {
  const ring = <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />;
  let inner;
  switch (kind) {
    case 'running':
    case 'working':
      inner = <>{ring}<circle cx="8" cy="8" r="2.6" fill="currentColor" /></>;
      break;
    case 'spawning':
    case 'pulled':
      inner = <><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.28" /><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" pathLength="100" strokeDasharray="36 100" transform="rotate(-90 8 8)" /></>;
      break;
    case 'exited':
    case 'completed':
    case 'done':
      inner = <><circle cx="8" cy="8" r="6.5" fill="currentColor" /><path d="M5 8.2l2.1 2.1L11 6.4" fill="none" stroke="var(--pn-card)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></>;
      break;
    case 'failed':
    case 'blocked':
      inner = <>{ring}<path d="M5.7 5.7l4.6 4.6M10.3 5.7l-4.6 4.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>;
      break;
    case 'archived':
      inner = <rect x="3" y="3" width="10" height="10" rx="2.2" fill="currentColor" />;
      break;
    default:
      inner = ring;
  }
  return <svg className={`pn-stat pn-stat--${kind}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden>{inner}</svg>;
}
