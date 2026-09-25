/**
 * `useChatDefaults(seam, spaceId, kind?)` — the space's per-kind chat defaults
 * (`spaces.chatDefaults.get`), for Settings and for the chat panel's
 * skip-when-default rule (entity-chat design 01a0da4e §3.4).
 *
 * ONE READ PER SPACE, SHARED. Every consumer on a seam shares one cached view
 * per space, and a write through `set` (from Settings, or the card's "Use for
 * every ‹Kind› chat") updates every mounted consumer at once — so a default
 * saved in Settings is what the next Chat click sees, without a refetch.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ChatDefault, ChatDefaultsMap, ChatDefaultsView } from '@tm8/contract';
import type { Seam } from '../data/seam';

export type ChatDefaultsSeam = Pick<Seam, 'chatDefaults' | 'setChatDefaults'>;

interface Slot {
  view: ChatDefaultsView | null;
  error: string | null;
  inflight: Promise<ChatDefaultsView> | null;
  listeners: Set<() => void>;
}

const bySeam = new WeakMap<ChatDefaultsSeam, Map<string, Slot>>();

function slotFor(seam: ChatDefaultsSeam, spaceId: string): Slot {
  let spaces = bySeam.get(seam);
  if (!spaces) bySeam.set(seam, (spaces = new Map()));
  let slot = spaces.get(spaceId);
  if (!slot) spaces.set(spaceId, (slot = { view: null, error: null, inflight: null, listeners: new Set() }));
  return slot;
}

function notify(slot: Slot): void {
  for (const listener of slot.listeners) listener();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read (or re-read with `force`) one space's defaults into the shared cache. */
export function loadChatDefaults(seam: ChatDefaultsSeam, spaceId: string, force = false): Promise<ChatDefaultsView> {
  const slot = slotFor(seam, spaceId);
  if (slot.view && !force) return Promise.resolve(slot.view);
  if (slot.inflight) return slot.inflight;
  const run = seam.chatDefaults(spaceId).then(
    (view) => {
      slot.view = view;
      slot.error = null;
      slot.inflight = null;
      notify(slot);
      return view;
    },
    (error: unknown) => {
      slot.error = messageOf(error);
      slot.inflight = null;
      notify(slot);
      throw error;
    },
  );
  slot.inflight = run;
  return run;
}

/**
 * PATCH over kinds (`null` clears one); every consumer sees the server's
 * answer. A refusal REJECTS with the server's own error — callers render it.
 */
export async function saveChatDefaults(
  seam: ChatDefaultsSeam,
  spaceId: string,
  patch: Record<string, ChatDefault | null>,
): Promise<ChatDefaultsView> {
  const view = await seam.setChatDefaults(spaceId, patch);
  const slot = slotFor(seam, spaceId);
  slot.view = view;
  slot.error = null;
  notify(slot);
  return view;
}

export interface UseChatDefaults {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Every kind's default; `{}` until read. */
  defaults: ChatDefaultsMap;
  /** The asked kind's default, or null (none, or not read yet). */
  entry: ChatDefault | null;
  error: string | null;
  /** Replace one kind's default (`null` clears). Rejects with the server's refusal. */
  set: (kind: string, entry: ChatDefault | null) => Promise<ChatDefaultsView>;
  refresh: () => Promise<ChatDefaultsView>;
}

const EMPTY: ChatDefaultsMap = {};
const noSubscribe = () => () => {};

export function useChatDefaults(seam: ChatDefaultsSeam | null | undefined, spaceId: string | null | undefined, kind?: string): UseChatDefaults {
  const slot = seam && spaceId ? slotFor(seam, spaceId) : null;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!slot) return () => {};
      slot.listeners.add(listener);
      return () => slot.listeners.delete(listener);
    },
    [slot],
  );
  // The snapshot is the slot's own fields, read through a stable tuple key.
  const snapshot = useSyncExternalStore(slot ? subscribe : noSubscribe, () =>
    slot ? `${slot.view?.revision ?? 'none'}|${slot.error ?? ''}|${slot.inflight ? 1 : 0}|${slot.view ? 1 : 0}` : 'idle',
  );
  void snapshot;

  useEffect(() => {
    if (seam && spaceId) loadChatDefaults(seam, spaceId).catch(() => {});
  }, [seam, spaceId]);

  const set = useCallback(
    (target: string, next: ChatDefault | null) => {
      if (!seam || !spaceId) return Promise.reject(new Error('chat defaults: no space'));
      return saveChatDefaults(seam, spaceId, { [target]: next });
    },
    [seam, spaceId],
  );
  const refresh = useCallback(() => {
    if (!seam || !spaceId) return Promise.reject(new Error('chat defaults: no space'));
    return loadChatDefaults(seam, spaceId, true);
  }, [seam, spaceId]);

  const defaults = slot?.view?.defaults ?? EMPTY;
  const status: UseChatDefaults['status'] = !slot
    ? 'idle'
    : slot.view
      ? 'ready'
      : slot.error !== null
        ? 'error'
        : 'loading';
  return {
    status,
    defaults,
    entry: kind ? defaults[kind] ?? null : null,
    error: slot?.error ?? null,
    set,
    refresh,
  };
}
