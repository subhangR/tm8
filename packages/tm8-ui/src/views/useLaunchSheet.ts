/**
 * The launch sheet's slot — and the TWO MANDATORY OBLIGATIONS that ride with
 * it (A1a's findings, ruled by fe-coordinator).
 *
 * The sheet lives in transient client state, never the URL (§11: a shared
 * launch link must not open a half-configured spawn surface on someone else's
 * screen). It is deliberately NOT in navStore: the stack stays pure EntityIds,
 * because the codec serialises stack entries into `p=` and a pseudo-id would
 * hydrate on a stranger's reload as a panel for an entity that does not exist.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntityId } from '@tm8/contract';

export interface LaunchSheetState {
  /** The entity being configured, or null when closed. */
  subjectId: EntityId | null;
  open(subjectId: EntityId): void;
  close(): void;
  /**
   * OBLIGATION 1 — Esc must not fall through.
   *
   * The keyboard contract's layer 2 ('modal') only engages when the shell has
   * DECLARED a modal — `setContext({ modalDepth })` for the real controller,
   * and this predicate for the PanelStack listener that is live today. Without
   * it, Esc falls through to layer 5 and POPS THE PANEL UNDERNEATH the open
   * sheet: the viewer presses Esc expecting to dismiss a launch they were
   * configuring and silently loses the panel behind it instead. It reads as
   * "Esc is broken" and it is invisible in every test that does not open a
   * sheet first. The contract cannot detect an undeclared modal; it can only
   * honour a declared one.
   */
  isModalOpen(): boolean;
}

export interface LaunchSheetOptions {
  /**
   * The panel ids currently hosted. OBLIGATION 2 — orphan clearing: the sheet
   * is bound to an entity, and if that entity leaves (Esc-pop, close, promote
   * to Z4, or a hydration from an external hash change) the sheet would
   * outlive its subject and configure a launch for a panel that is no longer
   * open. navStore will not clear it and correctly does not know it exists, so
   * the shell clears it from its own nav subscription — which is this.
   */
  hostedIds: readonly EntityId[];
  /** Optional: the real C6 controller, when one is installed. */
  setKeyboardContext?: (patch: { modalDepth: number }) => void;
}

export function useLaunchSheet(options: LaunchSheetOptions): LaunchSheetState {
  const [subjectId, setSubjectId] = useState<EntityId | null>(null);
  const depth = useRef(0);

  const open = useCallback(
    (id: EntityId) => {
      setSubjectId(id);
      depth.current += 1;
      options.setKeyboardContext?.({ modalDepth: depth.current });
    },
    [options],
  );

  const close = useCallback(() => {
    setSubjectId(null);
    depth.current = Math.max(0, depth.current - 1);
    options.setKeyboardContext?.({ modalDepth: depth.current });
  }, [options]);

  // OBLIGATION 2, wired: when the subject stops being hosted, the sheet goes.
  // Keyed on membership rather than on a nav event, so it holds for every way
  // an entity can leave — including hydration changes nobody dispatched.
  const hosted = options.hostedIds.join(',');
  useEffect(() => {
    if (subjectId === null) return;
    if (!options.hostedIds.includes(subjectId)) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hosted, subjectId, close]);

  const isModalOpen = useCallback(() => subjectId !== null, [subjectId]);

  return { subjectId, open, close, isModalOpen };
}
