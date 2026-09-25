/**
 * The LAST-USED chat mode, teammate and model, remembered per browser (entity-chat design
 * 01a0da4e §5: "last-used settings are remembered per browser"). A new chat
 * about an entity starts in it — `ask` when nothing was ever chosen (§3.4).
 * Teammate and model pre-fill the settings card after the kind's own default
 * and only while they still resolve (the caller checks). Written when a new
 * chat is started; read by the settings card and the skip-when-default path.
 */
import type { ChatMode } from '@tm8/contract';

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
