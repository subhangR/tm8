import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/**
 * The largest protocol line a harness may write. A frame is one JSON event, and
 * an MCP or command tool result rides in a single frame: one `entities.feed`
 * read on a long chat went past the old 1 MiB bound and killed the turn with
 * "Codex protocol frame exceeded its bound". Results are cut to
 * TOOL_RESULT_MAX_CHARS before they are stored, so this bound only protects the
 * process from an unbounded line, not the thread from a big result.
 */
export const HARNESS_FRAME_MAX_CHARS = 64 * 1_048_576;

/** Bounds incomplete frames too: readline's line event arrives after allocation. */
export function boundedLines(
  stream: Readable,
  onLine: (line: string) => void,
  onOverflow: () => void,
  maxChars = HARNESS_FRAME_MAX_CHARS,
): { close(): void } {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let closed = false;
  const accept = (text: string): void => {
    if (closed) return;
    for (const [index, part] of text.split('\n').entries()) {
      if (index > 0) {
        onLine(pending.replace(/\r$/, ''));
        pending = '';
      }
      if (closed) return;
      if (pending.length + part.length > maxChars) {
        closed = true;
        pending = '';
        onOverflow();
        return;
      }
      pending += part;
    }
  };
  const data = (chunk: Buffer | string): void =>
    accept(typeof chunk === 'string' ? chunk : decoder.write(chunk));
  const end = (): void => {
    accept(decoder.end());
    if (!closed && pending) onLine(pending);
    pending = '';
  };
  stream.on('data', data);
  stream.on('end', end);
  return {
    close: () => {
      closed = true;
      pending = '';
      stream.off('data', data);
      stream.off('end', end);
    },
  };
}
