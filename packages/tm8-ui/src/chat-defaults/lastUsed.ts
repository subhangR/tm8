/**
 * The LAST-USED chat mode, remembered per browser (entity-chat design
 * 01a0da4e §5: "last-used settings are remembered per browser"). A new chat
 * about an entity starts in it — `ask` when nothing was ever chosen (§3.4).
 * Written when a new chat is started; read by the settings card and the
 * skip-when-default path.
 */
import type { ChatMode } from '@tm8/contract';

const KEY = 'tm8.chat.lastMode';
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
