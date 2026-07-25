/**
 * Drag/drop runtime for the grammar (Layer 6).
 *
 * `CollabDndProvider` mounts ONCE inside `CollabFacadeProvider` and hosts:
 *   - a @dnd-kit `DndContext` (pointer + keyboard sensors) with a `DragOverlay`
 *     ghost for dnd-kit sources (`DraggableEntity`),
 *   - a NATIVE HTML5 drag bridge: the app's existing sources (EntityChip,
 *     collection cards, anything writing `ENTITY_DRAG_MIME`) keep working —
 *     a document-level capture listener snapshots the payload at dragstart
 *     (the only moment the drag data store is readable) and a floating ghost
 *     label follows the pointer previewing the meaning BEFORE the drop,
 *   - the ambiguity drop menu (≤3 options, arrow-key + Enter/Escape),
 *   - the undo pill + ⌘Z / Ctrl+Z redeem binding.
 *
 * Both input paths — dnd-kit and native — funnel into the SAME
 * `resolveDrop` → `runPlacement` pipe, so a drop means one thing no matter
 * how it was performed. Targets wrap themselves with `useDropSurface`.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef,
  useState, type CSSProperties, type DragEvent as ReactDragEvent, type ReactNode,
} from 'react';
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor,
  useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { create } from 'zustand';
import { ENTITY_DRAG_MIME, useFacade, type EntityDragPayload } from '../entity';
import { registryFor } from '../registry';
import type { CollabFacade } from '../facade';
import type { EntitySummary } from '../types/contract';
import {
  resolveDrop, sourceRef, type DragSourceRef, type DropTargetRef, type PlacementOption,
} from './grammar';
import { runPlacement, type PlacementOutcome } from './execute';
import { activeUndo, runUndo, useUndoStore } from './undo';
import { CreationHost } from './create';
import { InteractionMenusHost } from './keyboard';

// ---------------------------------------------------------------------------
// shared drag state (a store so overlay, surfaces and tests see one truth)
// ---------------------------------------------------------------------------

export interface DropMenuState {
  source: DragSourceRef;
  target: DropTargetRef;
  options: PlacementOption[];
  x: number;
  y: number;
}

export interface DndState {
  /** The payload of the active drag (native or dnd-kit), if any. */
  drag: DragSourceRef | null;
  /** Whether the active drag runs through dnd-kit (else native HTML5). */
  viaKit: boolean;
  /** Surface currently hovered + its resolved meaning. */
  hover: { target: DropTargetRef; options: PlacementOption[] } | null;
  /** Pointer position for the native ghost label. */
  pointer: { x: number; y: number } | null;
  /** Open ambiguity menu, waiting for a choice. */
  menu: DropMenuState | null;
  startDrag: (source: DragSourceRef, viaKit: boolean) => void;
  setHover: (target: DropTargetRef, options: PlacementOption[]) => void;
  clearHover: (targetEntityId?: string) => void;
  setPointer: (x: number, y: number) => void;
  openMenu: (menu: DropMenuState) => void;
  closeMenu: () => void;
  endDrag: () => void;
}

export const useDndStore = create<DndState>()((set) => ({
  drag: null,
  viaKit: false,
  hover: null,
  pointer: null,
  menu: null,
  startDrag: (source, viaKit) => set({ drag: source, viaKit, hover: null }),
  setHover: (target, options) => set({ hover: { target, options } }),
  clearHover: (targetEntityId) => set((s) => (
    targetEntityId === undefined || s.hover?.target.entityId === targetEntityId
      ? { hover: null } : {}
  )),
  setPointer: (x, y) => set({ pointer: { x, y } }),
  openMenu: (menu) => set({ menu, drag: null, hover: null, pointer: null }),
  closeMenu: () => set({ menu: null }),
  endDrag: () => set({ drag: null, viaKit: false, hover: null, pointer: null }),
}));

// ---------------------------------------------------------------------------
// provider context (facade + commit pipe, so surfaces stay tiny)
// ---------------------------------------------------------------------------

interface DndApi {
  facade: CollabFacade;
  /** Resolve + commit a drop: 1 option commits, 2–3 open the menu. */
  drop: (source: DragSourceRef, target: DropTargetRef, at: { x: number; y: number }) => void;
  /** Commit one explicit option (menu choice / keyboard equivalents). */
  commit: (source: DragSourceRef, target: DropTargetRef, option: PlacementOption) => Promise<PlacementOutcome>;
}

const DndApiContext = createContext<DndApi | null>(null);

export function useDndApi(): DndApi {
  const api = useContext(DndApiContext);
  if (!api) throw new Error('useDndApi must be used inside <CollabDndProvider>');
  return api;
}

export interface CollabDndProviderProps {
  /** Defaults to the surrounding CollabFacadeProvider's facade. */
  facade?: CollabFacade;
  children: ReactNode;
  /** Injectable clock for the undo pill/binding (tests). */
  now?: () => number;
}

export function CollabDndProvider({ facade: facadeProp, children, now }: CollabDndProviderProps) {
  const contextFacade = useFacade();
  const facade = facadeProp ?? contextFacade;

  const commit = useCallback(
    (source: DragSourceRef, target: DropTargetRef, option: PlacementOption) =>
      runPlacement(facade, { source, target, option }),
    [facade],
  );

  const drop = useCallback((source: DragSourceRef, target: DropTargetRef, at: { x: number; y: number }) => {
    const options = resolveDrop(source, target);
    const store = useDndStore.getState();
    if (options.length === 0) { store.endDrag(); return; }
    if (options.length === 1) {
      store.endDrag();
      void commit(source, target, options[0]);
      return;
    }
    store.openMenu({ source, target, options, x: at.x, y: at.y });
  }, [commit]);

  const api = useMemo<DndApi>(() => ({ facade, drop, commit }), [facade, drop, commit]);

  // ---- native HTML5 bridge -------------------------------------------------
  // dragstart is the ONE moment the drag data store is readable; snapshot the
  // payload so surfaces can preview meaning during dragover (where getData
  // returns '' by spec). Capture phase: sources are spread across the app.
  useEffect(() => {
    const onDragStart = (e: globalThis.DragEvent): void => {
      const raw = e.dataTransfer?.getData(ENTITY_DRAG_MIME);
      if (!raw) return;
      try {
        const payload = JSON.parse(raw) as EntityDragPayload;
        if (payload && typeof payload.entityId === 'string') {
          useDndStore.getState().startDrag(
            { entityId: payload.entityId, kind: payload.kind, title: payload.title },
            false,
          );
        }
      } catch { /* not ours */ }
    };
    const onDragOver = (e: globalThis.DragEvent): void => {
      if (useDndStore.getState().drag) useDndStore.getState().setPointer(e.clientX, e.clientY);
    };
    const onDragEnd = (): void => { useDndStore.getState().endDrag(); };
    document.addEventListener('dragstart', onDragStart, true);
    document.addEventListener('dragover', onDragOver, true);
    document.addEventListener('dragend', onDragEnd, true);
    document.addEventListener('drop', onDragEnd, true);
    return () => {
      document.removeEventListener('dragstart', onDragStart, true);
      document.removeEventListener('dragover', onDragOver, true);
      document.removeEventListener('dragend', onDragEnd, true);
      document.removeEventListener('drop', onDragEnd, true);
    };
  }, []);

  // ---- ⌘Z / Ctrl+Z — redeem the held undo token ---------------------------
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.key === 'z' || e.key === 'Z') || !(e.metaKey || e.ctrlKey) || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!activeUndo(now)) return;
      e.preventDefault();
      void runUndo(facade, now);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [facade, now]);

  // ---- dnd-kit context for DraggableEntity sources ------------------------
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  const onKitDragStart = (e: DragStartEvent): void => {
    const source = e.active.data.current?.source as DragSourceRef | undefined;
    if (source) useDndStore.getState().startDrag(source, true);
  };
  const onKitDragOver = (e: DragOverEvent): void => {
    const store = useDndStore.getState();
    const source = store.drag;
    const target = e.over?.data.current?.target as DropTargetRef | undefined;
    if (!source || !target) { store.clearHover(); return; }
    store.setHover(target, resolveDrop(source, target));
  };
  const onKitDragEnd = (e: DragEndEvent): void => {
    const store = useDndStore.getState();
    const source = store.drag;
    const target = e.over?.data.current?.target as DropTargetRef | undefined;
    if (source && target) {
      const rect = e.over?.rect;
      drop(source, target, { x: rect ? rect.left + rect.width / 2 : 0, y: rect ? rect.top + rect.height / 2 : 0 });
    } else {
      store.endDrag();
    }
  };

  return (
    <DndApiContext.Provider value={api}>
      <DndContext
        sensors={sensors}
        onDragStart={onKitDragStart}
        onDragOver={onKitDragOver}
        onDragEnd={onKitDragEnd}
        onDragCancel={() => useDndStore.getState().endDrag()}
      >
        {children}
        <KitGhostOverlay />
      </DndContext>
      <NativeGhostLabel />
      <DropMenu />
      <UndoPill now={now} />
      <CreationHost />
      <InteractionMenusHost />
    </DndApiContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// drop surfaces
// ---------------------------------------------------------------------------

export interface DropSurfaceValue {
  /** Spread onto the surface's DOM element (native HTML5 path). */
  domProps: {
    onDragOver: (e: ReactDragEvent) => void;
    onDragLeave: (e: ReactDragEvent) => void;
    onDrop: (e: ReactDragEvent) => void;
    'data-cv2-surface': string;
    'data-cv2-drop-active'?: 'true';
  };
  /** Ref for the dnd-kit droppable path (optional to wire). */
  setNodeRef: (node: HTMLElement | null) => void;
  /** A drag is over this surface and the grammar accepts it. */
  isOver: boolean;
  /** The meaning(s) the hovered drag would commit to (isOver only). */
  options: PlacementOption[];
}

/**
 * Wire a DOM element as a grammar drop target. `target` carries the surface
 * kind + the concrete entity; pass null to render an inert surface.
 */
export function useDropSurface(target: DropTargetRef | null): DropSurfaceValue {
  const { drop } = useDndApi();
  const hover = useDndStore((s) => s.hover);

  const { setNodeRef } = useDroppable({
    id: target ? `${target.surface}:${target.entityId}` : 'cv2-drop-disabled',
    data: target ? { target } : undefined,
    disabled: !target,
  });

  const isOver = !!(target && hover
    && hover.target.entityId === target.entityId
    && hover.target.surface === target.surface
    && hover.options.length > 0);
  const options = isOver && hover ? hover.options : [];

  const onDragOver = useCallback((e: ReactDragEvent): void => {
    if (!target) return;
    if (!Array.from(e.dataTransfer.types).includes(ENTITY_DRAG_MIME)) return;
    const source = useDndStore.getState().drag;
    if (!source) return;
    const resolved = resolveDrop(source, target);
    if (resolved.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'link';
    useDndStore.getState().setHover(target, resolved);
  }, [target]);

  const onDragLeave = useCallback((): void => {
    if (target) useDndStore.getState().clearHover(target.entityId);
  }, [target]);

  const onDrop = useCallback((e: ReactDragEvent): void => {
    if (!target) return;
    const raw = e.dataTransfer.getData(ENTITY_DRAG_MIME);
    let source: DragSourceRef | null = useDndStore.getState().drag;
    if (raw) {
      try {
        const payload = JSON.parse(raw) as EntityDragPayload;
        if (payload && typeof payload.entityId === 'string') {
          source = { entityId: payload.entityId, kind: payload.kind, title: payload.title };
        }
      } catch { /* keep snapshot */ }
    }
    if (!source) return;
    e.preventDefault();
    e.stopPropagation();
    drop(source, target, { x: e.clientX, y: e.clientY });
  }, [target, drop]);

  return {
    domProps: {
      onDragOver,
      onDragLeave,
      onDrop,
      'data-cv2-surface': target?.surface ?? 'none',
      ...(isOver ? { 'data-cv2-drop-active': 'true' as const } : {}),
    },
    setNodeRef,
    isOver,
    options,
  };
}

/**
 * Convenience wrapper: a plain element wired as a drop surface, with the
 * ghost-label semantics handled. Hosts that need custom markup use
 * `useDropSurface` directly.
 */
interface DropSurfaceProps {
  target: DropTargetRef | null;
  children?: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'span' | 'li';
}

export function DropSurface(props: DropSurfaceProps) {
  // Graceful without a provider (gallery, screen unit tests, partial hosts):
  // render the same wrapper, just inert. Hook-rules-safe via the split — the
  // active variant is a separate component, so hook order never varies here.
  const api = useContext(DndApiContext);
  const { children, className, as: Tag = 'div' } = props;
  if (!api) {
    return <Tag className={`cv2-dropsurface${className ? ` ${className}` : ''}`}>{children}</Tag>;
  }
  return <ActiveDropSurface {...props} />;
}

function ActiveDropSurface({ target, children, className, as: Tag = 'div' }: DropSurfaceProps) {
  const { domProps, setNodeRef, isOver } = useDropSurface(target);
  return (
    <Tag
      ref={setNodeRef as never}
      className={`cv2-dropsurface${isOver ? ' cv2-dropsurface--over' : ''}${className ? ` ${className}` : ''}`}
      {...domProps}
    >
      {children}
    </Tag>
  );
}

/**
 * dnd-kit drag source wrapper for hosts that opt into pointer/keyboard
 * sensor drags. The app's chips/cards keep their native HTML5 drag — both
 * end in the same resolve/commit pipe.
 */
export function DraggableEntity({ entity, children, className }: {
  entity: EntitySummary;
  children: ReactNode;
  className?: string;
}) {
  const source = sourceRef(entity);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `drag:${entity.id}`,
    data: { source },
  });
  return (
    <span
      ref={setNodeRef}
      className={`cv2-dragsource${isDragging ? ' cv2-dragsource--active' : ''}${className ? ` ${className}` : ''}`}
      {...attributes}
      {...listeners}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// overlays: ghost labels, drop menu, undo pill
// ---------------------------------------------------------------------------

/** Ghost text for the current hover — what the drop WILL mean. */
function ghostText(hover: DndState['hover']): string | null {
  if (!hover || hover.options.length === 0) return null;
  return hover.options.length === 1
    ? hover.options[0].ghost
    : `${hover.options[0].ghost} · ${hover.options.length} options`;
}

function KitGhostOverlay() {
  const drag = useDndStore((s) => s.drag);
  const viaKit = useDndStore((s) => s.viaKit);
  const hover = useDndStore((s) => s.hover);
  const ghost = ghostText(hover);
  return (
    <DragOverlay dropAnimation={null}>
      {drag && viaKit ? (
        <span className="cv2-ghostchip" data-testid="dnd-kit-ghost">
          <span aria-hidden="true">{registryFor(drag.kind).glyph}</span> {drag.title}
          {ghost && <span className="cv2-ghostlabel">{ghost}</span>}
        </span>
      ) : null}
    </DragOverlay>
  );
}

/** Floating meaning-preview for NATIVE drags (browser draws its own drag image). */
function NativeGhostLabel() {
  const drag = useDndStore((s) => s.drag);
  const viaKit = useDndStore((s) => s.viaKit);
  const hover = useDndStore((s) => s.hover);
  const pointer = useDndStore((s) => s.pointer);
  const ghost = ghostText(hover);
  if (!drag || viaKit || !ghost) return null;
  const style: CSSProperties = pointer
    ? { position: 'fixed', left: pointer.x + 14, top: pointer.y + 18 }
    : { position: 'fixed', left: 0, top: 0, visibility: 'hidden' };
  return (
    <span className="cv2-ghostlabel cv2-ghostlabel--floating" style={style} data-testid="ghost-label" role="status">
      {ghost}
    </span>
  );
}

/** The ambiguity menu — max 3 explicit meanings, keyboard-first. */
export function DropMenu() {
  const menu = useDndStore((s) => s.menu);
  const { commit } = useDndApi();
  const [index, setIndex] = useState(0);
  const firstRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => { setIndex(0); }, [menu]);
  useEffect(() => { if (menu) firstRef.current?.focus(); }, [menu]);

  if (!menu) return null;

  const choose = (option: PlacementOption): void => {
    useDndStore.getState().closeMenu();
    void commit(menu.source, menu.target, option);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); useDndStore.getState().closeMenu(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, menu.options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(menu.options[index]); }
  };

  return (
    <div
      className="cv2-dropmenu"
      role="menu"
      aria-label="Choose what this drop means"
      data-testid="drop-menu"
      style={{ position: 'fixed', left: menu.x, top: menu.y }}
      onKeyDown={onKeyDown}
    >
      {menu.options.map((option, i) => (
        <button
          key={`${option.intent}-${option.label}`}
          ref={i === 0 ? firstRef : undefined}
          type="button"
          role="menuitem"
          className={`cv2-dropmenu__item${i === index ? ' cv2-dropmenu__item--active' : ''}`}
          onMouseEnter={() => setIndex(i)}
          onClick={() => choose(option)}
        >
          <span className="cv2-dropmenu__label">{option.label}</span>
          <span className="cv2-dropmenu__ghost">{option.ghost}</span>
        </button>
      ))}
    </div>
  );
}

/** "Attached: X → Y — Undo" pill; hides itself when the token's TTL lapses. */
export function UndoPill({ now = Date.now }: { now?: () => number }) {
  const entry = useUndoStore((s) => s.entry);
  const facade = useDndApi().facade;
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!entry) return undefined;
    const remaining = entry.expiresAt - now();
    if (remaining <= 0) return undefined;
    const t = setTimeout(() => forceTick((n) => n + 1), remaining + 10);
    return () => clearTimeout(t);
  }, [entry, now]);

  if (!entry || entry.expiresAt <= now()) return null;

  return (
    <div className="cv2-undopill" role="status" data-testid="undo-pill">
      <span className="cv2-undopill__label">{entry.label}</span>
      <button
        type="button"
        className="cv2-actionbtn cv2-actionbtn--primary"
        onClick={() => { void runUndo(facade, now); }}
      >
        Undo
      </button>
      <button
        type="button"
        className="cv2-undopill__x"
        aria-label="Dismiss undo"
        onClick={() => useUndoStore.getState().clear()}
      >
        ×
      </button>
    </div>
  );
}
