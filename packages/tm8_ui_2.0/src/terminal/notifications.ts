/**
 * Terminal-side user notices.
 *
 * These fire from inside xterm event handlers — a paste, a copy, a failed
 * upload — which sit far below any React tree that owns notice state. Prop
 * drilling `notices.push` from `GateApp` down through the terminal would make
 * every intermediate component carry a concern it has nothing to do with, so
 * the shell REGISTERS its push function here once and this module keeps it in
 * a module-level slot.
 *
 * The console fallback stays, and is the behavior whenever nobody has
 * registered — headless tests, the terminal harnesses, and any embedding that
 * has no shell. That is why registration is optional rather than required:
 * a terminal must render and work with no notice host at all.
 *
 * Ids are STABLE PER CLASS, matching the shell's never-stacks rule: pasting
 * four images and failing four times shows one card, not four.
 */
import { NOTICE_TTL_MS, type Notice, type NoticeTone } from '../shell/notices';

export type TerminalNoticeKind = 'info' | 'success' | 'warn';

export type NoticeSink = (notice: Notice) => void;

const TONE_BY_KIND: Record<TerminalNoticeKind, NoticeTone> = {
  info: 'info',
  success: 'info',
  warn: 'warn',
};

const TITLE_BY_KIND: Record<TerminalNoticeKind, string> = {
  info: 'Terminal',
  success: 'Done',
  warn: 'Terminal',
};

let sink: NoticeSink | null = null;

/**
 * Point terminal notices at the shell's notice queue. Returns the un-register
 * function so a remounting shell cannot leave a stale closure holding the slot.
 */
export function registerNoticeSink(next: NoticeSink): () => void {
  sink = next;
  return () => {
    if (sink === next) sink = null;
  };
}

export function notifyUser(message: string, kind: TerminalNoticeKind): void {
  const log = kind === 'warn' ? console.warn : console.info;
  log(`[terminal] ${message}`);
  sink?.({
    id: `terminal-${kind}`,
    tone: TONE_BY_KIND[kind],
    title: TITLE_BY_KIND[kind],
    body: message,
    ttlMs: NOTICE_TTL_MS,
  });
}
