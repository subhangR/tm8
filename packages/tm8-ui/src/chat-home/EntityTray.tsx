/**
 * THE ENTITY TRAY (Cockpit ruling 2026-08-18) — the thread's entities, docked
 * to the top of the composer's control panel so everything the conversation
 * created or touched stays one click away without leaving the chat.
 *
 * Scope is CREATED + TOUCHED: the same `foldGraphSeeds` walk the entity graph
 * draws from, so the tray and the graph can never disagree about what this
 * thread references. Write-touched seeds (`mutated`) lead, in first-reference
 * order within each group — creation is the strongest claim to a berth, and
 * first-seen order is the one order streaming never reshuffles.
 *
 * Overflow is a COUNT, not silence: beyond `TRAY_VISIBLE_LIMIT` a `+N more`
 * control expands the tray in place (wrap, not menu — a drop-up here would
 * fight the composer's own popovers for the same airspace). The Graph door
 * lives at the tray's right edge: the stage the tabs will one day swap is
 * today the fullscreen graph the route already owns.
 *
 * Renders NOTHING for a thread with no entities — the zero state keeps its
 * clean centred pair, and an empty tray row would be a dashboard's cladding.
 */
import { useMemo, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import { EntityChip, type ChatEntityResolver } from './EntityChip';
import { foldGraphSeeds } from './graph-seeds';
import type { ChatTurn } from './types';

export const TRAY_VISIBLE_LIMIT = 6;

export function EntityTray({
  turns,
  suppressEntityIds,
  resolveEntity,
  onOpenEntity,
  onOpenGraph,
}: {
  turns: readonly ChatTurn[];
  suppressEntityIds?: ReadonlySet<string> | undefined;
  resolveEntity?: ChatEntityResolver | undefined;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  /** The Graph door. Absent ⇒ no button — never a dead control. */
  onOpenGraph?: (() => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const seeds = useMemo(() => {
    const { seeds: all } = foldGraphSeeds(turns, suppressEntityIds);
    return [...all.filter((s) => s.mutated), ...all.filter((s) => !s.mutated)];
  }, [turns, suppressEntityIds]);

  if (seeds.length === 0) return null;
  const visible = expanded ? seeds : seeds.slice(0, TRAY_VISIBLE_LIMIT);
  const hidden = seeds.length - visible.length;

  return (
    <nav className="tch-tray" aria-label="Entities in this thread" data-testid="chat-entity-tray">
      <div className="tch-tray__tabs" data-expanded={expanded || undefined}>
        {visible.map((seed) => (
          <EntityChip
            key={seed.id}
            refInfo={{ id: seed.id, kind: seed.kind, title: seed.title }}
            resolve={resolveEntity}
            onOpen={onOpenEntity}
          />
        ))}
        {hidden > 0 ? (
          <button
            type="button"
            className="tch-tray__more"
            aria-expanded={false}
            onClick={() => setExpanded(true)}
          >
            {`+${hidden} more`}
          </button>
        ) : expanded && seeds.length > TRAY_VISIBLE_LIMIT ? (
          <button
            type="button"
            className="tch-tray__more"
            aria-expanded
            onClick={() => setExpanded(false)}
          >
            fewer
          </button>
        ) : null}
      </div>
      {onOpenGraph ? (
        <button
          type="button"
          className="tch-tray__graph"
          title="Open the entity graph for this thread"
          onClick={onOpenGraph}
        >
          <span aria-hidden>◈</span> Graph
        </button>
      ) : null}
    </nav>
  );
}
