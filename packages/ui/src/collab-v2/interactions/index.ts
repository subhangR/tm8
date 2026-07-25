/**
 * Interactions barrel (Layer 6) — the grammar of putting things places.
 *
 * Hosts need:
 *   <CollabDndProvider>   — once, inside CollabFacadeProvider (renders the
 *                           drag overlay, drop menu, undo pill, creation
 *                           modal and keyboard menus)
 *   useDropSurface(ref)   — wrap any element as a grammar drop target
 *   openCreation / CreatePlus / seedFor* — context-seeded "+"
 *   promoteReactionsSlot  — Thread reactionsSlot adapter with ↗ Promote
 *   openMoveTo / openLink — keyboard parity for reparent + link drops
 */
import './interactions.css';

export {
  GRAMMAR_TABLE, MAX_DROP_OPTIONS, resolveDrop, rowFor, sourceRef, targetRef,
  surfaceForEntity,
  type DragSourceRef, type DropSurfaceKind, type DropTargetRef,
  type GrammarRow, type PlacementOption,
} from './grammar';
export {
  runPlacement, applyEverywhere,
  type PlacementOutcome, type PlacementRun,
} from './execute';
export {
  UNDO_TTL_MS, activeUndo, registerUndo, runUndo, useUndoStore,
  type UndoEntry,
} from './undo';
export {
  CollabDndProvider, DraggableEntity, DropMenu, DropSurface, UndoPill,
  useDndApi, useDndStore, useDropSurface,
  type CollabDndProviderProps, type DndState, type DropMenuState,
  type DropSurfaceValue,
} from './dnd';
export {
  CreatePlus, CreationHost, CreationModal, contentFromValues, createFromSeed,
  openCreation, seedForChannel, seedForParent, useCreationStore,
  type CreatePlusProps, type CreateSeed, type CreationModalProps,
  type CreationRequest,
} from './create';
export {
  PROMOTE_TARGETS, PromoteAction, PromoteMenu, promoteMessage,
  promoteReactionsSlot, quoteBlock, quoteExcerpt,
  type PromoteMenuProps, type PromoteResult,
} from './promote';
export {
  InteractionMenusHost, LinkMenu, MoveToMenu, keyboardOptionsFor, openLink,
  openMoveTo, useInteractionMenuStore,
} from './keyboard';
