/**
 * FILES OUT OF A DataTransfer — the one extractor for paste and drop.
 *
 * PROVENANCE: `terminal/clipboardImages.ts`, re-homed. It was written for the
 * terminal, imported by the chat composer across lanes, and was `image/*`-only
 * — ruling R2 widens paste to the whole agent-readable set (images, PDFs,
 * documents, audio, video; `@tm8/contract` `isAgentReadableFile` is the single
 * source of that truth). The dedupe and generic-name renaming survive intact;
 * what changed is that the filter is now a parameter with the R2 default, and
 * a refused file is RETURNED rather than silently dropped — a paste that did
 * nothing and a paste that was refused are different facts, and only one of
 * them can be said out loud by the surface.
 *
 * Renaming applies to IMAGES ONLY, exactly as before: a screenshot arrives as
 * `image.png` from every OS and collides with the last one, so images get
 * sequence names. A pasted document keeps its name — `report.pdf` renamed to
 * `file1.pdf` would destroy the one fact the user recognizes it by.
 */
import { isAgentReadableFile } from '@tm8/contract';

export interface ExtractFilesOptions {
  /** Which files count as readable. Default: the contract's R2 predicate. */
  accept?: (file: File) => boolean;
  startIndex?: number;
  /** Rename every image to its sequence name, not only generically-named ones. */
  renameAll?: boolean;
}

export interface ExtractedFiles {
  accepted: File[];
  /** Present so the surface can SAY a file was refused instead of shrugging. */
  refused: File[];
}

const GENERIC_CLIPBOARD_NAMES = new Set([
  '', 'image.png', 'image.jpg', 'image.jpeg', 'image.gif', 'image.webp',
  'pasted_image.png', 'pasted_image.jpg', 'pasted_image.jpeg', 'pasted_image.gif',
  'pasted_image.webp',
]);

function isGenericClipboardName(name: string): boolean {
  return GENERIC_CLIPBOARD_NAMES.has(name.toLowerCase()) ||
    /^pasted[-_]image(?:[-_]\d+)?\.(png|jpe?g|gif|webp)$/i.test(name);
}

function extForMime(mimeType: string): string {
  const subtype = mimeType.split('/')[1] || 'png';
  if (subtype === 'jpeg') return 'jpg';
  if (subtype === 'svg+xml') return 'svg';
  return subtype;
}

function withImageSequenceName(file: File, index: number): File {
  const name = `image${index}.${extForMime(file.type)}`;
  return new File([file], name, { type: file.type, lastModified: file.lastModified });
}

function applyImageSequenceNames(files: File[], options: ExtractFilesOptions): File[] {
  let nextIndex = options.startIndex ?? 1;
  return files.map((file) => {
    if (!file.type.startsWith('image/')) return file;
    if (!options.renameAll && !isGenericClipboardName(file.name)) return file;
    const renamed = withImageSequenceName(file, nextIndex);
    nextIndex += 1;
    return renamed;
  });
}

export function extractReadableFiles(
  data: DataTransfer | null,
  options: ExtractFilesOptions = {},
): ExtractedFiles {
  const accept = options.accept ?? isAgentReadableFile;
  const accepted: File[] = [];
  const refused: File[] = [];
  if (!data) return { accepted, refused };
  const seen = new Set<string>();
  const push = (file: File | null) => {
    if (!file) return;
    const key = `${file.name}:${file.size}:${file.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    (accept(file) ? accepted : refused).push(file);
  };
  if (data.items) {
    // getAsFile() is null for a non-file DataTransferItem (e.g. plain-text
    // drags) by spec, and push() already drops nulls — so no separate
    // item-kind check is needed here.
    for (let index = 0; index < data.items.length; index += 1) {
      push(data.items[index]?.getAsFile() ?? null);
    }
  }
  if (data.files) {
    for (let index = 0; index < data.files.length; index += 1) push(data.files[index] ?? null);
  }
  return { accepted: applyImageSequenceNames(accepted, options), refused };
}

/**
 * The image-only extraction the terminal still speaks — same signature and
 * behaviour `terminal/clipboardImages.ts` always had. It narrows the accept
 * to `image/*` because the terminal's server-side clipboard store is
 * images-only today; when that allowlist widens to the contract predicate
 * (ruling 1), the terminal switches to `extractReadableFiles` and this
 * narrowing retires.
 */
export function extractImageFiles(
  data: DataTransfer | null,
  options: Omit<ExtractFilesOptions, 'accept'> = {},
): File[] {
  return extractReadableFiles(data, {
    ...options,
    accept: (file) => file.type.startsWith('image/'),
  }).accepted;
}

export function dataTransferHasFiles(data: DataTransfer | null): boolean {
  return Boolean(data && Array.from(data.types || []).includes('Files'));
}
