/**
 * The file-type badge a file tab (and the project tree) leads with: a short
 * label from the extension (`TS`, `MD`, `{}`), like mockup v2.
 */
import { extensionOf } from './language';
import { baseName } from './paths';

const SHORT: Record<string, string> = {
  json: '{}', jsonc: '{}', markdown: 'MD', yml: 'YML', yaml: 'YML',
  png: 'IMG', jpg: 'IMG', jpeg: 'IMG', gif: 'IMG', webp: 'IMG', bmp: 'IMG', ico: 'IMG', avif: 'IMG',
};

/** `TS` for `a.ts`, `{}` for JSON, `IMG` for images; `·` without an extension. */
export function fileBadgeText(path: string): string {
  const ext = extensionOf(baseName(path));
  if (!ext) return '·';
  return SHORT[ext] ?? ext.slice(0, 3).toUpperCase();
}

export function FileTypeBadge({ path }: { path: string }) {
  return (
    <span className="pf-badge" data-ext={extensionOf(baseName(path)) ?? undefined}>
      {fileBadgeText(path)}
    </span>
  );
}
