/**
 * Undo channel — every placement's `UndoToken` lands here; the provider's
 * UndoPill and the ⌘Z binding redeem it via `facade.undo(token)` (DEV-11:
 * single-use, 5-minute TTL — unknown/used → not_found, expired →
 * invariant_violation). One token is held at a time (the newest); redeeming
 * or expiry clears it.
 */
import { create } from 'zustand';
import { pushToast } from '../subsystems/live';
import { isCollabError, type UndoToken } from '../types/contract';
import type { CollabFacade } from '../facade';
import { applyEverywhere } from './execute';

/** Mirror of the facade's token TTL, for display expiry when the token
 * carries no `expiresAt` (mock tokens do). */
export const UNDO_TTL_MS = 5 * 60_000;

export interface UndoEntry {
  token: string;
  label: string;
  /** Epoch ms past which the pill hides itself (server truth when given). */
  expiresAt: number;
  seq: number;
}

interface UndoState {
  entry: UndoEntry | null;
  register: (token: UndoToken, now?: () => number) => void;
  clear: () => void;
}

let seq = 0;

export const useUndoStore = create<UndoState>()((set) => ({
  entry: null,
  register: (token, now = Date.now) => {
    seq += 1;
    set({
      entry: {
        token: token.token,
        label: token.label,
        expiresAt: token.expiresAt ? Date.parse(token.expiresAt) : now() + UNDO_TTL_MS,
        seq,
      },
    });
  },
  clear: () => set({ entry: null }),
}));

/** Imperative helper for the executor. */
export function registerUndo(token: UndoToken, now?: () => number): void {
  useUndoStore.getState().register(token, now);
}

/** The current entry if it is still redeemable at `now`. */
export function activeUndo(now: () => number = Date.now): UndoEntry | null {
  const entry = useUndoStore.getState().entry;
  if (!entry) return null;
  return entry.expiresAt > now() ? entry : null;
}

/**
 * Redeem the held token. Applies the inverse command's patches, announces the
 * outcome, and always clears the entry (tokens are single-use either way).
 */
export async function runUndo(facade: CollabFacade, now: () => number = Date.now): Promise<boolean> {
  const entry = activeUndo(now);
  if (!entry) return false;
  useUndoStore.getState().clear();
  try {
    const result = await facade.undo(entry.token);
    applyEverywhere(result.patches);
    pushToast({ kind: 'success', message: `Undone — ${entry.label}` });
    return true;
  } catch (e) {
    const message = isCollabError(e) && e.code === 'invariant_violation'
      ? 'The undo window has expired.'
      : isCollabError(e) && e.code === 'not_found'
        ? 'Nothing left to undo.'
        : 'Undo failed.';
    pushToast({ kind: 'error', message });
    return false;
  }
}
