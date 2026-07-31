/**
 * The narrow port onto A1a's `src/stores/navStore.ts`.
 *
 * Shell binds to THIS interface, not to the store module, for one reason worth
 * stating: LLD §1.1 fixes the import DAG as
 * `domain ← {routes, stores, keyboard} ← {panels, collections} ← views ← shell`,
 * and §15 enforces it. Shell may import the store (it is downstream), but
 * declaring the surface here keeps the geometry engine and its tests free of
 * any store dependency at all — `geometry.ts` imports nothing from `stores/`,
 * which is what makes the demotion loop testable as pure arithmetic.
 *
 * The shape below is A1a's stated surface verbatim ([a1a->A1b 1]). When the
 * real store lands this file becomes a type alias over it rather than a second
 * definition; it is a binding target, never a second implementation.
 *
 * DIRECTION (A1a's correction, adopted): the store NEVER calls geometry.
 * `centerWidth` is a measurement only the shell layer can take, so the shell
 * runs the law and hands the store the settled RESULT via `applyNormalization`.
 */
import type { EntityId } from '@tm8/contract';

export type PanelTab = 'content' | 'discussion' | 'connections' | 'activity';
export type ContentSurface = 'terminal' | 'chat';
export type PanelHost = 'stack' | 'pinned' | 'peek' | 'z4';

export interface NavPanelState {
  /** Bottom → top, matching the `p=` encoding (§6). */
  stack: EntityId[];
  /** Pin order, left → right. */
  pinned: EntityId[];
}

export type PinOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Only the members the shell actually drives. A1a's store exposes more
 * (hydrate/navigate/setTab/setSession/…); binding to the subset keeps the
 * coupling visible and the test doubles small.
 */
export interface NavPort extends NavPanelState {
  /** Opens an entity onto the stack. Dedupes; raises an already-hosted id. */
  push(id: EntityId): void;
  /** Esc: stack top only, never a pin. */
  pop(): void;
  close(id: EntityId): void;
  /**
   * Store-side guard is ONLY the state-pure invariant `pinned.length < 3`.
   * The WIDTH refusal is the shell's — check `admitPin` BEFORE calling, and do
   * not call this when the predicate refuses (A1a's stated contract).
   */
  pin(id: EntityId): PinOutcome;
  unpin(id: EntityId): void;
  /** Z4 — removes the id from BOTH sets. */
  promote(id: EntityId): void;
  /**
   * THE seam for the demotion loop: hand over the settled result. Idempotent,
   * and the call that emits exactly ONE debounced canonical `replaceState` per
   * settle (§5.3/§6). A result equal to current state is a no-op that writes no
   * history — which is what makes it safe to call on every resize frame.
   */
  applyNormalization(next: NavPanelState): void;
  /** Viewer-local nested Content surface. Implementations mirror with replace-history. */
  surfaceOf?(id: EntityId): ContentSurface | null;
  setContentSurface?(id: EntityId, surface: ContentSurface): void;
}

/** `V` — kept identical to A1a's `selectVisibleCount` so the halves cannot drift. */
export function selectVisibleCount(state: NavPanelState): number {
  return state.pinned.length + (state.stack.length > 0 ? 1 : 0);
}

/** Render order: pins left → right in pin order, then the stack's top panel. */
export function selectPanelIds(state: NavPanelState): EntityId[] {
  const top = state.stack[state.stack.length - 1];
  return top === undefined ? [...state.pinned] : [...state.pinned, top];
}
