export interface ReplayWriter {
  write(data: string, callback: () => void): void;
}

/**
 * Write replay data without relying on xterm to callback for an empty chunk.
 * xterm 6 queues the callback beside the chunk but its drain loop stops on a
 * falsy empty string, which otherwise leaves a hydration cover up forever.
 */
export function writeTerminalReplay(
  writer: ReplayWriter,
  data: string,
  onComplete: () => void,
): void {
  if (data.length === 0) {
    onComplete();
    return;
  }
  writer.write(data, onComplete);
}
