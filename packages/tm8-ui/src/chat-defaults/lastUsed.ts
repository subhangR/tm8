/**
 * The LAST-USED chat mode, teammate and model, remembered per browser (entity-chat design
 * 01a0da4e §5: "last-used settings are remembered per browser"). A new chat
 * about an entity starts in it — `ask` when nothing was ever chosen (§3.4).
 * Teammate and model pre-fill the settings card after the kind's own default
 * and only while they still resolve (the caller checks). Written when a new
 * chat is started; read by the settings card and the skip-when-default path.
 */
import type { ChatMode, LaunchModelEffort } from '@tm8/contract';

const KEY = 'tm8.chat.lastMode';
const TEAMMATE_KEY = 'tm8.chat.lastTeammate';
const MODEL_KEY = 'tm8.chat.lastModel';
const MODES: ReadonlySet<string> = new Set<ChatMode>(['ask', 'explain', 'plan', 'build', 'orchestrate', 'craft']);

export function lastChatMode(): ChatMode {
  try {
    const stored = globalThis.localStorage?.getItem(KEY);
    return stored && MODES.has(stored) ? (stored as ChatMode) : 'ask';
  } catch {
    return 'ask';
  }
}

export function rememberChatMode(mode: ChatMode): void {
  try {
    globalThis.localStorage?.setItem(KEY, mode);
  } catch {
    /* A browser that refuses storage just starts every chat in `ask`. */
  }
}

export interface LastChatPicks {
  teammateId: string | null;
  model: string | null;
}

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) || null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null | undefined): void {
  if (!value) return;
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* Refused storage: the card falls back to the first listed. */
  }
}

export function lastChatPicks(): LastChatPicks {
  return { teammateId: read(TEAMMATE_KEY), model: read(MODEL_KEY) };
}

/** Everything a started chat leaves for the next one to pre-fill. */
export function rememberChatStart(start: { mode?: ChatMode | null; teammateId?: string | null; model?: string | null }): void {
  if (start.mode) rememberChatMode(start.mode);
  write(TEAMMATE_KEY, start.teammateId);
  write(MODEL_KEY, start.model);
}

/**
 * THE COMPOSER'S LAST EXPLICIT PICKS, per Space and viewer: the mode, model,
 * per-mode effort and project the viewer last chose in ANY chat — a new one or one
 * already running. The next new chat starts on them instead of the built-in
 * `ask` + first-listed model; a host seed (the entity chat card) or a pick on
 * the new chat itself still wins. A model the catalog no longer lists is
 * ignored by the caller, never sent.
 */
const PICKS_PREFIX = 'tm8.chat.lastPicks.';
const EFFORTS: ReadonlySet<string> = new Set<LaunchModelEffort>(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export interface LastComposerPicks {
  mode: ChatMode | null;
  model: string | null;
  effortByMode: Partial<Record<ChatMode, LaunchModelEffort>>;
  /** The Space's project a new chat starts in; null is scratch. */
  project: string | null;
}

export type ComposerPick =
  | { mode: ChatMode }
  | { model: string }
  | { mode: ChatMode; effort: LaunchModelEffort }
  | { project: string | null };

export function composerPicksScope(spaceId: string, viewerId?: string | null): string {
  return viewerId ? `${spaceId}.${viewerId}` : spaceId;
}

export function lastComposerPicks(scope: string): LastComposerPicks {
  let stored: Record<string, unknown> = {};
  try {
    const raw = globalThis.localStorage?.getItem(PICKS_PREFIX + scope);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') stored = parsed as Record<string, unknown>;
  } catch {
    /* Unreadable: start from the built-in defaults. */
  }
  const effortByMode: Partial<Record<ChatMode, LaunchModelEffort>> = {};
  const efforts = stored.effortByMode && typeof stored.effortByMode === 'object' ? stored.effortByMode : {};
  for (const [mode, effort] of Object.entries(efforts as Record<string, unknown>)) {
    if (MODES.has(mode) && typeof effort === 'string' && EFFORTS.has(effort)) {
      effortByMode[mode as ChatMode] = effort as LaunchModelEffort;
    }
  }
  return {
    mode: typeof stored.mode === 'string' && MODES.has(stored.mode) ? (stored.mode as ChatMode) : null,
    model: typeof stored.model === 'string' && stored.model ? stored.model : null,
    effortByMode,
    project: typeof stored.project === 'string' && stored.project ? stored.project : null,
  };
}

export function rememberComposerPick(scope: string, pick: ComposerPick): void {
  const current = lastComposerPicks(scope);
  const next: LastComposerPicks = 'effort' in pick
    ? { ...current, effortByMode: { ...current.effortByMode, [pick.mode]: pick.effort } }
    : 'mode' in pick
      ? { ...current, mode: pick.mode }
      : 'project' in pick
        ? { ...current, project: pick.project }
        : { ...current, model: pick.model };
  try {
    globalThis.localStorage?.setItem(PICKS_PREFIX + scope, JSON.stringify(next));
  } catch {
    /* Refused storage: the next chat starts on the built-in defaults. */
  }
}
