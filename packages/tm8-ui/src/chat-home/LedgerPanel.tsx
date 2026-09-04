/**
 * THE LEDGER PANEL (S4, design 01a023e1 §7) — the sticky projection. The
 * transcript's ledger lines scroll away with their turns; this panel is the
 * SAME fold projected cumulatively, welded above the composer, so "what has
 * this conversation built" is always answerable without scrolling back.
 *
 * Collapsed (the default) it is one row: `[<scope> ⌄] [<summary for that
 * scope>]` — SCOPE-GENERAL from the start (ruling 9): `[sessions] [5 live ·]`
 * when scoped to sessions, `[Task 1] [3 tasks, 2 docs]` when scoped to an
 * entity. Expanded, the body is capped in height with its own scroll
 * (ruling from §7.5) — a tree N deep must not eat the transcript it
 * accompanies.
 *
 * THE SCOPE PICKER is a drop-up (§7.2): `sessions` (default) or any entity
 * this chat created under which it created something else. Switching scope is
 * a FILTER over the one fold, never a refetch (ruling 6). The menu is
 * PORTALLED via `useMenuAnchor` — the panel body is an overflow container, so
 * an in-flow menu would clip against it; portalling also means it cannot
 * collide with the composer's own popovers, and `useDismissable` keeps two
 * from being open at once (Worker B's audit, S4 a6).
 *
 * THE LIVENESS LAW (ruling 10): the collapsed pill's `5 live` is
 * `groupFleetRows(fleetRowsOf(…)).liveSessionCount` — the seam's verdict,
 * NEVER re-derived here (`fleet-rows.ts` names a re-deriving surface "the
 * fourth place that law could rot"). `idle` is a legal live state; a
 * `running` record with no live process is stale. Before liveness settles
 * the pill says `5 sessions`, never `0 live` — a lie flashed on every mount.
 *
 * SESSIONS ARE VIEW-ONLY (ruling 8): a row click opens the entity in the
 * RIGHT PANEL via the screen's `onOpenEntity` — never the stage-swapping
 * `onSelectEntity` expression, which would evict the conversation under its
 * own composer (S5's seam tests pin where the click lands). No composer
 * retargeting; that concern was raised and withdrawn — do not re-raise.
 *
 * HANDLER-GATED, NOT DEVICE-GATED (decision D1): the panel renders only when
 * the host wires `onOpenEntity` — its rows' whole purpose. `MobileShell`
 * wires none, so phones render NOTHING, exactly as after the 01a01c91
 * revert, with no device special-case; mobile lights up the day the shell
 * wires an opener.
 */
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EntityId } from '@tm8/contract';
import { Pill, useMenuAnchor } from '../kit';
import { useDismissable } from '../panels/useDismissable';
import type { ChatEntityResolver } from './EntityChip';
import { truncateEntityId } from './entity-refs';
import { foldFleet } from './fleet/fleet-model';
import { fleetRowsOf, groupFleetRows, type FleetRow } from './fleet/fleet-rows';
import { useFleetEntities, type FleetEntityReader } from './fleet/use-fleet-entities';
import type { FleetRowInput } from './fleet/fleet-rows';
import { foldChatLedger, kindWord } from './ledger';
import { LedgerTree, type LedgerNodeStatus } from './ledger-tree';
import type { ChatTurn } from './types';

const MENU_WIDTH = 220;
const MENU_HEIGHT = 264;

type Scope = 'sessions' | EntityId;

export interface LedgerPanelProps {
  turns: readonly ChatTurn[];
  suppressEntityIds?: ReadonlySet<string> | undefined;
  resolveEntity?: ChatEntityResolver | undefined;
  /** The SCREEN's opener — GateApp binds it to the right panel. Rows are the
   *  panel's whole purpose, so absent this the panel renders nothing. */
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  /** The fleet read path (sessions scope) — same seam FleetPane uses. */
  readEntity?: FleetEntityReader | undefined;
  livenessOf?: FleetRowInput['livenessOf'] | undefined;
  streamingIds?: ReadonlySet<string> | undefined;
}

export function LedgerPanel({
  turns,
  suppressEntityIds,
  resolveEntity,
  onOpenEntity,
  readEntity,
  livenessOf,
  streamingIds,
}: LedgerPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [scope, setScope] = useState<Scope>('sessions');
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const menuId = useId();
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useDismissable(menuOpen, [triggerRef, menuRef], closeMenu);
  const anchor = useMenuAnchor(menuOpen, triggerRef, menuRef, closeMenu, MENU_HEIGHT, MENU_WIDTH);

  const ledger = foldChatLedger(turns);

  /* THE FLEET IS THE SESSIONS AUTHORITY — `foldFleet` sees dispatches and
     delegations the ledger's create fold does not, and reusing it whole is
     what ruling 10 demands anyway. The CANDIDATE set is the refs whose
     ORIGIN says this chat caused a session (spawned/dispatched/delegated) —
     a task the thread merely read must never inflate `N sessions` while its
     read is unsettled. Hooks run unconditionally (rules of hooks); the
     render gate comes after. */
  const fold = useMemo(() => foldFleet(turns, suppressEntityIds), [turns, suppressEntityIds]);
  const sessionRefs = useMemo(
    () =>
      fold.drawn.filter(
        (ref) => ref.origin === 'spawned' || ref.origin === 'dispatched' || ref.origin === 'delegated',
      ),
    [fold],
  );
  const sessionIds = useMemo(() => sessionRefs.map((ref) => ref.id), [sessionRefs]);
  const reads = useFleetEntities(sessionIds, readEntity);
  const rows = useMemo(
    () =>
      fleetRowsOf({
        refs: sessionRefs,
        reads,
        livenessOf,
        streamingIds,
        hasReader: readEntity !== undefined,
      }),
    [sessionRefs, reads, livenessOf, streamingIds, readEntity],
  );
  const groups = useMemo(() => groupFleetRows(rows), [rows]);

  /* Scope options: sessions, plus every created entity that has a created
     child — an entity nothing was created under would open an empty tree,
     and a menu of dead ends is noise, not choice. */
  const entityScopes = useMemo(() => {
    const parents = new Set<string>();
    for (const create of ledger.creates) {
      const parent = ledger.parentOf.get(create.id);
      if (parent) parents.add(parent);
    }
    return [...parents].filter((id) => ledger.creates.some((c) => c.id === id));
  }, [ledger]);

  const statusOf = useCallback(
    (id: string): LedgerNodeStatus | null => {
      const row = rows.find((r) => r.id === id);
      if (!row || row.word === null) return null;
      return {
        word: row.word,
        tone: row.tone,
        dot: row.dot === 'pulse' || row.dot === 'solid' ? row.dot : null,
        ...(row.statusDetail ? { detail: row.statusDetail } : {}),
      };
    },
    [rows],
  );

  /* HANDLER-GATED (D1) and zero-state honest: no opener, or nothing to
     show in ANY scope, draws nothing at all. */
  const sessionCount = groups.sessions.length + groups.unsettled.length;
  if (!onOpenEntity) return null;
  if (ledger.creates.length === 0 && sessionCount === 0) return null;

  const scopeLabel =
    scope === 'sessions'
      ? 'sessions'
      : (ledger.labels.get(scope)?.title ?? truncateEntityId(scope));

  /* The collapsed summary, scope-general (ruling 9). Sessions: the liveness
     verdict once EVERY session read settled and a verdict channel exists —
     `N sessions` until then, and `0 live` only when settled truth says so.
     An entity scope: kind counts over what was created under it. */
  const summary = (() => {
    if (scope === 'sessions') {
      const settled =
        livenessOf !== undefined &&
        groups.unsettled.length === 0 &&
        groups.sessions.length > 0 &&
        groups.sessions.every((row: FleetRow) => row.read === 'loaded');
      if (settled) return `${groups.liveSessionCount} live`;
      return `${sessionCount} ${kindWord('work_session', sessionCount)}`;
    }
    const under = ledger.creates.filter((c) => {
      for (
        let parent = ledger.parentOf.get(c.id), hops = 0;
        parent != null && hops < 64;
        parent = ledger.parentOf.get(parent) ?? null, hops++
      ) {
        if (parent === scope) return true;
      }
      return false;
    });
    if (under.length === 0) return 'nothing created here';
    const byKind = new Map<string, number>();
    for (const c of under) {
      const kind = c.kind ?? ledger.labels.get(c.id)?.kind ?? 'entity';
      byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    }
    return [...byKind.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([kind, count]) => `${count} ${kindWord(kind, count)}`)
      .join(', ');
  })();

  const chooseScope = (next: Scope): void => {
    setScope(next);
    closeMenu();
    setExpanded(true);
  };

  return (
    <section className="tch-lpanel" data-testid="ledger-panel" aria-label="What this conversation built">
      <div className="tch-lpanel__bar">
        <button
          type="button"
          ref={triggerRef}
          className="tch-lpanel__scope"
          data-testid="ledger-panel-scope"
          aria-haspopup="listbox"
          aria-expanded={menuOpen}
          aria-controls={menuId}
          title="Change what the panel shows"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {scopeLabel} <span aria-hidden>⌃</span>
        </button>
        <span className="tch-lpanel__summary" data-testid="ledger-panel-summary">
          {summary}
        </span>
        {/* ONE persistent toggle whose aria-expanded flips in place — not the
            tray's old two-button swap, which unmounted the focused control
            and dropped keyboard focus to body (Worker B's audit, S4 a6). */}
        <button
          type="button"
          className="tch-lpanel__toggle"
          data-testid="ledger-panel-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={expanded ? 'Collapse the ledger panel' : 'Expand the ledger panel'}
          onClick={() => setExpanded((open) => !open)}
        >
          <span aria-hidden>{expanded ? '⌄' : '⌃'}</span>
        </button>
      </div>
      {menuOpen && anchor ? createPortal(
        <div
          ref={menuRef}
          className="tch-pickmenu"
          style={anchor.style}
          role="listbox"
          id={menuId}
          aria-label="Panel scope"
          data-testid="ledger-scope-menu"
        >
          <button
            type="button"
            role="option"
            className="tch-pickmenu__opt"
            data-testid="ledger-scope-sessions"
            aria-selected={scope === 'sessions'}
            onClick={() => chooseScope('sessions')}
          >
            <span className="tch-pickmenu__text">
              <span className="tch-pickmenu__name">sessions</span>
            </span>
            <span className="tch-pickmenu__mark" aria-hidden>{scope === 'sessions' ? '✓' : ''}</span>
          </button>
          {entityScopes.map((id) => (
            <button
              key={id}
              type="button"
              role="option"
              className="tch-pickmenu__opt"
              data-testid="ledger-scope-entity"
              aria-selected={scope === id}
              onClick={() => chooseScope(id as EntityId)}
            >
              <span className="tch-pickmenu__text">
                <span className="tch-pickmenu__name">
                  {ledger.labels.get(id)?.title ?? truncateEntityId(id)}
                </span>
              </span>
              <span className="tch-pickmenu__mark" aria-hidden>{scope === id ? '✓' : ''}</span>
            </button>
          ))}
        </div>,
        anchor.host,
      ) : null}
      {expanded ? (
        <div className="tch-lpanel__body" id={bodyId} data-testid="ledger-panel-body">
          {scope === 'sessions' ? (
            <SessionRows rows={rows} onOpenEntity={onOpenEntity} />
          ) : (
            <LedgerTree
              model={ledger}
              filter={{ scope }}
              onOpenEntity={onOpenEntity}
              resolveEntity={resolveEntity}
              statusOf={statusOf}
            />
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The sessions scope — fleet rows, simplified to the panel's berth: kind
 * word + title + the verdict pill `homeRowOf` composed. Every row opens via
 * the same `onOpenEntity` as every other kind; the HOST routes a session to
 * its terminal (S5). View-only: opening is navigation, never retargeting.
 */
function SessionRows({
  rows,
  onOpenEntity,
}: {
  rows: readonly FleetRow[];
  onOpenEntity: (id: EntityId) => void;
}) {
  const sessions = rows.filter((row) => row.section === 'sessions' || row.section === 'unsettled');
  if (sessions.length === 0) {
    return <p className="tch-lpanel__empty">This conversation has spawned no sessions.</p>;
  }
  return (
    <ul className="tch-lpanel__rows">
      {sessions.map((row) => (
        <li key={row.id} className="tch-lpanel__rowitem">
          <button
            type="button"
            className="tch-lpanel__row"
            data-testid="ledger-panel-session"
            title={row.originSentence}
            onClick={() => onOpenEntity(row.id as EntityId)}
          >
            <span className="tch-lpanel__title" data-placeholder={row.titleIsPlaceholder || undefined}>
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
          </button>
        </li>
      ))}
    </ul>
  );
}
