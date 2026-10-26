/**
 * THE DEVICE COPY OF AN UNSAVED DOC DRAFT (New doc UX, 2026-10-06).
 *
 * Autosave writes to the server within a second of the last keystroke, but
 * "within a second" still loses the tail of a sentence to a reload, a closed
 * laptop or a dropped connection. Every edit is mirrored here, keyed by the
 * document, together with the version the edit was based on, and the copy is
 * dropped once the server holds the same text.
 *
 * The base version travels with the text so a restored draft is saved
 * against the version it was WRITTEN over — never against whatever the
 * document is now, which would be the silent overwrite `useDocSave` exists to
 * prevent. A restored draft over a moved document conflicts, and the banner
 * offers the usual two answers.
 *
 * Storage can be absent, full or refused (private windows, quota). Every call
 * here degrades to "no device copy" rather than throwing into an editor.
 */
import type { DocEdits } from './commands';

export interface LocalDocDraft {
  edits: DocEdits;
  baseVersion: number;
}

const PREFIX = 'tm8.docDraft.';

function storage(): Storage | null {
  try {
    const s = globalThis.localStorage;
    return s && typeof s.setItem === 'function' ? s : null;
  } catch {
    return null;
  }
}

export function readLocalDraft(id: string): LocalDocDraft | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(PREFIX + id);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalDocDraft>;
    if (typeof parsed.baseVersion !== 'number' || typeof parsed.edits !== 'object' || parsed.edits === null) return null;
    const edits: DocEdits = {};
    if (typeof parsed.edits.title === 'string') edits.title = parsed.edits.title;
    if (typeof parsed.edits.body === 'string') edits.body = parsed.edits.body;
    return Object.keys(edits).length > 0 ? { edits, baseVersion: parsed.baseVersion } : null;
  } catch {
    return null;
  }
}

export function writeLocalDraft(id: string, draft: LocalDocDraft): void {
  try {
    storage()?.setItem(PREFIX + id, JSON.stringify(draft));
  } catch {
    /* Quota or a refused origin: the server copy is the only copy. */
  }
}

export function clearLocalDraft(id: string): void {
  try {
    storage()?.removeItem(PREFIX + id);
  } catch {
    /* Nothing to clear is the same outcome. */
  }
}
