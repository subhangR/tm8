/**
 * WHAT CAN BE SHOWN, and how the bytes to show it are obtained.
 *
 * This module exists because the screen used to answer both questions with
 * one `isImage()` check, and then printed `No byte route exists for this
 * entry` for everything else — including files whose byte route it had just
 * used to render a working Download link two lines below. The copy and the
 * capability had drifted apart, and the user could see both at once.
 *
 * So the two questions are now separate and both are answered honestly:
 *
 *   CAN I REACH THE BYTES?  `downloadHref` (library) or `readBytes`
 *     (project, §4.4 DTO). Neither ⇒ `NO_BYTE_ROUTE`, which is then TRUE.
 *
 *   CAN I RENDER THIS TYPE? `rendererFor(mime)`. No renderer ⇒ `NO_RENDERER`,
 *     which says the bytes are fine and offers the download.
 *
 * EVERYTHING PREVIEWS FROM A BLOB URL, including library files that have a
 * perfectly good href. Two reasons, both load-bearing:
 *
 *   1. `files.download` serves non-media as `Content-Disposition: attachment`
 *      (`facade/services/w2/files.ts`), so pointing an `<iframe>` at that href
 *      would DOWNLOAD the PDF instead of showing it. A blob URL carries no
 *      disposition.
 *   2. It makes the library and project paths converge on one renderer set.
 *      The alternative — href for one root, blob for the other — is two
 *      preview implementations that drift, which is the bug this file exists
 *      to stop happening a second time.
 *
 * SVG IS NEVER RENDERED. An SVG is a document with scripting, and §4.4 excludes
 * it for project files; the same line is held here for library files rather
 * than being drawn differently on each side.
 */

export type PreviewRenderer = 'image' | 'pdf' | 'text' | 'audio' | 'video';

const TEXT_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/javascript',
]);

/**
 * The renderer for a MIME type, or null when the browser has no honest way to
 * show it inline.
 *
 * Deliberately CLOSED and matched on the type the node declared. Sniffing the
 * bytes would let a file that lied about its type pick its own renderer, which
 * is the whole reason `nosniff` is on every byte response this app serves.
 */
export function rendererFor(mime: string | null): PreviewRenderer | null {
  if (!mime) return null;
  const type = mime.split(';')[0]!.trim().toLowerCase();
  // An SVG is a document, not a picture, wherever it came from.
  if (type === 'image/svg+xml') return null;
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('text/') || TEXT_MIMES.has(type)) return 'text';
  return null;
}

/**
 * Text is decoded and rendered into a `<pre>`, never handed to an iframe:
 * `text/html` off a project disk in an iframe is precisely the document
 * context §4.4 forbids. A file that declares itself HTML previews as its own
 * source, which is both safe and what a file browser should show anyway.
 */
export function rendersAsSource(mime: string | null): boolean {
  const type = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  return type === 'text/html' || type === 'image/svg+xml';
}

/** Cap on how much text is decoded into the DOM at once. */
export const MAX_PREVIEW_TEXT_BYTES = 512 * 1024;
