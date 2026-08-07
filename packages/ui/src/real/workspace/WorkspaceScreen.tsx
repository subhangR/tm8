/**
 * The workspace — tasks │ terminal │ resources, at `#/s/{space}/workspace`.
 *
 * WHERE THIS SITS. The four panes the product means are P1 the shell's icon rail
 * (far left, already built and untouched here), then THREE columns inside this
 * one center view: tasks, the live agent, and the session/resource panel. The
 * shell's own `LeftRail` is space navigation and its `PanelStack` is the Z3
 * entity peek — neither is a workspace pane. So the whole workspace is one
 * registered view in `CenterHost` (blueprint §2).
 *
 * WHY IT IS ITS OWN ROUTE RATHER THAN AN OVERRIDE OF `tasks`. An earlier cut
 * registered this as `tasks`, which worked — `extraViews` merges last — but it
 * silently REPLACED the module's own Tasks screen, so the snapshot shipped a
 * screen no route could reach. The workspace now has its own `ViewName`, its own
 * rail entry and its own hash, and `#/s/{space}/tasks` still opens the module's
 * screen exactly as before (asserted in the browser, not assumed).
 *
 * That cost four small shell touches, each marked `⚠ tm8 addition` for the drift
 * ledger: `stores/nav.ts` (VIEWS), `shell/LeftRail.tsx` (RAIL_SECTIONS),
 * `shell/icons.tsx` (the glyph), and `subsystems/palette/actions.ts` — the last
 * one not by choice but because `VIEW_LABELS` is an exhaustive
 * `Record<ViewName, string>`, so adding a view without a label is a compile
 * error rather than a palette entry reading "undefined".
 *
 * LANE BOUNDARIES, and they are real files. This lane owns the layout and the
 * left column, and it owns the SELECTION STATE the other two read: which task is
 * current and which session is open. The right column is Lane B's
 * `ResourcePanel` and the center is Lane C's `CenterPane` — both imported, never
 * edited. Neither holds a copy of the selection, so the three columns cannot
 * disagree about what the user is looking at.
 *
 * WHAT IS NOT DURABLE, and why that is stated rather than hidden. The selected
 * task and the open session live in component state, not the route. The hash
 * grammar only round-trips `{view}/{entityId}` for the views in
 * `ENTITY_FOCUSED_VIEWS` (`channel`, `sessions`), and `workspace` is
 * deliberately not one of them: it focuses TWO things at once (a task and a
 * session), which that single-slot grammar cannot express, and adding it as an
 * entity-focused view would make `#/s/{space}/workspace/{id}` ambiguous about
 * which of the two the id names. Widening the grammar to carry both is a
 * nav-store change for a later wave. Until then a reload lands on the workspace
 * with nothing selected, which is honest rather than wrong.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShellViewProps } from '../../collab-v2/shell';
import { useNavStore } from '../../collab-v2/stores/nav';
import type { EntityId, SpaceSummary } from '../../collab-v2/types/contract';
import type { RealFacade } from '../RealFacade';
import { SESSION_SPAWNED_EVENT, type SessionSpawnedDetail } from '../tm8Kinds';
import { CenterPane } from './CenterPane';
import { IconRail } from './IconRail';
import { ProjectTabBar, type ProjectTab } from './ProjectTabBar';
import { ResourcePanel } from './ResourcePanel';
import { TaskPanel } from './TaskPanel';
import './workspace.css';

/**
 * THE CENTER-PANE CONTRACT — published here, implemented by Lane C's
 * `CenterPane.tsx`, and kept here rather than imported from it so the workspace
 * states what it passes down instead of inheriting whatever the pane happens to
 * accept. Lane C's props widened the two callbacks to optional; a required value
 * is assignable to an optional slot, so this stays the stricter side of the seam.
 *
 * The pane owns the terminal, the composer and its own tabs. `sessionId` names
 * which session is ACTIVE; it does not describe how many terminals exist.
 *
 * ⚠ THIS COMMENT USED TO ASSERT A RETIRED INVARIANT — recorded rather than
 * quietly overwritten, because the retraction is the useful part.
 *
 * It read: "exactly ONE terminal is mounted in the whole workspace, keyed by
 * `sessionId` so switching tears down the old xterm AND its socket — past the
 * browser's GPU-context cap, a terminal per row takes the entire tab down with
 * it (blueprint §9)." Every clause of that is now false or moot:
 *
 *  - the GPU-context cap was a WebGL property, and this workspace renders
 *    DOM-only, so the reason the rule existed no longer applies;
 *  - "one terminal, torn down on switch" IS `mount-only-active`, which maestro
 *    shipped and then deliberately REVERTED — it leaked xterms still held in
 *    module-level maps, and flashed blank-then-replay on every switch, in a UI
 *    where flipping between agents is the core gesture.
 *
 * THE STAMPED MODEL is a bounded mounted-LRU: at most `k` mounted xterms
 * (k=4 to start, one dialable constant), evict least-recently-viewed with FULL
 * dispose, socket-suspend the mounted-but-hidden ones, keep the top 3 sockets
 * warm, and take a full-ring replay at offset 0 when an EVICTED session
 * returns. Mount count and warm-socket count are TWO SEPARATE DIALS; reading
 * the warm count as the mount bound reproduces the RAM-growth failure maestro
 * already shipped once. See docs/ui/audit/TERMINAL-TRANSPLANT-NOTES.md §2.
 *
 * A stale invariant in a comment is not a cosmetic defect: one sentence in
 * `ptyTransport.ts` claiming byte-identity with maestro is what nearly let four
 * streaming gaps ship today. Lane C found this one by reading rather than
 * trusting, which is the only way these get caught.
 */
export interface CenterPaneProps {
  facade: RealFacade;
  spaceId: string;
  /** The `work_session` whose live terminal fills the pane. `null` = none open. */
  sessionId: EntityId | null;
  /** The task the left column has selected — the pane may show its thread. */
  taskId: EntityId | null;
  /** The pane asks to close what it has open (terminate, or the close chrome). */
  onCloseSession: () => void;
  /** The pane opens a different session (e.g. from a task's working agent). */
  onOpenSession: (sessionId: EntityId) => void;
}

/**
 * Default column widths, MEASURED off the running maestro app rather than
 * chosen — `.appLeftPanelContent` is 280px at x=56 (the 56px sits under the
 * shell's own icon rail, which is why the task column is 280 and not 336) and
 * the resource panel is 319.
 *
 * This is the transplant's standing rule in miniature: where maestro already
 * has a number, that number is the answer. A default that is 20px off is not a
 * rounding difference, it is the panel not being the panel.
 *
 * Both were reported by the lanes measuring their own reference crops, which is
 * the check working — neither number came from this file's judgement.
 */
const LEFT_DEFAULT = 280, RIGHT_DEFAULT = 319;

/** Resize bounds, in px. Narrow enough to be useless is worse than not resizing. */
const LEFT_MIN = 240, LEFT_MAX = 560, RIGHT_MIN = 260, RIGHT_MAX = 620;
const STORAGE_KEY = 'tm8.workspace.columns';

interface Columns { left: number; right: number }

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Column widths survive a reload because a workspace the user re-sizes every
 * morning is a workspace they are fighting. localStorage rather than the route:
 * this is a preference, not an address, and it should not travel in a shared
 * link. A malformed or absent entry falls back to the defaults rather than
 * throwing — private-mode browsers deny `localStorage` outright.
 */
function loadColumns(): Columns {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Columns>;
      return {
        left: clamp(Number(parsed.left) || LEFT_DEFAULT, LEFT_MIN, LEFT_MAX),
        right: clamp(Number(parsed.right) || RIGHT_DEFAULT, RIGHT_MIN, RIGHT_MAX),
      };
    }
  } catch { /* fall through to defaults */ }
  return { left: LEFT_DEFAULT, right: RIGHT_DEFAULT };
}

/**
 * The spaces that fill maestro's project tab bar.
 *
 * WHY SPACES AND NOT `facade.listProjects()`, because the naming actively
 * misleads here. maestro's "project" is BOTH the working directory and the
 * top-level navigational container; tm8 splits those in two — a SPACE is the
 * collaboration container the hash addresses (`#/s/{id}`), while a PROJECT is a
 * linked working directory, a resource rather than an entity (AM-2 §1 / T-D17).
 * The tab bar is the top-level switcher, and tm8's top-level switcher is the
 * space. Feeding it `listProjects()` would put working directories in a bar
 * that navigates, which is a different concept wearing the right word.
 *
 * Read once rather than polled: the space list is not live data, and a fourth
 * interval behind a bar that changes when someone creates a space is cost with
 * no reader.
 */
function useSpaceTabs(facade: RealFacade): ProjectTab[] {
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  useEffect(() => {
    let alive = true;
    // FEATURE-DETECTED, not assumed, and that is not defensive padding — it was
    // a real crash. Making the tab bar's read unconditional meant any facade
    // without `listSpaces` threw during the mount effect and took the ENTIRE
    // workspace down with it: no task panel, no terminal, no resource panel,
    // because a decorative strip could not name the spaces. The tab bar is the
    // least important thing on this screen and it must fail like it.
    const listSpaces = (facade as Partial<RealFacade>).listSpaces?.bind(facade);
    if (!listSpaces) return;
    void Promise.resolve(listSpaces()).then(
      (list) => { if (alive) setSpaces(list ?? []); },
      // Same reasoning for a rejected read: an empty bar, and the panels below
      // keep their own error surfaces.
      () => undefined,
    );
    return () => { alive = false; };
  }, [facade]);

  // `count`, `workingCount` and `needsInput` are deliberately OMITTED, not
  // zeroed. tm8 projects none of them per space, and Lane C's markup omits the
  // chip when the field is absent — whereas a 0 would render as a confident
  // "no sessions here", which is a claim this node cannot make.
  return spaces.map((s) => ({ id: s.id, name: s.name }));
}

/**
 * THE DRAG CONTRACT THE TERMINAL LISTENS ON — verbatim from maestro's
 * `hooks/useAppLayoutResizing.ts`, names included.
 *
 * While a panel is being dragged, the terminal must NOT re-fit: `FitAddon`
 * would recompute cols/rows on every drag frame and ship a PTY resize with
 * each one. The terminal instead stretches via CSS during the drag and
 * reflows ONCE on drag-end. It detects the drag by looking for these classes
 * on `<html>` and waits for this event — so a resizer that does not raise them
 * silently costs a resize storm on every drag.
 *
 * A plain `Event`, not a `CustomEvent`: maestro dispatches
 * `new Event("maestro:panel-resize-end")` and the terminal's listener reads no
 * detail. Matching the constructor keeps the two interchangeable.
 */
const RESIZE_CLASS = {
  left: 'maestro-sidebar-resizing',
  right: 'right-panel-resizing',
} as const;
const RESIZE_END_EVENT = 'maestro:panel-resize-end';

/**
 * The resize grip. Pointer capture rather than window listeners: the drag keeps
 * tracking when the cursor leaves the 6px strip (which it does immediately), and
 * it cannot leak a listener if the component unmounts mid-drag.
 */
function Resizer({ side, onDrag, label }: {
  side: 'left' | 'right';
  onDrag: (deltaX: number) => void;
  label: string;
}) {
  const last = useRef(0);
  const dragging = useRef(false);

  const beginDrag = (clientX: number) => {
    dragging.current = true;
    last.current = clientX;
    document.documentElement.classList.add(RESIZE_CLASS[side]);
  };

  /**
   * Keyboard resize: a focusable separator that cannot be operated from the
   * keyboard is decoration. Each step reflows the terminal immediately via the
   * same end-event the pointer path fires — no drag class is latched, so a
   * keypress is a complete move rather than an open drag.
   */
  const KEY_STEP = 16;
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === 'ArrowLeft' ? -KEY_STEP : e.key === 'ArrowRight' ? KEY_STEP : 0;
    if (delta === 0) return;
    e.preventDefault();
    onDrag(delta);
    window.dispatchEvent(new Event(RESIZE_END_EVENT));
  };

  /**
   * Idempotent, because it is called from pointerup, pointercancel AND unmount,
   * and firing the end-event twice would make the terminal reflow twice.
   */
  const endDrag = () => {
    if (!dragging.current) return;
    dragging.current = false;
    document.documentElement.classList.remove(RESIZE_CLASS[side]);
    window.dispatchEvent(new Event(RESIZE_END_EVENT));
  };

  // A drag interrupted by an unmount would otherwise leave the class latched on
  // <html> forever, and the terminal would never fit again — a permanently
  // wrong-sized PTY caused by a component that is no longer on screen. The
  // class lives on a node this component does not own, so cleaning it up is
  // this component's job.
  useEffect(() => endDrag, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="ws-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      data-side={side}
      data-testid={`ws-resizer-${side}`}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        beginDrag(e.clientX);
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const delta = e.clientX - last.current;
        last.current = e.clientX;
        if (delta !== 0) onDrag(delta);
      }}
      onPointerUp={(e) => { e.currentTarget.releasePointerCapture(e.pointerId); endDrag(); }}
      // pointercancel fires when the browser takes the pointer away (a system
      // gesture, a context menu). Without it the class latches and the drag
      // never "ends" as far as the terminal is concerned.
      onPointerCancel={(e) => { e.currentTarget.releasePointerCapture(e.pointerId); endDrag(); }}
    />
  );
}

export function WorkspaceScreen({ facade, spaceId, view, onNavigate }: ShellViewProps) {
  // The shell hands the module's `CollabFacade`; the tm8 implementation behind
  // it carries the execution family. This screen is only ever registered by the
  // real entry (main.tsx), so the widening is sound where a module screen's
  // would not be — the same assumption `SessionsScreen` documents.
  const real = facade as unknown as RealFacade;

  const [selectedTaskId, setSelectedTaskId] = useState<EntityId | null>(null);
  const [openSessionId, setOpenSessionId] = useState<EntityId | null>(null);
  const [cols, setCols] = useState<Columns>(loadColumns);
  const spaceTabs = useSpaceTabs(real);

  // Space switching is the one navigation `ShellViewProps` does not expose —
  // it hands `onNavigate` for views and nothing for spaces, because no module
  // screen switches space from inside itself. The workspace does, because
  // maestro's tab bar is exactly that control. Reached through the store the
  // shell already owns rather than a second source of truth, the same way
  // `SpawnDialog` reaches `setView`.
  const setSpace = useNavStore((s) => s.setSpace);
  // The palette is the shell's own; reaching it through the store is the same
  // seam `setSpace` uses. `onNavigate('settings')` follows the IconRail pattern
  // — 'settings' is a registered ViewName, so this is a view switch, not a new
  // surface.
  const openPalette = useNavStore((s) => s.openPalette);

  useEffect(() => {
    const onSessionSpawned = (event: Event) => {
      const { sessionId } = (event as CustomEvent<SessionSpawnedDetail>).detail;
      if (sessionId) setOpenSessionId(sessionId);
    };
    window.addEventListener(SESSION_SPAWNED_EVENT, onSessionSpawned);
    return () => window.removeEventListener(SESSION_SPAWNED_EVENT, onSessionSpawned);
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cols)); }
    catch { /* a browser that refuses storage still gets a working workspace */ }
  }, [cols]);

  const dragLeft = useCallback((dx: number) => {
    setCols((c) => ({ ...c, left: clamp(c.left + dx, LEFT_MIN, LEFT_MAX) }));
  }, []);
  // The right column grows as the cursor moves LEFT, so the delta inverts.
  const dragRight = useCallback((dx: number) => {
    setCols((c) => ({ ...c, right: clamp(c.right - dx, RIGHT_MIN, RIGHT_MAX) }));
  }, []);

  const centerProps: CenterPaneProps = {
    facade: real,
    spaceId,
    sessionId: openSessionId,
    taskId: selectedTaskId,
    onCloseSession: () => setOpenSessionId(null),
    onOpenSession: setOpenSessionId,
  };

  return (
    <div className="ws-app" data-testid="workspace-screen">
      {/*
        maestro's window shape: the project bar spans the full width above
        everything, then a row of rail + panes beneath it. The shell renders
        this view full-bleed (ShellLayout `fullBleedViews`) precisely so this
        skeleton is the whole window rather than a box inside other chrome.
      */}
      <ProjectTabBar
        projects={spaceTabs}
        activeProjectId={spaceId}
        onSelectProject={setSpace}
        onOpenSettings={() => onNavigate('settings')}
        onOpenCommandPalette={openPalette}
      />

      <div className="ws-app__body">
        <IconRail
          activeSection={view}
          onSectionChange={(next) => onNavigate(next)}
        />

        <div
          className="ws"
          data-testid="workspace-panes"
          style={{ '--ws-left': `${cols.left}px`, '--ws-right': `${cols.right}px` } as React.CSSProperties}
        >
          <TaskPanel
            facade={real}
            spaceId={spaceId}
            selectedTaskId={selectedTaskId}
            onSelectTask={setSelectedTaskId}
          />

          <Resizer side="left" label="Resize the task panel" onDrag={dragLeft} />

          <div className="ws-center" data-testid="workspace-center">
            <CenterPane {...centerProps} />
          </div>

          <Resizer side="right" label="Resize the resource panel" onDrag={dragRight} />

          <ResourcePanel
            facade={real}
            spaceId={spaceId}
            openSessionId={openSessionId}
            onOpenSession={setOpenSessionId}
          />
        </div>
      </div>
    </div>
  );
}
