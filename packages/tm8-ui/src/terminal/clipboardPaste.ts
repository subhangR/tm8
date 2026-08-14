/**
 * WHAT A PASTE OR DROP ON THE TERMINAL MEANS — files, or text, or nothing.
 *
 * WIDENED FROM IMAGES TO THE AGENT-READABLE SET (R2). This took `image/*`
 * only, because the node's clipboard store took only four image formats. That
 * allowlist is now the contract's own predicate, so the terminal reads the
 * same set as every other paste surface — a PDF, a CSV or the log file the
 * agent was just asked about make the trip the same way a screenshot does.
 *
 * `/` IS NOT A TRIGGER HERE, and that is ruled, not overlooked: a PTY is a
 * character stream someone else's program is reading. A sigil the terminal
 * interpreted would be a keystroke the shell never received.
 *
 * FILES WIN OVER TEXT, as they always did. A clipboard that carries both is
 * a file copied out of a file manager, which puts its name in `text/plain`
 * as a courtesy; pasting the name instead of making the trip is the answer
 * nobody wants.
 */
import { extractReadableFiles } from '../rich-input/clipboardFiles';

export interface ClipboardDispatchHandlers {
  onText(text: string): void;
  onFiles(files: File[]): void;
  /**
   * Files the agent-readable filter declined — an archive, an executable.
   * Optional, and when a host omits it the refusal is SILENT, which is why
   * `LiveTerminal` supplies one: a paste that visibly does nothing reads as a
   * broken terminal rather than as a refusal.
   */
  onRefused?(files: File[]): void;
}

export interface ClipboardDispatchResult {
  kind: 'files' | 'text' | 'none';
  handled: boolean;
  fileCount: number;
  refusedCount: number;
}

export function dispatchClipboardData(
  data: DataTransfer | null,
  handlers: ClipboardDispatchHandlers,
  options: { fileStartIndex?: number } = {},
): ClipboardDispatchResult {
  if (!data) return { kind: 'none', handled: false, fileCount: 0, refusedCount: 0 };
  const { accepted, refused } = extractReadableFiles(data, {
    startIndex: options.fileStartIndex ?? 1,
    renameAll: true,
  });
  if (refused.length > 0) handlers.onRefused?.(refused);
  if (accepted.length > 0) {
    handlers.onFiles(accepted);
    return { kind: 'files', handled: true, fileCount: accepted.length, refusedCount: refused.length };
  }
  /* A refusal still COUNTS AS HANDLED: the files were taken out of the event,
     said no to out loud, and must not then fall through to pasting whatever
     name the file manager left in `text/plain`. */
  if (refused.length > 0) {
    return { kind: 'none', handled: true, fileCount: 0, refusedCount: refused.length };
  }
  const text = data.getData?.('text/plain') ?? '';
  if (text) {
    handlers.onText(text);
    return { kind: 'text', handled: true, fileCount: 0, refusedCount: 0 };
  }
  return { kind: 'none', handled: false, fileCount: 0, refusedCount: 0 };
}
