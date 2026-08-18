/**
 * THE FLEET PANE — the workers this conversation is running, rendered inside
 * the Cockpit.
 *
 * Chat is the human's orchestrating main thread. It has no native subagents on
 * purpose: parallelism is tm8 worker sessions, spawned through `tm8_delegate`,
 * and the deliberate consequence of that choice is that everything chat
 * delegates is a REAL, durable, inspectable entity rather than an invisible
 * in-process fan-out. This pane is where that consequence becomes visible —
 * without it, the one advantage of routing delegation through the graph is
 * paid for and never collected.
 *
 * A LEAF. No route knowledge, no navigation store, no seam import: every fact
 * arrives as a prop and every verb leaves as a callback. That is what lets the
 * host mount it as a stage, a tray tab or a panel without this file learning
 * which, and it is why the pane can be tested against a fake reader.
 *
 * WHAT IT REFUSES TO DO:
 *  · It never claims a session is live from a stored status. Only the seam's
 *    verdict lights the dot; absent verdict renders neutral, never live.
 *  · It never gates a row on a capability. Capabilities are missing on
 *    unhydrated rows as a matter of course, and "absent ⇒ not permitted" is
 *    the right rule for a VERB and a disastrous one for a ROW — so an absent
 *    capability disables an action with a reason and never blanks the row.
 *  · It never drops a ref it could not read. A shrinking fleet is the one
 *    failure a fleet pane must not have.
 *  · It never renders a second transcript. The Transcript view is the session
 *    panel's, and this pane links to it.
 */
import { useMemo } from 'react';
import type { EntityId } from '@tm8/contract';
import { KindIcon } from '../../domain/KindIcon';
import { Pill } from '../../kit';
import { LinkedPullRequestChips } from '../../pull-requests';
import type { ChatTurn } from '../types';
import { foldFleet } from './fleet-model';
import { fleetRowsOf, groupFleetRows, type FleetRow } from './fleet-rows';
import { useFleetEntities, type FleetEntityReader } from './use-fleet-entities';
import type { FleetRowInput } from './fleet-rows';
import './fleet-pane.css';

export interface FleetPaneProps {
  /** The thread, as the screen already holds it. This pane opens no feed. */
  turns: readonly ChatTurn[];
  /** This thread's own message ids — already the transcript, never fleet. */
  suppressEntityIds?: ReadonlySet<string> | undefined;
  /** The host's `entities.get`. Absent ⇒ every row stays an honest id. */
  readEntity?: FleetEntityReader | undefined;
  /** The seam's liveness verdict — the ONLY thing that may light a live dot. */
  livenessOf?: FleetRowInput['livenessOf'];
  /** Ids with pool byte-activity right now; can only refine a live verdict. */
  streamingIds?: ReadonlySet<string> | undefined;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  /**
   * Open this session's Transcript view. ABSENT IS A REAL STATE, not a bug:
   * a host with nowhere to send the viewer renders no link rather than a dead
   * one, which is why this is optional and why the button is conditional.
   */
  onOpenTranscript?: ((id: EntityId) => void) | undefined;
}

export function FleetPane({
  turns,
  suppressEntityIds,
  readEntity,
  livenessOf,
  streamingIds,
  onOpenEntity,
  onOpenTranscript,
}: FleetPaneProps) {
  const fold = useMemo(() => foldFleet(turns, suppressEntityIds), [turns, suppressEntityIds]);
  const ids = useMemo(() => fold.drawn.map((ref) => ref.id), [fold]);
  const reads = useFleetEntities(ids, readEntity);
  const rows = useMemo(
    () => fleetRowsOf({ refs: fold.drawn, reads, livenessOf, streamingIds }),
    [fold, reads, livenessOf, streamingIds],
  );
  const groups = useMemo(() => groupFleetRows(rows), [rows]);

  const nothingYet = fold.refs.length === 0;

  return (
    <section className="fleet" aria-label="Fleet" data-testid="cockpit-fleet">
      <header className="fleet__head">
        <h2>Fleet</h2>
        {/* The live count is the seam's, not the records'. */}
        <span className="fleet__summary">
          {nothingYet
            ? 'nothing delegated yet'
            : `${groups.sessions.length} ${groups.sessions.length === 1 ? 'session' : 'sessions'}` +
              (groups.liveSessionCount > 0 ? ` · ${groups.liveSessionCount} live` : '') +
              (groups.tasks.length > 0 ? ` · ${groups.tasks.length} ${groups.tasks.length === 1 ? 'task' : 'tasks'}` : '')}
        </span>
      </header>

      {nothingYet ? (
        <p className="fleet__empty">
          This conversation has not delegated anything yet. Work handed to a teammate becomes a
          worker session here, with its own transcript you can open.
        </p>
      ) : null}

      <FleetSectionList
        label="Sessions"
        rows={groups.sessions}
        onOpenEntity={onOpenEntity}
        onOpenTranscript={onOpenTranscript}
      />
      <FleetSectionList label="Tasks" rows={groups.tasks} onOpenEntity={onOpenEntity} />
      <FleetSectionList label="Also referenced" rows={groups.other} onOpenEntity={onOpenEntity} />
      {/* Reading, not empty. Its own section so a settling row never jumps
          between kind sections under the viewer's cursor. */}
      <FleetSectionList label="Reading" rows={groups.pending} onOpenEntity={onOpenEntity} />

      {fold.overflow > 0 ? (
        <p className="fleet__overflow" data-testid="fleet-overflow">
          {fold.overflow} more referenced and not drawn — the pane caps what it reads, and says so
          rather than reporting a smaller fleet than this conversation has.
        </p>
      ) : null}
    </section>
  );
}

function FleetSectionList({
  label,
  rows,
  onOpenEntity,
  onOpenTranscript,
}: {
  label: string;
  rows: readonly FleetRow[];
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  onOpenTranscript?: ((id: EntityId) => void) | undefined;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="fleet__section">
      <h3 className="fleet__eyebrow">
        {label} <span className="fleet__count">{rows.length}</span>
      </h3>
      <ul className="fleet__rows">
        {rows.map((row) => (
          <FleetRowItem
            key={row.id}
            row={row}
            onOpenEntity={onOpenEntity}
            onOpenTranscript={onOpenTranscript}
          />
        ))}
      </ul>
    </div>
  );
}

function FleetRowItem({
  row,
  onOpenEntity,
  onOpenTranscript,
}: {
  row: FleetRow;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  onOpenTranscript?: ((id: EntityId) => void) | undefined;
}) {
  return (
    <li className="fleet__row" data-testid="fleet-row" data-read={row.read} data-origin={row.origin}>
      {/* The row BUTTON and the chips are siblings: PR chips carry real <a>
          links, which cannot nest inside a button. */}
      <button
        type="button"
        className="fleet__open"
        onClick={onOpenEntity ? () => onOpenEntity(row.id as EntityId) : undefined}
        disabled={!onOpenEntity}
        title={row.originSentence}
      >
        {row.kind ? <KindIcon kind={row.kind} /> : null}
        <span className="fleet__title" data-placeholder={row.titleIsPlaceholder || undefined}>
          {row.title}
        </span>
        {row.word ? (
          <Pill
            tone={row.tone}
            {...(row.dot === 'pulse' ? { dot: 'pulse' as const } : row.dot === 'solid' ? { dot: 'solid' as const } : {})}
            {...(row.statusDetail ? { title: row.statusDetail } : {})}
          >
            {row.word}
          </Pill>
        ) : null}
        {row.read === 'failed' ? (
          <span className="fleet__unread" title="This entity could not be read — its id is all this pane can honestly show.">
            unreadable
          </span>
        ) : null}
      </button>

      {row.pullRequests.length > 0 ? (
        <LinkedPullRequestChips pullRequests={row.pullRequests} placement="tile" />
      ) : null}

      {row.section === 'sessions' && onOpenTranscript ? (
        <button
          type="button"
          className="fleet__transcript"
          onClick={() => onOpenTranscript(row.id as EntityId)}
        >
          Transcript
        </button>
      ) : null}
    </li>
  );
}
