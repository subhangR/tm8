import type { ReactNode, RefObject } from 'react';
import type { ActorSummary } from '@tm8/contract';
import type { PillTone } from '../../kit';
import { Avatar } from '../../kit';
import './maestro-task-tile.css';

export interface MaestroTaskTileProps {
  rootRef: RefObject<HTMLDivElement>;
  id: string;
  title: string;
  depth: number;
  selected: boolean;
  attention: boolean;
  attentionReason?: string;
  completed: boolean;
  childCount: number;
  childrenExpanded: boolean;
  onToggleChildren?: () => void;
  onSelect?: () => void;
  status: {
    label: string;
    title?: string;
    tone: PillTone;
    hollow: boolean;
    streaming: boolean;
  };
  assignees: readonly ActorSummary[];
  actions: ReactNode;
  detailsExpanded: boolean;
  flowOpen: boolean;
  onToggleDetails(): void;
  children?: ReactNode;
}

/**
 * Direct tm8 port of Maestro's `TaskTile` / `pn-tt` component. The layout and
 * class anatomy stay Maestro's; its props are deliberately view-model shaped
 * so the registry adapter can supply tm8 data without this component knowing
 * an entity kind or inventing Maestro-only fields.
 */
export function MaestroTaskTile(props: MaestroTaskTileProps) {
  const {
    rootRef,
    title,
    depth,
    selected,
    attention,
    attentionReason,
    completed,
    childCount,
    childrenExpanded,
    onToggleChildren,
    onSelect,
    status,
    assignees,
    actions,
    detailsExpanded,
    flowOpen,
    onToggleDetails,
    children,
  } = props;
  const hasChildren = childCount > 0 && onToggleChildren != null;

  return (
    <div
      ref={rootRef}
      className={[
        'pn-tt',
        completed ? 'pn-tt--completed' : '',
        selected ? 'pn-tt--active' : '',
        attention ? 'pn-tt--attention' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid="list-tile"
      data-depth={depth}
      data-tree="true"
      data-children={childCount || undefined}
      data-details={detailsExpanded ? 'open' : undefined}
      data-flow={flowOpen ? 'open' : undefined}
      data-streaming={status.streaming ? 'true' : 'false'}
      data-anatomy="control-card"
    >
      <div className="pn-tt__main" onClick={onSelect}>
        {hasChildren ? (
          <button
            type="button"
            className={
              childrenExpanded ? 'pn-tt__arrow pn-tt__arrow--expanded' : 'pn-tt__arrow'
            }
            aria-label={`${childrenExpanded ? 'Collapse' : 'Expand'} ${title}, ${childCount} ${childCount === 1 ? 'child' : 'children'}`}
            aria-expanded={childrenExpanded}
            onClick={(event) => {
              event.stopPropagation();
              onToggleChildren();
            }}
          >
            <ChevronRight />
          </button>
        ) : (
          <span className="pn-tt__arrow pn-tt__arrow--empty" aria-hidden>
            <ChevronRight />
          </span>
        )}
        {childCount > 0 ? <span className="pn-tt__arrowCount">{childCount}</span> : null}

        <span className="pn-tt__status" title={status.title ?? status.label}>
          <MaestroStatusGlyph
            tone={status.tone}
            hollow={status.hollow}
            streaming={status.streaming}
          />
          <span className="pn-tt__status-text">{status.label}</span>
        </span>

        <button
          type="button"
          className="pn-tt__title"
          title={title}
          aria-current={selected ? 'true' : undefined}
          onClick={(event) => {
            event.stopPropagation();
            onSelect?.();
          }}
        >
          {title}
        </button>

        {assignees.length > 0 ? (
          <div className="pn-tt__inline">
            <span
              className="pn-av-group"
              role="img"
              aria-label={assignees.map((actor) => actor.displayName).join(', ')}
              title={assignees.map((actor) => actor.displayName).join(', ')}
            >
              {assignees.slice(0, 3).map((actor) => (
                <Avatar
                  key={actor.id}
                  actorId={actor.id}
                  provenance={actor.isAgent ? 'agent' : 'human'}
                  label={actor.displayName}
                  /* 15, not 20 — nothing in this row may exceed the 17px that
                     sets a session row's height, or the row grows past the
                     shared floor for the one reason CSS alone cannot fix. */
                  size={15}
                />
              ))}
            </span>
          </div>
        ) : null}

        {attention ? <span className="pn-tt__attention" title={attentionReason}>Needs attention</span> : null}

        <div className="pn-tt__actions">
          {actions}
          <button
            type="button"
            className={detailsExpanded ? 'pn-tt__ind pn-tt__ind--open' : 'pn-tt__ind'}
            aria-label={`${detailsExpanded ? 'Collapse' : 'Expand'} details for ${title}`}
            aria-expanded={detailsExpanded}
            onClick={(event) => {
              event.stopPropagation();
              onToggleDetails();
            }}
          >
            <ChevronDown />
          </button>
        </div>
      </div>

      {detailsExpanded ? (
        <div className="pn-tt__meta" onClick={(event) => event.stopPropagation()}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The status mark is a DOT, not a ring.
 *
 * It used to be a 16px ring with a smaller ring or centre pip inside it, which
 * read as a heavy checkbox and dominated a 13px title. A running task now
 * shows exactly what the eye is looking for — one green dot — and a not-yet-
 * started one shows the same dot hollowed out. Tone carries the meaning
 * (`run` is green), so nothing here hard-codes a colour.
 */
function MaestroStatusGlyph({
  tone,
  hollow,
  streaming,
}: {
  tone: PillTone;
  hollow: boolean;
  streaming: boolean;
}) {
  return (
    <span
      className={[
        'pn-stat',
        `pn-stat--${tone}`,
        hollow ? 'pn-stat--hollow' : 'pn-stat--solid',
        streaming ? 'pn-stat--streaming' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-hidden
    >
      <span className="pn-stat__dot" />
    </span>
  );
}

/*
 * Chevrons are SVG, not the text glyphs `›` and `⌄`. Typographic arrows sit on
 * their own font's baseline, so the disclosure caret and the details caret
 * landed at different optical heights from the dot beside them — the visible
 * "icons aren't aligned" defect. A path in a square viewBox centres exactly.
 */
function ChevronRight() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden focusable="false">
      <path
        d="M6 3.5L10.5 8L6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden focusable="false">
      <path
        d="M3.5 6L8 10.5L12.5 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
