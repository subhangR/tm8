import type { ActorSummary, EntitySummary } from '@tm8/contract';
import { useState, type ReactNode } from 'react';
import { Avatar } from '../../kit/Avatar';
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
  sessionKind,
  teammate,
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
  lane,
  badges,
  childCount,
  childrenExpanded,
  onToggleChildren,
  onSelect,
  actions,
  detail,
}: {
  id: string;
  title: string;
  agentTool: string | null;
  /**
   * The row's `sessionKind`, when the server sent one (101).
   *
   * Read ONLY to tell a vanilla terminal from an agent. Absent — a pre-083
   * node, or a payload cached before the column shipped — keeps the pre-100
   * rendering exactly, which is why this branches on `=== 'shell'` rather than
   * on `agentTool` being null. Those two are not the same question: a session
   * row that never recorded a tool is an AGENT whose tool is unknown, and
   * drawing it as a terminal would be a new lie in place of the old one.
   */
  sessionKind?: string | null;
  /**
   * The persona this run acts as, when the summary carries one.
   *
   * Null/absent is NOT a defect to paper over: a vanilla shell, or a run no
   * team_member participates in, has no teammate to draw, and the tile falls
   * back to the tool mark alone rather than inventing a monogram from the
   * session title.
   */
  teammate?: ActorSummary | null;
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
  /**
   * The ONE lane line (107): `⎇ branch · [worktree|shared|scratch]`, from the
   * session's summary lane facts. Renders beside the PR chips; absent when
   * the session has no branch fact — honest absence draws nothing.
   */
  lane?: ReactNode;
  /** Glanceable git state (PR chips via the session's tasks) — same slot the task tile has. */
  badges?: ReactNode;
  childCount: number;
  childrenExpanded: boolean;
  onToggleChildren?: () => void;
  onSelect: () => void;
  /** The shared row-action cluster — see `RowActionCluster`. */
  actions?: ReactNode;
  /** D67 — the shared state/archive strip, rendered inside this tile's expand. */
  detail?: ReactNode;
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
        <span className="pn-st__title lp__title" title={`${title} · ${id}`}>
          <AgentTile
            tool={agentTool}
            shell={sessionKind === 'shell'}
            teammate={teammate ?? null}
            childCount={childCount}
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
        <span className="pn-st__actions lp__cluster">
          {/* The shared cluster — Collections · Run · Archive — which this
              anatomy had never rendered at all: its `rowActions` were declared
              in the registry and dropped on the floor here, while a Close
              button was hand-rolled beside them. Terminate now comes from the
              registry (with its dedicated executor), so there is exactly one
              of it. Copy stays: it is this anatomy's own affordance, not a
              registry verb. */}
          {actions}
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

      {lane || badges ? (
        <div className="pn-st__badges">
          {lane}
          {badges}
        </div>
      ) : null}

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

      {/* D67 — the state + archive strip, on the SAME disclosure as the task
          lines. Gated on `detailsExpanded` alone, NOT on `tasks.length`: a
          session with no linked task still has an archive control, and hanging
          it off the task list would make it vanish for exactly the rows a user
          is most likely to be tidying up. */}
      {detailsExpanded ? detail : null}
    </div>
  );
}

/**
 * THREE FACTS, ONE ICON: who ran it, what they ran it with, how many
 * sub-sessions it owns.
 *
 * The tool mark used to own this slot alone, so two sessions on the same tool
 * were indistinguishable at a glance no matter which teammate was driving.
 * The persona now takes the FACE; the tool marks the TOP-LEFT corner and the
 * sub-session count the BOTTOM-RIGHT, which is why the count no longer prints
 * beside the chevron — one number, one place.
 *
 * Corners, not stacking: an unattributed run (a shell, or a session no
 * team_member participates in) has no face to badge, so its tool mark stays
 * centred exactly as before and only the count rides the corner.
 */
function AgentTile({ tool, shell, teammate, childCount, live, streaming, title }: { tool: string | null; shell?: boolean; teammate: ActorSummary | null; childCount: number; live: boolean; streaming: boolean; title: string }) {
  // A vanilla terminal is not an agent whose tool we failed to record, and the
  // fallback below would have called it one — `(tool || 'agent')`, glyph and
  // aria-label alike. It gets its own mark instead.
  const normalized = shell ? 'shell' : tool === 'claude-code' ? 'claude' : (tool || 'agent').toLowerCase();
  const label = normalized === 'shell'
    ? '▮'
    : normalized === 'claude'
    ? '✳'
    : normalized === 'codex'
      ? '✦'
      : normalized === 'gemini'
        ? '✧'
        : normalized === 'hermes'
          ? '✣'
          : '✦';
  const toolName = shell ? 'terminal' : tool || 'agent';
  // A shell has no persona by construction; guarding on it as well as on
  // `teammate` keeps a stray edge from dressing a terminal as an agent.
  const persona = shell ? null : teammate;
  const className = `pn-agent${persona ? ' pn-agent--persona' : ''}${live ? ' pn-agent--live' : ''}${streaming ? ' pn-agent--streaming' : ''}`;
  return (
    <span
      className={className}
      data-agent-kind={normalized}
      data-teammate-id={persona?.id}
      data-children={childCount > 0 ? childCount : undefined}
      aria-label={persona ? undefined : toolName}
      title={[
        persona ? `${persona.displayName} · ${toolName}` : null,
        childCount > 0 ? `${childCount} sub-session${childCount === 1 ? '' : 's'}` : null,
        title,
      ].filter(Boolean).join(' · ')}
    >
      {persona ? (
        // The Avatar is the only element here with a role, so it carries every
        // fact as its accessible name — the corner badges are decorative, and
        // a second aria-label on the wrapper would only double-announce.
        <Avatar
          actorId={persona.id}
          provenance="agent"
          label={[
            `${persona.displayName} · ${toolName}`,
            childCount > 0 ? `${childCount} sub-session${childCount === 1 ? '' : 's'}` : null,
          ].filter(Boolean).join(' · ')}
          initials={persona.displayName.charAt(0)}
          src={persona.avatar}
          size={15}
          className="pn-agent__avatar"
        />
      ) : null}
      {/* Keeps `pn-agent__mark` in both shapes so the per-tool colour, live
          and streaming rules stay one set of selectors. */}
      <span className={`pn-agent__mark${persona ? ' pn-agent__tool' : ''}`} aria-hidden>{label}</span>
      {childCount > 0 ? (
        <span className="pn-agent__kids" aria-hidden>{childCount}</span>
      ) : null}
    </span>
  );
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
