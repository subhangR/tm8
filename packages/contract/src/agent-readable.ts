/**
 * WHAT A MODEL CAN ACTUALLY READ — the one predicate, shared by every surface
 * that filters a pasted file.
 *
 * It lives in the contract for the same reason `launch-models.ts` does: two
 * packages need the identical answer and neither may import the other. The UI
 * composers filter clipboard files with it, and the terminal's server-side
 * clipboard store must widen to the same set (its allowlist is images-only
 * today) — two hand-kept copies of "what agents read" would diverge on exactly
 * the type nobody tested.
 *
 * The set is capability truth, not policy: images, PDFs, audio and video are
 * ingested natively by current models; text of any flavour (markdown, csv,
 * source code, config) is read as text; Office and OpenDocument formats are
 * extracted server-side by every major provider. Archives, executables and
 * unknown binaries are excluded because no model reads them raw — accepting
 * one would store bytes the agent can only describe, not read.
 *
 * This is deliberately NOT an operation, a schema, or a catalog row. Nothing
 * here moves a pin.
 */

/** Exact MIME types accepted beyond the wildcard prefixes below. */
export const AGENT_READABLE_MIME_TYPES: readonly string[] = [
  'application/pdf',
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/rtf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
];

/** Prefix families accepted wholesale. `text/*` covers markdown, csv, source. */
export const AGENT_READABLE_MIME_PREFIXES: readonly string[] = [
  'image/',
  'video/',
  'audio/',
  'text/',
  'application/vnd.openxmlformats-officedocument.',
  'application/vnd.oasis.opendocument.',
];

/**
 * Extensions trusted when the MIME type is missing. Clipboard and drag sources
 * routinely hand over code and config files with an empty `type`; the name is
 * then the only evidence, and these are all read as text. Deliberately short —
 * an unknown extension with no MIME stays refused rather than guessed at.
 */
export const AGENT_READABLE_BARE_EXTENSIONS: readonly string[] = [
  'md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'xml',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'sql', 'sh', 'bash', 'zsh', 'html',
  'css', 'scss', 'svg', 'log', 'ini', 'conf', 'env', 'diff', 'patch',
];

/**
 * MIME suffix conventions (`+json`, `+xml`) accepted for any base type —
 * `application/ld+json`, `image/svg+xml` and their relatives are structured
 * text whatever their registry prefix says.
 */
const READABLE_MIME_SUFFIXES = ['+json', '+xml'];

export function isAgentReadableMime(mime: string): boolean {
  const type = mime.trim().toLowerCase().split(';')[0] ?? '';
  if (type === '') return false;
  if (AGENT_READABLE_MIME_TYPES.includes(type)) return true;
  if (AGENT_READABLE_MIME_PREFIXES.some((prefix) => type.startsWith(prefix))) return true;
  return READABLE_MIME_SUFFIXES.some((suffix) => type.endsWith(suffix));
}

/**
 * The file-level predicate: MIME first, bare-extension fallback ONLY when the
 * MIME is absent. A file that declares `application/zip` is refused even if
 * someone named it `notes.txt.zip` — a stated type is believed over a name.
 */
export function isAgentReadableFile(file: { name: string; type: string }): boolean {
  if (file.type.trim() !== '') return isAgentReadableMime(file.type);
  const dot = file.name.lastIndexOf('.');
  if (dot <= 0 || dot === file.name.length - 1) return false;
  return AGENT_READABLE_BARE_EXTENSIONS.includes(file.name.slice(dot + 1).toLowerCase());
}
