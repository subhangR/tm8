import type { LaunchModelEffort } from '@tm8/contract';

import type { LaunchAccessMode, WorkdirMode } from '../domain/launch';

/**
 * PER-TEAMMATE REMEMBERED PICKS (launch card v2, artifact 01a0dd42 — "Remember
 * picks for this teammate" in the teammate menu).
 *
 * What a person last launched a teammate WITH — model, effort, access and
 * checkout — so the next launch of that teammate opens on it. Browser-local
 * on purpose: these are one viewer's habits, not the persona's settings, and
 * writing them onto the teammate would change what every other launcher sees.
 *
 * Only a SUCCESSFUL launch writes, and only while the box is ticked. A value
 * the model catalog no longer offers is dropped at restore by the state hook
 * (a model override it cannot find falls back to the persona's), so a stale
 * entry costs nothing.
 */
export interface RememberedPicks {
  model?: string | null;
  effort?: LaunchModelEffort | null;
  accessMode?: LaunchAccessMode | null;
  workdirMode?: WorkdirMode;
}

const PICKS_KEY = 'tm8.launch.picks.v1';
const REMEMBER_KEY = 'tm8.launch.remember.v1';

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readAll(): Record<string, RememberedPicks> {
  const raw = store()?.getItem(PICKS_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, RememberedPicks> : {};
  } catch {
    return {};
  }
}

export function readPicks(teammateId: string | null): RememberedPicks | null {
  if (!teammateId) return null;
  return readAll()[teammateId] ?? null;
}

export function writePicks(teammateId: string, picks: RememberedPicks): void {
  const all = readAll();
  all[teammateId] = picks;
  try {
    store()?.setItem(PICKS_KEY, JSON.stringify(all));
  } catch {
    /* A full or refused store loses a convenience, never a launch. */
  }
}

/** The box's own state, remembered across launches. Default: on. */
export function readRemember(): boolean {
  return store()?.getItem(REMEMBER_KEY) !== 'off';
}

export function writeRemember(on: boolean): void {
  try {
    store()?.setItem(REMEMBER_KEY, on ? 'on' : 'off');
  } catch {
    /* as above */
  }
}

/** The teammate menu's "restored: …" line. */
export function describePicks(
  picks: RememberedPicks,
  words: { model(id: string): string; access(mode: LaunchAccessMode): string },
): string {
  return [
    picks.model ? words.model(picks.model) : null,
    picks.effort ?? null,
    picks.accessMode ? words.access(picks.accessMode) : null,
    picks.workdirMode === 'worktree' ? 'worktree' : picks.workdirMode === 'project' ? 'shared checkout' : null,
  ].filter(Boolean).join(' · ');
}
