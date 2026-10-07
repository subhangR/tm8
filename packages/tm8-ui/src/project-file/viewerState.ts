/**
 * WHAT THE VIEWER SHOWS for one `projects.files.read` answer. Pure, so the
 * choice is tested apart from the rendering.
 *
 *   text      the bytes decoded as UTF-8: highlighted source, whatever the
 *             mime says (a `.ts` file is often declared `video/mp2t`). HTML
 *             and SVG arrive as `text/plain` on purpose and stay source.
 *   image     a raster image (`rendererFor` → image: never SVG), from base64.
 *   binary    anything else: "No preview for this file type", size and mime.
 *   tooLarge  an image the node cut off: a partial image is not a picture.
 *
 * `cutAt` (bytes) is set when what is shown is a prefix — the node's inline
 * ceiling, or the viewer's own `MAX_PREVIEW_TEXT_BYTES` — and the banner says
 * where the file was cut off.
 */
import type { ProjectFileReadResult } from '@tm8/contract';
import { MAX_PREVIEW_TEXT_BYTES, rendererFor } from '../files-explorer/preview';

export type FileViewerState =
  | { kind: 'text'; text: string; cutAt: number | null }
  | { kind: 'image'; mime: string; base64: string }
  | { kind: 'binary' }
  | { kind: 'tooLarge' };

/** UTF-8 byte length without allocating the encoded bytes. */
function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** The longest prefix of `text` within `maxBytes` of UTF-8. */
function clipUtf8(text: string, maxBytes: number): string {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const size = c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 4 : 3;
    if (n + size > maxBytes) return text.slice(0, i);
    n += size;
    if (size === 4) i++;
  }
  return text;
}

export function viewerStateOf(
  read: Pick<ProjectFileReadResult, 'mime' | 'encoding' | 'content' | 'truncated'>,
  maxTextBytes = MAX_PREVIEW_TEXT_BYTES,
): FileViewerState {
  if (read.encoding === 'utf8') {
    const bytes = utf8Length(read.content);
    if (bytes > maxTextBytes) return { kind: 'text', text: clipUtf8(read.content, maxTextBytes), cutAt: maxTextBytes };
    return { kind: 'text', text: read.content, cutAt: read.truncated ? bytes : null };
  }
  if (rendererFor(read.mime) === 'image') {
    return read.truncated ? { kind: 'tooLarge' } : { kind: 'image', mime: read.mime, base64: read.content };
  }
  return { kind: 'binary' };
}

/** "512 KB", "4.8 MB", "730 bytes". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
