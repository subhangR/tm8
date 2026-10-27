import type { Terminal } from '@xterm/xterm';

/**
 * What a program streaming a SCREEN through the PTY says, as events — for a
 * surface that draws that screen itself instead of in the terminal's grid.
 *
 * The inline-image addon paints a frame into the cell grid, so its sharpness
 * is the grid's: a 46-column phone terminal holds a 440px-wide frame at ~370
 * device-independent pixels, scaled again to fit, then blurred by the canvas.
 * The phone popup (`PhoneLive`) shows the same frame as an `<img>` at its own
 * resolution instead, and needs three facts from the stream:
 *
 * - `frame`: an IIP image (`OSC 1337 ; File=…:<base64>`), as a data URL;
 * - `var`: iTerm's `OSC 1337 ; SetUserVar=<name>=<base64>` (the step under the
 *   frame);
 * - `clear`: `CSI 2 J` — the program moved on to text, so a held frame is stale.
 *
 * Every handler returns false: the addon still draws, and the terminal is
 * unchanged for every other surface. Nothing here writes to the PTY.
 */
export type ScreenSignal =
  | { type: 'frame'; src: string }
  /** `base64` is the value as sent; `decodeUserVar` reads it as UTF-8 text. */
  | { type: 'var'; name: string; base64: string }
  | { type: 'clear' };

const MIME_BY_PREFIX: ReadonlyArray<[string, string]> = [
  ['/9j/', 'image/jpeg'],
  ['iVBOR', 'image/png'],
  ['R0lG', 'image/gif'],
  ['UklG', 'image/webp'],
];

/** The data URL of an IIP `File=` payload, or null when it is not an inline image we can show. */
export function frameFromIip(data: string): string | null {
  if (!data.startsWith('File=')) return null;
  const colon = data.indexOf(':');
  if (colon < 0) return null;
  const params = data.slice(5, colon).split(';');
  if (!params.includes('inline=1')) return null;
  const body = data.slice(colon + 1).replace(/\s+/g, '');
  const mime = MIME_BY_PREFIX.find(([prefix]) => body.startsWith(prefix))?.[1];
  if (!mime || !/^[A-Za-z0-9+/]+=*$/.test(body)) return null;
  return `data:${mime};base64,${body}`;
}

/** `SetUserVar=<name>=<base64>` as its name and still-encoded value, or null. */
export function userVarFromOsc(data: string): { name: string; base64: string } | null {
  const match = /^SetUserVar=([A-Za-z0-9_.-]{1,64})=([A-Za-z0-9+/]*=*)$/.exec(data);
  return match ? { name: match[1], base64: match[2] } : null;
}

/** A user var's value as UTF-8 text, or null when it is not valid base64. */
export function decodeUserVar(base64: string): string | null {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

export function watchScreenSignals(term: Terminal, emit: (signal: ScreenSignal) => void): { dispose(): void } {
  const osc = term.parser.registerOscHandler(1337, (data) => {
    const src = frameFromIip(data);
    if (src) emit({ type: 'frame', src });
    else {
      const userVar = userVarFromOsc(data);
      if (userVar) emit({ type: 'var', ...userVar });
    }
    return false;
  });
  const csi = term.parser.registerCsiHandler({ final: 'J' }, (params) => {
    if (params[0] === 2) emit({ type: 'clear' });
    return false;
  });
  return {
    dispose: () => {
      osc.dispose();
      csi.dispose();
    },
  };
}
