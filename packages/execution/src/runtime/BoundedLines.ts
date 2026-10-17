import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/** Bounds incomplete frames too: readline's line event arrives after allocation. */
export function boundedLines(
  stream: Readable,
  onLine: (line: string) => void,
  onOverflow: () => void,
  maxChars = 1_048_576,
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
