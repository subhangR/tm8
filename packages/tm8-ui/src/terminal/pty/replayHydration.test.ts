import { describe, expect, it, vi } from 'vitest';
import { writeTerminalReplay } from './replayHydration.js';

describe('terminal replay hydration', () => {
  it('completes an empty replay without handing xterm a callback it will strand', () => {
    const writer = { write: vi.fn() };
    const complete = vi.fn();

    writeTerminalReplay(writer, '', complete);

    expect(writer.write).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
  });

  it('waits for xterm to finish parsing a non-empty replay', () => {
    let parsed: (() => void) | undefined;
    const writer = { write: vi.fn((_data: string, callback: () => void) => { parsed = callback; }) };
    const complete = vi.fn();

    writeTerminalReplay(writer, 'retained output', complete);
    expect(complete).not.toHaveBeenCalled();
    parsed?.();
    expect(complete).toHaveBeenCalledOnce();
  });
});
