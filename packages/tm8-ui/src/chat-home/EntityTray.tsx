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
 * fight the composer's own popovers for the same airspace).
 *
 * THE TWO PINNED STAGES sit at the tray's right edge — Fleet and Graph, the
 * Cockpit stages that are not entities. They are TABS like the rest, not
 * doors to a dialog: the graph's fullscreen overlay is retired and both are
 * ordinary occupants of region B, addressed by `?stage=`. Absent handler ⇒ no
 * tabs, never dead ones.
 *
 * Renders NOTHING for a thread with no entities — the zero state keeps its
 * clean centred pair, and an empty tray row would be a dashboard's cladding.
 *
 * AND NOTHING AT ALL ON THE PHONE (user report 2026-08-20, task 01a01c91:
 * "many chips in horizontal scroll … remove those chips completely"). This is
 * not a taste trim, and the measurement is what settles it: `MobileShell`
 * mounts `ChatHomeSurface` with no `onStageChange`, no `onShowChat` and no
 * entity-open handler, so on that surface the tray has no Chat tab, no Fleet or
 * Graph tab, and `EntityChip` falls to its `<span>` branch — the strip is
 * INERT. What shipped was ~24px of chrome and a sideways scroll gesture
 * competing with the transcript's, in return for nothing a tap can do. The
 * honesty rule this file already states for the stage tabs ("absent handler ⇒
 * no tabs, never dead ones") reaches the chips too; it had only never been
 * asked about a host that wires none of them.
 *
 * SCOPED OFF, NOT DELETED. On the desktop the same tray IS wired — it carries
 * the Chat tab that is the way back from a stage, and chips that open panels.
 * Deleting it outright would take a working navigation surface away to fix a
 * phone that never had one.
 */
import { useMemo, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import { useMobileSurface } from '../mobile';
import type { CockpitStage } from '../routes/types';
import { EntityChip, type ChatEntityResolver } from './EntityChip';
import { foldGraphSeeds } from './graph-seeds';
import type { ChatTurn } from './types';

export const TRAY_VISIBLE_LIMIT = 6;

export function EntityTray({
  turns,
  suppressEntityIds,
  resolveEntity,
  onOpenEntity,
  onStage,
  activeStage = null,
  activeEntityId = null,
  onShowChat,
  chatBusy = false,
}: {
  turns: readonly ChatTurn[];
  suppressEntityIds?: ReadonlySet<string> | undefined;
  resolveEntity?: ChatEntityResolver | undefined;
  /** Opening an entity tab. On the Home host this swaps the STAGE
   *  (`onSelectEntity` → centerOverride); elsewhere it opens the panel. */
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  /** Swap to a non-entity stage, or back to the chat with `null`. Absent ⇒
   *  no stage tabs — never a dead control. */
  onStage?: ((next: CockpitStage | null) => void) | undefined;
  /** Which stage is up, so its tab draws active and the Chat tab does not. */
  activeStage?: CockpitStage | null | undefined;
  /** The entity currently occupying the stage — its tab draws active and the
   *  Chat tab does not. */
  activeEntityId?: string | null | undefined;
  /** The way back (Cockpit ruling 2026-08-18): a Chat tab, always first.
   *  Absent ⇒ this host has no stage to come back from, no tab drawn. */
  onShowChat?: (() => void) | undefined;
  /** The thread is streaming/thinking while something else holds the stage —
   *  the Chat tab pulses so an answer never lands unseen. */
  chatBusy?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { oneSurface } = useMobileSurface();
  const stageActive = activeEntityId != null || activeStage != null;
  const seeds = useMemo(() => {
    const { seeds: all } = foldGraphSeeds(turns, suppressEntityIds);
    return [...all.filter((s) => s.mutated), ...all.filter((s) => !s.mutated)];
  }, [turns, suppressEntityIds]);

  /* The phone takes no chips at all — see the docblock. The fold above still
     runs and is still cheap; gating it would put the hook call behind a
     condition for nothing. */
  const chips = oneSurface ? [] : seeds;

  /* The stage tabs are ALWAYS worth drawing once a thread exists: a fleet is
     most interesting exactly when the conversation has just delegated and the
     entity chips have not resolved yet. */
  if (chips.length === 0 && !stageActive && !onStage) return null;
  const visible = expanded ? chips : chips.slice(0, TRAY_VISIBLE_LIMIT);
  const hidden = chips.length - visible.length;

  return (
    <nav className="tch-tray" aria-label="Entities in this thread" data-testid="chat-entity-tray">
      <div className="tch-tray__tabs" data-expanded={expanded || undefined}>
        {onShowChat ? (
          <button
            type="button"
            className="tch-tray__chat"
            data-active={!stageActive || undefined}
            aria-current={!stageActive || undefined}
            onClick={onShowChat}
          >
            <span aria-hidden>⌂</span> Chat
            {stageActive && chatBusy ? (
              <span className="tch-tray__pulse" role="status" aria-label="The agent is still working in this thread" />
            ) : null}
          </button>
        ) : null}
        {visible.map((seed) => (
          <span
            key={seed.id}
            className="tch-tray__tab"
            data-active={seed.id === activeEntityId || undefined}
          >
            <EntityChip
              refInfo={{ id: seed.id, kind: seed.kind, title: seed.title }}
              resolve={resolveEntity}
              onOpen={onOpenEntity}
            />
          </span>
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
        ) : expanded && chips.length > TRAY_VISIBLE_LIMIT ? (
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
      {onStage ? (
        <div className="tch-tray__stages">
          <button
            type="button"
            /* ONE VISUAL FAMILY (visual lane's handoff note): the stage tabs
               ARE the Chat tab's anatomy — same pill, same active treatment,
               same focus ring — with a marker class for nothing but the
               tests. Giving them a lookalike of their own is how two tabs in
               one row start drifting apart. */
            className="tch-tray__chat tch-tray__stage"
            data-active={activeStage === 'fleet' || undefined}
            aria-current={activeStage === 'fleet' || undefined}
            title="The worker sessions and tasks this conversation delegated"
            onClick={() => onStage(activeStage === 'fleet' ? null : 'fleet')}
          >
            <span aria-hidden>⛭</span> Fleet
          </button>
          <button
            type="button"
            className="tch-tray__chat tch-tray__stage"
            data-active={activeStage === 'graph' || undefined}
            aria-current={activeStage === 'graph' || undefined}
            title="The entities this conversation named, and the relations they actually hold"
            onClick={() => onStage(activeStage === 'graph' ? null : 'graph')}
          >
            <span aria-hidden>◈</span> Graph
          </button>
        </div>
      ) : null}
    </nav>
  );
}
