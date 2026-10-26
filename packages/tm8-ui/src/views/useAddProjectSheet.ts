import { useCallback, useEffect, useRef, useState } from 'react';
import type { SpaceId } from '@tm8/contract';
import type { ActionRef } from '../domain';

/**
 * THE ADD-PROJECT SHEET'S HOST STATE (task 01a13574) — the Projects list's
 * birth verb, shaped exactly like `useNewContainerSheet` and owing the shell
 * the same two obligations:
 *
 *   1. ESC MUST NOT FALL THROUGH. The sheet declares itself as a modal
 *      (`modalDepth`), or Esc pops the panel underneath it.
 *   2. A SPACE SWITCH CLOSES IT. The sheet adds a project to ONE space; left
 *      open across a switch it would add to a space the viewer has left.
 *
 * Unlike the container sheet this hook does not commit: the sheet owns its
 * three sources (a folder registration, an upload saga, a clone job it polls),
 * so the host only opens, closes and reports.
 */

/** Exactly what this dispatcher performs, as a CONSTANT — the house rule. */
export const ADD_PROJECT_ACTIONS: readonly ActionRef[] = ['add-project'];

export interface AddProjectSheetHost {
  /** The space the project is added to. Absent ⇒ the verb cannot commit. */
  spaceId?: SpaceId | null;
  /** Whether the node behind this host can add projects at all (`seam.spaceProjects`). */
  available: boolean;
  /** The real C6 keyboard controller, when one is installed (obligation 1). */
  setKeyboardContext?: (patch: { modalDepth: number }) => void;
}

export interface AddProjectSheetState {
  isOpen: boolean;
  open(): void;
  close(): void;
  isModalOpen(): boolean;
  /** The list panel's `onAction`. Undefined ⇒ the verb renders refused. */
  onAction?: (ref: ActionRef, entityId: string) => void;
  wiredActions: readonly ActionRef[];
}

export function useAddProjectSheet(host: AddProjectSheetHost): AddProjectSheetState {
  const { spaceId, available, setKeyboardContext } = host;
  const canAdd = Boolean(available && spaceId);
  const [isOpen, setIsOpen] = useState(false);
  const depth = useRef(0);

  /* 0 or 1, derived from the one boolean — never a counter (see the container
     sheet for the open-twice/close-once failure a counter invites). */
  const setDepth = useCallback(
    (next: 0 | 1) => {
      depth.current = next;
      setKeyboardContext?.({ modalDepth: next });
    },
    [setKeyboardContext],
  );

  const open = useCallback(() => {
    setIsOpen(true);
    setDepth(1);
  }, [setDepth]);

  const close = useCallback(() => {
    setIsOpen(false);
    setDepth(0);
  }, [setDepth]);

  useEffect(() => {
    if (isOpen) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId]);

  const isModalOpen = useCallback(() => isOpen, [isOpen]);

  const onAction = useCallback(
    (ref: ActionRef) => {
      switch (ref) {
        case 'add-project':
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
    ...(canAdd ? { onAction } : {}),
    wiredActions: ADD_PROJECT_ACTIONS,
  };
}
