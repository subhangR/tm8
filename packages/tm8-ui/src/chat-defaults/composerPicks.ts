/**
 * THE COMPOSER'S PER-CHAT PICKS, remembered per browser: the mode a started
 * chat was switched to (the server keeps the chat's DEFAULT mode, not the
 * per-turn pick) and the Coordinator's team. Keyed by chat id; a chat not yet
 * started uses `NEW_CHAT_KEY` and is re-keyed when `chat.start` returns its id.
 */
import type { ChatMode, LaunchModelEffort } from '@tm8/contract';
import { EMPTY_TEAM, type ComposerTeam } from '../chat-home/composer/composer-model';

export const NEW_CHAT_KEY = 'new';

const MODES_KEY = 'tm8.chat.modeOverrides';
const TEAM_PREFIX = 'tm8.chat.team.';
const MODES: ReadonlySet<string> = new Set<ChatMode>(['ask', 'explain', 'plan', 'build', 'orchestrate', 'craft']);
const EFFORTS: ReadonlySet<string> = new Set<LaunchModelEffort>(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function readJson(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    /* Refused storage: picks last for this page only. */
  }
}

export function readModeOverrides(): Record<string, ChatMode> {
  const stored = readJson(MODES_KEY);
  if (!stored || typeof stored !== 'object') return {};
  const out: Record<string, ChatMode> = {};
  for (const [chatId, mode] of Object.entries(stored)) {
    if (typeof mode === 'string' && MODES.has(mode)) out[chatId] = mode as ChatMode;
  }
  return out;
}

export function writeModeOverrides(overrides: Readonly<Record<string, ChatMode>>): void {
  writeJson(MODES_KEY, overrides);
}

function readSlot(raw: unknown): { model: string | null; effort: LaunchModelEffort | null } {
  const slot = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    model: typeof slot.model === 'string' ? slot.model : null,
    effort: typeof slot.effort === 'string' && EFFORTS.has(slot.effort) ? (slot.effort as LaunchModelEffort) : null,
  };
}

export function readTeam(chatKey: string): ComposerTeam {
  const stored = readJson(TEAM_PREFIX + chatKey) as Record<string, unknown> | null;
  if (!stored || typeof stored !== 'object') return EMPTY_TEAM;
  const list = (value: unknown) => (Array.isArray(value) ? value : []) as Record<string, unknown>[];
  return {
    worker: readSlot(stored.worker),
    workers: list(stored.workers)
      .filter((entry) => typeof entry?.id === 'string')
      .map((entry) => ({ id: entry.id as string, ...readSlot(entry) })),
    teammates: list(stored.teammates)
      .filter((entry) => typeof entry?.teammateId === 'string')
      .map((entry) => ({ teammateId: entry.teammateId as string, ...readSlot(entry) })),
  };
}

export function writeTeam(chatKey: string, team: ComposerTeam): void {
  writeJson(TEAM_PREFIX + chatKey, team);
}
