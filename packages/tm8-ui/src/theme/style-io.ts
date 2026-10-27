/**
 * STYLE FILES IN AND OUT (styles spec v8 §9.1 "Import…", §9.2 header
 * "Export"). Both directions are the contract's pure functions — `exportStyle`
 * and `importStyle`, which holds an imported file to the write-time rules
 * (`normalizeStyleDoc`), so an imported file is exactly as valid as a typed
 * one. This file only adds the browser's side: a file name, a download, a
 * file chooser.
 */
import { exportStyle, type StyleDoc } from '@tm8/contract';

/** A file name from a title: `Midnight (draft)` → `midnight-draft.tm8style.json`. */
export function styleFileName(title: string, format: 'css' | 'json'): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'style';
  return format === 'json' ? `${slug}.tm8style.json` : `${slug}.css`;
}

/** Save `doc` as a file through a transient object URL (no server round trip). */
export function downloadStyle(doc: StyleDoc, title: string, format: 'css' | 'json', only: 'set' | 'all'): void {
  const text = exportStyle(doc, { format, only });
  const blob = new Blob([text], { type: format === 'json' ? 'application/json' : 'text/css' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = styleFileName(title, format);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Open the OS file chooser for one style file and read it as text; null when cancelled. */
export function pickStyleFile(): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.css,application/json,text/css';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      file.text().then(
        (text) => resolve({ name: file.name, text }),
        () => resolve(null),
      );
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** A title from a file name: `midnight-draft.tm8style.json` → `midnight draft`. */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.tm8style\.json$|\.json$|\.css$/i, '').replace(/[-_]+/g, ' ').trim();
  return base || 'Imported style';
}
