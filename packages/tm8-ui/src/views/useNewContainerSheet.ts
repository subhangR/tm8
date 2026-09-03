import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandResult, ContainersCreateInput, EntityId, SpaceId } from '@tm8/contract';
import type { ActionRef } from '../domain';
import type { Seam } from '../data/seam';

/**
 * THE NEW-CONTAINER SHEET'S HOST STATE — the birth flow's executor and its
 * modal bookkeeping (Design §13.3).
 *
 * TWO EXISTING HOOKS MEET HERE, and neither one alone was the right shape:
 *
 *   · `useSessionStart` is the SPACE-SCOPED BIRTH pattern. Starting a thing
 *     that does not exist yet has no entity to bind to, so the inputs are the
 *     space and the project — not `forEntity(id)`. That half is copied.
 *   · `useLaunchSheet` is the MODAL pattern, and it carries two obligations a
 *     sheet owes the shell. Those are restated and honoured below.
 *
 * `useSessionStart` commits on click because a vanilla terminal has nothing to
 * configure. A container has a profile, a project, a network preset and a
 * lifetime, so it opens a sheet first — the two-clicks-to-launch rule applying
 * exactly where it was meant to: the configuration you are about to use must
 * be visible at the moment you commit it.
 *
 * ── OBLIGATION 1: ESC MUST NOT FALL THROUGH ──────────────────────────────
 *
 * Verbatim from `useLaunchSheet`, because the hazard is verbatim too. The
 * keyboard contract's layer 2 ('modal') engages only when the shell has
 * DECLARED a modal. Without the declaration Esc falls through to layer 5 and
 * POPS THE PANEL UNDERNEATH the open sheet: the viewer presses Esc to dismiss
 * a container they were configuring and silently loses the panel behind it.
 * It reads as "Esc is broken", and it is invisible in every test that does not
 * open a sheet first. The contract cannot detect an undeclared modal; it can
 * only honour a declared one.
 *
 * ── OBLIGATION 2: ORPHAN CLEARING, AND WHY ITS SHAPE DIFFERS ─────────────
 *
 * `useLaunchSheet` clears itself when its SUBJECT ENTITY stops being hosted,
 * because a launch sheet configures a launch for a specific panel and would
 * otherwise outlive it.
 *
 * THIS SHEET HAS NO SUBJECT. It is born from the space, like a terminal — so
 * there is no entity that can leave, and copying `hostedIds` membership here
 * would be cargo-culting a guard with nothing to guard. Stating that rather
 * than silently omitting it, because "the obligation does not apply" and
 * "nobody thought about the obligation" look identical in a diff.
 *
 * WHAT DOES APPLY is the same hazard one level up: the sheet is scoped to a
 * SPACE, and a space switch would leave it configuring a container for a space
 * the viewer has left — committing into the wrong graph. So the membership
 * check becomes a space check, which is the honest analogue.
 */

/** Exactly what this dispatcher performs, as a CONSTANT — the house rule. */
export const NEW_CONTAINER_ACTIONS: readonly ActionRef[] = ['new-container'];

export interface NewContainerSheetHost {
  /** The space the container is born in. Absent ⇒ the verb cannot commit. */
  spaceId?: SpaceId | null;
  /** The command surface. Absent ⇒ `onAction` is undefined; the verb refuses. */
  seam?: Pick<Seam, 'commands'>;
  /** Fold the new container's patches into the store, as a spawn's are. */
  reconcileCommand?: (result: CommandResult) => void;
  /** Open the container that was just created — one you cannot see is not one. */
  onOpen?: (id: EntityId) => void;
  /** The node refused, verbatim — never paraphrased into a generic failure. */
  onError?: (verb: ActionRef, error: unknown) => void;
  /** The real C6 keyboard controller, when one is installed (obligation 1). */
  setKeyboardContext?: (patch: { modalDepth: number }) => void;
}

export interface NewContainerSheetState {
  /** Is the sheet open? Drives the host's render of `NewContainerSheet`. */
  isOpen: boolean;
  open(): void;
  close(): void;
  /** OBLIGATION 1 — the shell asks this before letting Esc reach layer 5. */
  isModalOpen(): boolean;
  /** The list panel's `onAction`. Undefined ⇒ the verb renders refused. */
  onAction?: (ref: ActionRef, entityId: string) => void;
  /** The list panel's `wiredActions`. */
  wiredActions: readonly ActionRef[];
  /** Commit — the sheet's `onCreate`. Resolves when the node has answered. */
  create(input: ContainersCreateInput): Promise<void>;
}

export function useNewContainerSheet(host: NewContainerSheetHost): NewContainerSheetState {
  const { spaceId, seam, reconcileCommand, onOpen, onError, setKeyboardContext } = host;
  const commands = seam?.commands;
  const canCreate = Boolean(commands && spaceId);

  const [isOpen, setIsOpen] = useState(false);
  const depth = useRef(0);

  const open = useCallback(() => {
    setIsOpen(true);
    depth.current += 1;
    setKeyboardContext?.({ modalDepth: depth.current });
  }, [setKeyboardContext]);

  const close = useCallback(() => {
    setIsOpen(false);
    depth.current = Math.max(0, depth.current - 1);
    setKeyboardContext?.({ modalDepth: depth.current });
  }, [setKeyboardContext]);

  /*
   * OBLIGATION 2, in its space-scoped form. Keyed on the space ITSELF rather
   * than on a navigation event, so it holds for every way a space can change
   * — including a hydration from an external hash change that nobody
   * dispatched, which is the case `useLaunchSheet` calls out by name.
   */
  useEffect(() => {
    if (isOpen) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId]);

  const isModalOpen = useCallback(() => isOpen, [isOpen]);

  const create = useCallback(
    async (input: ContainersCreateInput) => {
      /*
       * NOT a silent swallow — the `usePanelPrimaries.terminate` posture.
       * `onAction` is undefined without these, so the sheet is unreachable
       * from the header; a host calling `create` DIRECTLY without them has
       * wired a control it cannot perform, and absorbing that as a no-op is
       * how a dead button survives review.
       */
      if (!commands || !spaceId) {
        throw new Error(
          'useNewContainerSheet.create was called with no seam or no space: the host rendered a control it '
            + 'cannot perform. Gate the affordance on `onAction != null`, which is undefined precisely so this '
            + 'cannot happen.',
        );
      }
      try {
        const result = await commands.createContainer(input);
        reconcileCommand?.(result);
        /*
         * CLOSE ONLY ON SUCCESS. A sheet that closes on a refusal takes the
         * viewer's whole configuration with it and shows the error somewhere
         * else — so the remedy ("confirm the untrusted project", "no provider
         * satisfies this profile") arrives with nothing left to apply it to.
         */
        close();
        const id = (result as { entity?: { id?: string } }).entity?.id
          ?? (result.patches?.[0] as { id?: string } | undefined)?.id;
        if (id) onOpen?.(id as EntityId);
      } catch (error: unknown) {
        onError?.('new-container', error);
      }
    },
    [commands, spaceId, reconcileCommand, close, onOpen, onError],
  );

  const onAction = useCallback(
    (ref: ActionRef) => {
      /* A SWITCH, not a lookup with a default: an unhandled verb must be
         unreachable rather than silently absorbed. `wiredActions` is what keeps
         it unreachable, and the two are edited together or the guard is
         decorative. */
      switch (ref) {
        case 'new-container':
          open();
          return;
        default:
          return;
      }
    },
    [open],
  );

  return {
    isOpen,
    open,
    close,
    isModalOpen,
    ...(canCreate ? { onAction } : {}),
    wiredActions: NEW_CONTAINER_ACTIONS,
    create,
  };
}
