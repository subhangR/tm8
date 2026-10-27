import { ImageAddon } from '@xterm/addon-image';
import type { IImageAddonOptions } from '@xterm/addon-image';

/**
 * Inline images in the web terminal — the iTerm image protocol (IIP,
 * `ESC ] 1337 ; File=inline=1;… : <base64> BEL`) and SIXEL.
 *
 * Why this exists: an agent testing an app in a headless browser has a SCREEN,
 * and the only live channel tm8 already gives a viewer is the session's PTY.
 * Without an image decoder the best a program can draw there is half-block
 * mosaic (two pixels per cell). With it, a program streams real frames — PNG
 * or JPEG at full resolution — through the same authorized, replay-sanitized
 * socket the terminal already uses, so no new server route is involved.
 *
 * The limits are the point of this file:
 *
 * - `enableSizeReports: false`. On, the addon answers the pixel-size QUERIES
 *   (`CSI 14 t`, `CSI 16 t`). xterm sends query replies to the PTY as if
 *   typed, and the scrollback sanitizer (`stripScrollbackDeviceQueries`) does
 *   not strip `t`, so a replayed historical query would type its reply into
 *   the shell — the exact corruption that sanitizer exists to prevent. A
 *   program sizes its image in CELLS instead (`width=Ncols;height=Nrows`).
 * - `storageLimit: 32` MB, not the default 128. Images are kept as RGBA, and a
 *   live stream replaces its frame every second; the FIFO evicts old frames,
 *   so this caps what a long-running stream can hold per terminal.
 * - `pixelLimit` 4 MP: a phone screenshot at device-pixel ratio 3 is ~3.3 MP.
 * - `iipSizeLimit`/`sixelSizeLimit` 8 MB: one sequence, well above a frame,
 *   well below what a runaway program could make the decoder chew on.
 */
export const INLINE_IMAGE_OPTIONS: IImageAddonOptions = {
  enableSizeReports: false,
  storageLimit: 32,
  pixelLimit: 4 * 1024 * 1024,
  showPlaceholder: false,
  sixelSupport: true,
  sixelSizeLimit: 8 * 1024 * 1024,
  iipSupport: true,
  iipSizeLimit: 8 * 1024 * 1024,
};

export function createInlineImageAddon(): ImageAddon {
  return new ImageAddon(INLINE_IMAGE_OPTIONS);
}
